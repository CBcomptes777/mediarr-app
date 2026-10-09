import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerActions } from "./actions.js";
import { registerAjout, type Ecrire } from "./ajout.js";
import { registerAlertes, type SourceAlertes } from "./alertes.js";
import { registerDecouvrir } from "./decouvrir.js";
import { registerDemandes } from "./demandes.js";
import { ErreurService } from "./erreurs.js";
import { registerImages, type GetRaw } from "./images.js";
import { causeLisible, Journal, messageErreur, registerJournal } from "./journal.js";
import { ListesEnMemoire, registerLecture, type GetJson } from "./lecture.js";
import { creerEnvoiNtfy, configNtfy, purgerNtfy } from "./ntfy.js";
import { registerNotifications } from "./notifications.js";
import { registerPrefs, StockagePrefs } from "./prefs.js";
import { registerTorrents } from "./torrents.js";
import { Surveillant } from "./surveillant.js";
import { alertesProwlarr, registerProwlarr } from "./prowlarr.js";
import { registerStats } from "./stats.js";
import { configurerWebhooks, registerWebhooks, type Auto, type EtatAuto } from "./webhooks.js";
import { registerReleases } from "./releases.js";
import { QbitSession } from "./qbit.js";
import { authHeaders, loadServices, type Env, type ServiceDef, type ServiceId } from "./services.js";

export interface HealthEntry {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number | null;
  version?: string;
  error?: string;
  lien?: string;
}

export interface OptionsServeur {
  /** Récupération des affiches externes (remplaçable dans les tests : le réseau n'est pas disponible). */
  fetchExterne?: typeof fetch;
  /** Journal des échecs d'images (par défaut : la console). Ne reçoit jamais de clé. */
  journal?: (message: string) => void;
  /** Attentes (ms) entre les tentatives de configuration des webhooks (par défaut 3 s puis 10 s) ; réduites dans les tests. */
  attentesWebhooks?: number[];
  /** Remplace fetch pour parler à ntfy (tests). */
  fetchNtfy?: typeof fetch;
  /** Horloge du surveillant (tests). */
  maintenant?: () => number;
  /** Délai de la recherche de releases, en ms (tests : remplace le réglage de l'utilisateur). */
  delaiRechercheMs?: number;
}

export function buildServer(env: Env, options: OptionsServeur = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const services = loadServices(env);
  const byId = new Map(services.map((s) => [s.id, s]));

  // Préférences (fichier JSON), journal des échecs (sans clés) et caches à vider à la demande.
  const prefs = new StockagePrefs(env);
  const journal = Journal.depuis(env);
  const viders: Array<() => void> = [];
  /** Délai HTTP réglé dans Réglages → Avancé (15 s par défaut). */
  const delai = () => prefs.lire().reglages.delaiHttpMs;

  const qbit = env.QBIT_URL
    ? new QbitSession(
        env.QBIT_URL.trim().replace(/\/+$/, ""),
        env.QBIT_USER ?? "",
        env.QBIT_PASS ?? "",
      )
    : undefined;

  // Les requêtes sont relayées telles quelles (JSON ou formulaire) : on garde le corps brut.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  // Jeton d'accès optionnel : si ACCESS_TOKEN est défini, toute requête /api doit le présenter.
  const token = env.ACCESS_TOKEN?.trim();
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    // Les webhooks viennent de Radarr / Sonarr / Overseerr, qui n'ont ni le jeton de l'app ni notre en-tête :
    // ils s'authentifient avec leur propre secret (WEBHOOK_SECRET), vérifié dans la route.
    // Seules les trois routes de réception sont exemptées : /api/webhooks/configurer reste protégée.
    if (req.method === "POST" && /^\/api\/webhooks\/(radarr|sonarr|overseerr)(\?|$)/.test(req.url)) return;
    // Toute requête qui modifie quelque chose doit porter cet en-tête : un autre site web ne peut
    // pas l'ajouter sans autorisation du navigateur, ce qui bloque les requêtes envoyées à notre insu.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-requested-with"] !== "mediarr") {
      return reply.code(403).send({ error: "En-tête X-Requested-With manquant" });
    }
    if (!token) return;
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (given !== token) {
      return reply.code(401).send({ error: "Jeton d'accès manquant ou invalide" });
    }
  });

  /** Homarr est le seul service qu'on ouvre dans un nouvel onglet : on donne son adresse (HOMARR_OPEN_URL si elle diffère). */
  const lienDe = (s: ServiceDef) => (s.id === "homarr" ? { lien: env.HOMARR_OPEN_URL?.trim() || s.baseUrl } : {});

  async function checkOne(s: ServiceDef): Promise<HealthEntry> {
    const started = Date.now();
    try {
      let res: Response;
      if (s.id === "qbittorrent") {
        res = await qbit!.request(`${s.apiPrefix}${s.healthPath}`);
      } else {
        res = await fetch(`${s.baseUrl}${s.apiPrefix}${s.healthPath}`, {
          headers: authHeaders(s.id, env),
          signal: AbortSignal.timeout(4000),
        });
      }
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        journal.ajouter(s.id, `${s.apiPrefix}${s.healthPath}`, res.status, `HTTP ${res.status}`);
        return { id: s.id, label: s.label, ok: false, latencyMs, error: `HTTP ${res.status}`, ...lienDe(s) };
      }
      let version: string | undefined;
      const text = await res.text();
      if (s.id === "qbittorrent") {
        version = text.trim();
      } else if (s.version) {
        try {
          version = s.version(JSON.parse(text));
        } catch {
          /* version facultative */
        }
      }
      // qBittorrent répond déjà « v5.0.0 » : on retire le « v » pour que l'interface seule l'ajoute.
      version = version?.replace(/^v/i, "") || undefined;
      return { id: s.id, label: s.label, ok: true, latencyMs, version, ...lienDe(s) };
    } catch (e) {
      journal.ajouter(s.id, `${s.apiPrefix}${s.healthPath}`, 0, messageErreur(e));
      return {
        id: s.id,
        label: s.label,
        ok: false,
        latencyMs: null,
        error: journal.purger(e instanceof Error ? e.message : "Erreur inconnue"),
        ...lienDe(s),
      };
    }
  }

  app.get("/api/health", async () => {
    const results = await Promise.all(services.map(checkOne));
    return { services: results };
  });

  // Relais générique : /api/proxy/<service>/<chemin de l'API du service>
  app.all("/api/proxy/:service/*", async (req, reply) => {
    const { service, "*": rest } = req.params as { service: string; "*": string };
    const def = byId.get(service as ServiceDef["id"]);
    if (!def) return reply.code(404).send({ error: "Service inconnu ou non configuré" });
    if (rest.split("/").some((seg) => seg === ".." || seg === ".")) {
      return reply.code(400).send({ error: "Chemin invalide" });
    }

    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const path = `${def.apiPrefix}/${rest}${query}`;
    const method = req.method.toUpperCase();
    const raw = method === "GET" || method === "HEAD" ? undefined : (req.body as Buffer | undefined);
    const body = raw ? new Uint8Array(raw) : undefined;
    const contentType = req.headers["content-type"];
    const headers: Record<string, string> = { ...authHeaders(def.id, env) };
    if (contentType && body) headers["Content-Type"] = contentType;

    try {
      const upstream =
        def.id === "qbittorrent"
          ? await qbit!.request(path, { method, headers, body })
          : await fetch(`${def.baseUrl}${path}`, {
              method,
              headers,
              body,
              signal: AbortSignal.timeout(15000),
            });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const type = upstream.headers.get("content-type");
      if (type) reply.header("content-type", type);
      return reply.code(upstream.status).send(buf);
    } catch (e) {
      return reply
        .code(502)
        .send({ error: e instanceof Error ? e.message : "Service injoignable" });
    }
  });

  // Lecture JSON d'un service (avec sa clé ou sa session), pour les routes de lecture.
  const getRaw: GetRaw = async (id, path, opts = {}) => {
    const def = byId.get(id);
    if (!def) throw new Error("Service non configuré");
    let full = `${opts.racine ? "" : def.apiPrefix}${path}`;
    try {
      let res: Response;
      if (id === "qbittorrent") {
        res = await qbit!.request(full);
      } else {
        if (opts.cleEnQuery) {
          const cle = authHeaders(id, env)["X-Api-Key"];
          if (cle) full += `${full.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(cle)}`;
        }
        res = await fetch(`${def.baseUrl}${full}`, {
          headers: { ...authHeaders(id, env), ...(opts.accept ? { Accept: opts.accept } : {}) },
          signal: opts.signal
            ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? delai()), opts.signal])
            : AbortSignal.timeout(opts.timeoutMs ?? delai()),
        });
      }
      if (Journal.notable(res.status)) journal.ajouter(id, path, res.status, `HTTP ${res.status}`);
      return res;
    } catch (e) {
      journal.ajouter(id, path, 0, messageErreur(e));
      throw e;
    }
  };
  /** 200 premiers caractères d'une réponse, sur une ligne et sans aucun secret connu (jeton Plex, clés API…). */
  const apercu = (texte: string) => journal.purger(texte.replace(/\s+/g, " ").trim().slice(0, 200));
  const getJson: GetJson = async (id, path, opts) => {
    const label = byId.get(id)!.label;
    let res: Response;
    try {
      res = await getRaw(id, path, { timeoutMs: opts?.timeoutMs, signal: opts?.signal });
    } catch (e) {
      throw new ErreurService(`${label} : ${causeLisible(e)}`, "reseau");
    }
    const texte = await res.text().catch(() => "");
    if (!res.ok) {
      const refuse = res.status === 401 || res.status === 403;
      throw new ErreurService(`${label} : HTTP ${res.status}`, refuse ? "refuse" : "http", res.status, apercu(texte));
    }
    try {
      return JSON.parse(texte);
    } catch {
      // Typiquement du XML (Plex en renvoie par défaut) ou une page HTML d'un proxy.
      throw new ErreurService(`${label} : réponse illisible`, "illisible", res.status, apercu(texte));
    }
  };
  const configured = (id: ServiceId) => byId.has(id);
  const ecrire: Ecrire = async (id, methode, path, body, opts) => {
    const def = byId.get(id);
    if (!def) throw new Error("Service non configuré");
    try {
      const res = await fetch(`${def.baseUrl}${def.apiPrefix}${path}`, {
        method: methode,
        headers: { ...authHeaders(id, env), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? Math.max(delai(), 20000)),
      });
      if (Journal.notable(res.status)) journal.ajouter(id, path, res.status, `HTTP ${res.status}`);
      return res;
    } catch (e) {
      journal.ajouter(id, path, 0, messageErreur(e));
      throw e;
    }
  };
  const listes = new ListesEnMemoire();
  viders.push(() => listes.vider());
  registerLecture(app, getJson, configured, listes);
  const images = registerImages(app, getRaw, configured, {
    fetchExterne: options.fetchExterne,
    journal: options.journal,
    // Si le service ne sert pas son affiche, on demande son adresse distante à la fiche du média.
    secours: async (id, mediaId) => {
      const fiche = (await getJson(id, id === "radarr" ? `/movie/${mediaId}` : `/series/${mediaId}`)) as {
        images?: { coverType?: string; remoteUrl?: string }[];
      };
      return fiche.images?.find((i) => i.coverType?.toLowerCase() === "poster")?.remoteUrl ?? null;
    },
  });
  viders.push(() => images.vider());
  registerAjout(app, getJson, ecrire, configured, () => listes.vider());
  registerDemandes(app, getJson, ecrire, configured);
  registerDecouvrir(app, getJson, ecrire, configured, listes, (t) => journal.purger(t));
  // Bloc « Alertes » de l'accueil : chaque source apporte ses avertissements (le surveillant s'y ajoute plus tard).
  const prowlarr = registerProwlarr(app, getJson, ecrire, configured, (t) => journal.purger(t));
  // Notifications ntfy : sans NTFY_URL et NTFY_TOPIC valides, le surveillant ne fait rien (Réglages le dit, aucune erreur).
  const cfgNtfy = configNtfy(env);
  const surveillant = new Surveillant({
    getJson,
    configured,
    sante: async () => (await Promise.all(services.filter((s) => s.id !== "homarr").map(checkOne))).map((h) => ({ id: h.id, label: h.label, ok: h.ok })),
    causeConnue: prowlarr.causeConnue,
    causeParTest: prowlarr.causeParTest,
    envoyer: cfgNtfy ? creerEnvoiNtfy(cfgNtfy, options.fetchNtfy) : null,
    reglages: () => prefs.lire().notifications,
    maintenant: options.maintenant ?? (() => Date.now()),
    dossier: prefs.dossier,
    purger: (t) => (cfgNtfy ? purgerNtfy(journal.purger(t), cfgNtfy) : journal.purger(t)),
  });
  registerNotifications(app, surveillant);
  const sourcesAlertes: SourceAlertes[] = [() => alertesProwlarr(getJson, configured), () => surveillant.alertes()];
  registerAlertes(app, sourcesAlertes);
  registerPrefs(app, prefs, Boolean(token));
  const stats = registerStats(app, getJson, configured);
  viders.push(() => stats.vider());

  // Webhooks entrants (reçus et mémorisés, sans notification pour l'instant).
  const secretWebhook = env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.trim().length >= 12 ? env.WEBHOOK_SECRET.trim() : undefined;
  const baseMediarr = env.MEDIARR_URL?.trim();
  let enCours = false;
  const prerequis = () =>
    !secretWebhook ? "WEBHOOK_SECRET absent ou trop court (12 caractères au moins)"
    : !baseMediarr ? "MEDIARR_URL absent (adresse de Mediarr vue par Radarr, Sonarr et Overseerr)"
    : null;
  const auto: Auto = {
    etat: {} as EtatAuto,
    prerequis,
    raison: () => prerequis() ?? (!prefs.lire().reglages.webhooksAuto ? "désactivée dans les Réglages" : null),
    enCours: () => enCours,
    lancer: () => {
      if (enCours || prerequis() !== null) return false;
      enCours = true;
      configurerWebhooks({
        env, secret: secretWebhook!, baseUrl: baseMediarr!, configured, getJson, ecrire, etat: auto.etat,
        attentes: options.attentesWebhooks,
      })
        .catch(() => {})
        .finally(() => (enCours = false));
      return true;
    },
  };
  registerWebhooks(app, secretWebhook, auto);
  // Au lancement, APRÈS que le serveur écoute : Radarr et Sonarr testent l'adresse dès la création de la notification
  // et recevraient « connexion refusée » si on le faisait avant. N'attend pas la fin : le démarrage n'est pas bloqué.
  app.addHook("onListen", async () => {
    if (auto.raison() === null) auto.lancer();
    surveillant.demarrer();
  });
  app.addHook("onClose", async () => surveillant.arreter());
  registerJournal(app, journal);
  // « Vider le cache » (Réglages → Avancé) : listes, images, calculs.
  app.post("/api/cache/vider", async () => {
    for (const f of viders) f();
    return { ok: true };
  });
  registerReleases(app, getJson, ecrire, configured, (x) => journal.purger(x), undefined, {
    delaiRechercheMs: () => options.delaiRechercheMs ?? prefs.lire().reglages.delaiRechercheMs,
    log: (m) => (options.journal ?? console.log)(m),
  });
  registerActions(
    app,
    (path, params) =>
      qbit!.request(`/api/v2${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      }),
    configured,
  );

  // qBittorrent : état par différences, ajout, actions, détails, vitesses (voir torrents.ts).
  registerTorrents(app, {
    requete: (chemin, init) => qbit!.request(chemin, init),
    configured,
    racinesConnues: async () => {
      const chemins: string[] = [];
      for (const id of ["radarr", "sonarr"] as const) {
        if (!configured(id)) continue;
        try {
          for (const r of (await getJson(id, "/rootfolder")) as { path?: string }[]) if (typeof r.path === "string") chemins.push(r.path);
        } catch {
          /* service éteint : on garde les autres racines */
        }
      }
      return chemins;
    },
    racinesReglees: () => prefs.lire().reglages.racinesQbit,
    suppressionMasquee: () => prefs.lire().reglages.masquerSuppression,
    log: (m) => (options.journal ?? console.log)(m),
  });

  // L'app web (fichiers statiques), si elle a été construite.
  const publicDir = resolve(env.PUBLIC_DIR ?? "./public");
  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Introuvable" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

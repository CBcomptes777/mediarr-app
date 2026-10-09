// Routes d'entrée des webhooks Radarr / Sonarr / Overseerr. Pour l'instant on ne fait que RECEVOIR et mémoriser
// (aucune notification envoyée) : l'étape suivante du projet branchera ntfy dessus.
//
// Sécurité : les services n'ont pas le jeton de l'app, ils ont un secret dédié (WEBHOOK_SECRET). Sans lui, les
// routes répondent 503. Le secret se présente en en-tête (Authorization: Bearer … ou X-Webhook-Secret) ;
// à défaut, en paramètre ?secret= (pour les services qui ne savent pas envoyer d'en-tête).
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { lireJson, type Ecrire } from "./ajout.js";
import { causeLisible as causeReseau } from "./journal.js";
import type { GetJson } from "./lecture.js";
import type { Env, ServiceId } from "./services.js";

type Obj = Record<string, any>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const SERVICES_WEBHOOK = ["radarr", "sonarr", "overseerr"] as const;
type ServiceWebhook = (typeof SERVICES_WEBHOOK)[number];

export interface EvenementRecu {
  date: string;
  service: ServiceWebhook;
  evenement: string;
  titre: string;
}

/** Comparaison en temps constant : on ne révèle pas le secret par le temps de réponse. */
export function memeSecret(donne: string, attendu: string): boolean {
  const a = Buffer.from(donne);
  const b = Buffer.from(attendu);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Type d'évènement et titre lisibles, d'après la forme propre à chaque service. */
export function resumerEvenement(service: ServiceWebhook, c: Obj): { evenement: string; titre: string } {
  if (service === "radarr") {
    return { evenement: str(c.eventType) || "Inconnu", titre: str(c.movie?.title) || str(c.remoteMovie?.title) };
  }
  if (service === "sonarr") {
    const ep = Array.isArray(c.episodes) && c.episodes[0] ? ` S${String(c.episodes[0].seasonNumber ?? 0).padStart(2, "0")}E${String(c.episodes[0].episodeNumber ?? 0).padStart(2, "0")}` : "";
    return { evenement: str(c.eventType) || "Inconnu", titre: str(c.series?.title) ? `${str(c.series.title)}${ep}` : "" };
  }
  return { evenement: str(c.notification_type) || str(c.event) || "Inconnu", titre: str(c.subject) };
}

export interface EtatAuto {
  [service: string]: string;
}

/** Ce que les routes ont besoin de savoir de la configuration automatique. */
export interface Auto {
  etat: EtatAuto;
  /** Pourquoi la configuration AUTOMATIQUE ne tourne pas au lancement (null si elle tourne). */
  raison: () => string | null;
  /** Pourquoi on ne peut pas configurer du tout (secret ou adresse manquants) ; null si c'est possible. */
  prerequis: () => string | null;
  /** Lance la configuration en arrière-plan ; false si une est déjà en cours. */
  lancer: () => boolean;
  enCours: () => boolean;
}

export function registerWebhooks(app: FastifyInstance, secret: string | undefined, auto: Auto) {
  const recus: EvenementRecu[] = [];

  app.post("/api/webhooks/:service", { bodyLimit: 262144 }, async (req, reply) => {
    const { service } = req.params as { service: string };
    if (!(SERVICES_WEBHOOK as readonly string[]).includes(service)) return reply.code(404).send({ error: "Service inconnu" });
    if (!secret) return reply.code(503).send({ error: "Webhooks non configurés (variable WEBHOOK_SECRET)" });
    const entete = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (req.headers["x-webhook-secret"] as string | undefined);
    const donne = entete ?? (req.query as { secret?: string }).secret ?? "";
    if (!memeSecret(String(donne), secret)) return reply.code(401).send({ error: "Secret invalide" });
    const corps = lireJson(req.body);
    if (!corps) return reply.code(400).send({ error: "Corps JSON attendu" });
    const { evenement, titre } = resumerEvenement(service as ServiceWebhook, corps);
    recus.unshift({ date: new Date().toISOString(), service: service as ServiceWebhook, evenement: evenement.slice(0, 60), titre: titre.slice(0, 200) });
    if (recus.length > 100) recus.length = 100;
    return { ok: true };
  });

  // Réglages → Webhooks : le secret n'y figure jamais.
  app.get("/api/webhooks/etat", async () => ({
    actif: Boolean(secret),
    automatique: auto.etat,
    enCours: auto.enCours(),
    /** Pourquoi la configuration automatique n'a pas tourné au lancement (null si elle a tourné). */
    raison: auto.raison(),
    evenements: recus.slice(0, 30),
  }));

  // Bouton « Reconfigurer maintenant » : protégé par le jeton de l'app et par X-Requested-With (hook global),
  // car seules les trois routes de réception sont exemptées. Répond tout de suite ; l'état se lit sur /etat.
  app.post("/api/webhooks/configurer", async (_req, reply) => {
    const manque = auto.prerequis();
    if (manque) return reply.code(409).send({ error: `Impossible de configurer : ${manque}.` });
    if (!auto.lancer()) return reply.code(409).send({ error: "Une configuration est déjà en cours." });
    return reply.code(202).send({ ok: true, enCours: true });
  });
}

// ---------- configuration automatique au lancement ----------

/** Corps de la notification « Webhook » à créer dans Radarr / Sonarr, à partir du modèle fourni par le service. */
export function notificationWebhook(modele: Obj, url: string, secret: string): Obj {
  const champs = (Array.isArray(modele.fields) ? modele.fields : []).map((f: Obj) => {
    if (f.name === "url") return { ...f, value: url };
    if (f.name === "method") return { ...f, value: 1 }; // POST
    if (f.name === "headers") return { ...f, value: [{ key: "Authorization", value: `Bearer ${secret}` }] };
    return f;
  });
  const corps: Obj = { ...modele, name: "Mediarr", fields: champs };
  for (const k of ["onGrab", "onDownload", "onUpgrade", "onHealthIssue", "onApplicationUpdate", "onManualInteractionRequired"]) {
    if (k in modele) corps[k] = true;
  }
  return corps;
}

/** Traduit les causes fréquentes renvoyées par Radarr / Sonarr / Overseerr (souvent en anglais). */
function traduireCause(brut: string): string {
  if (/connection refused/i.test(brut)) return "connexion refusée";
  if (/timed? ?out|timeout/i.test(brut)) return "délai dépassé";
  if (/name or service not known|no such host|could not be resolved|not known/i.test(brut)) return "adresse introuvable";
  if (/unauthorized|401/i.test(brut)) return "accès refusé (clé API ?)";
  return "";
}

/**
 * Cause lisible d'une réponse en erreur : le message du service (Radarr/Sonarr renvoient souvent
 * `[{ "errorMessage": "Unable to send test message: Connection refused (ip:port)" }]`), pas seulement le code HTTP.
 */
export async function causeReponse(res: Response, secret: string): Promise<string> {
  const texte = (await res.text().catch(() => "")).trim();
  let brut = "";
  try {
    const j = JSON.parse(texte);
    const liste = Array.isArray(j) ? j : [j];
    brut = liste
      .map((x: Obj) => str(x?.errorMessage) || str(x?.message) || str(x?.error) || str(x?.description))
      .filter(Boolean)
      .join(" ; ");
  } catch {
    brut = texte.startsWith("<") ? "" : texte;
  }
  brut = brut.split(secret).join("***").slice(0, 250);
  const fr = traduireCause(brut);
  const base = `HTTP ${res.status}`;
  if (!brut) return base;
  return fr ? `${fr} — ${brut} (${base})` : `${brut} (${base})`;
}

export interface DepsConfig {
  env: Env;
  secret: string;
  baseUrl: string;
  configured: (id: ServiceId) => boolean;
  getJson: GetJson;
  ecrire: Ecrire;
  etat: EtatAuto;
  /** Attentes entre deux tentatives, en ms (par défaut 3 s puis 10 s : 3 tentatives au total). */
  attentes?: number[];
}

/** Configure UN service ; renvoie son état (« configuré », « mis à jour », « déjà configuré ») ou lève l'erreur avec sa cause. */
async function configurerUn(id: ServiceWebhook, d: DepsConfig): Promise<string> {
  const { secret, getJson, ecrire } = d;
  const url = `${d.baseUrl.replace(/\/+$/, "")}/api/webhooks/${id}`;
  const verifier = async (res: Response, etatOk: string) => {
    if (!res.ok) throw new Error(await causeReponse(res, secret));
    return etatOk;
  };

  if (id === "overseerr") {
    const actuel = (await getJson("overseerr", "/settings/notifications/webhook")) as Obj;
    if (actuel.enabled === true && str(actuel.options?.webhookUrl) === url) return "déjà configuré";
    const res = await ecrire("overseerr", "POST", "/settings/notifications/webhook", {
      enabled: true,
      embedPoster: false,
      // Demande en attente, approuvée, disponible, en échec, refusée, approuvée automatiquement.
      types: 2 + 4 + 8 + 16 + 64 + 128,
      options: {
        webhookUrl: url,
        authHeader: `Bearer ${secret}`,
        jsonPayload: JSON.stringify({
          notification_type: "{{notification_type}}", event: "{{event}}", subject: "{{subject}}", message: "{{message}}",
          media: { media_type: "{{media_type}}", tmdbId: "{{media_tmdbid}}" },
          request: { request_id: "{{request_id}}", requestedBy_username: "{{requestedBy_username}}" },
        }),
      },
    });
    return verifier(res, "configuré");
  }

  const liste = (await getJson(id, "/notification")) as Obj[];
  const existant = liste.find((n) => n.name === "Mediarr");
  const urlExistante = (Array.isArray(existant?.fields) ? existant!.fields : []).find((f: Obj) => f.name === "url")?.value;
  if (existant && urlExistante === url) return "déjà configuré";
  if (existant) {
    // L'adresse a changé : on met à jour la notification existante plutôt que d'en créer une seconde.
    return verifier(await ecrire(id, "PUT", `/notification/${existant.id}`, notificationWebhook(existant, url, secret)), "mis à jour");
  }
  const schemas = (await getJson(id, "/notification/schema")) as Obj[];
  const modele = schemas.find((s) => s.implementation === "Webhook");
  if (!modele) throw new Error("modèle Webhook introuvable chez le service");
  // Radarr / Sonarr TESTENT l'adresse dès la création : Mediarr doit déjà écouter (d'où les tentatives ci-dessous).
  return verifier(await ecrire(id, "POST", "/notification", notificationWebhook(modele, url, secret)), "configuré");
}

const pause = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Un service à la fois, indépendamment des autres : jusqu'à 3 tentatives (attentes 3 s puis 10 s) avant « échec ». */
async function configurerAvecTentatives(id: ServiceWebhook, d: DepsConfig): Promise<void> {
  const attentes = d.attentes ?? [3000, 10000];
  const total = attentes.length + 1;
  for (let i = 0; ; i++) {
    try {
      d.etat[id] = await configurerUn(id, d);
      return;
    } catch (e) {
      // Une erreur réseau (« fetch failed ») porte sa vraie cause à part ; les autres messages sont déjà lisibles.
      // Le préfixe « Radarr : » des messages internes est inutile : le service est déjà nommé à côté.
      const lisible = causeReseau(e).replace(/^(Radarr|Sonarr|Overseerr) : /, "").split(d.secret).join("***");
      if (i >= attentes.length) {
        d.etat[id] = `échec : ${lisible}`;
        return;
      }
      d.etat[id] = `nouvelle tentative ${i + 2}/${total} dans ${Math.round(attentes[i] / 1000)} s (${lisible})`;
      await pause(attentes[i]);
    }
  }
}

/** Configure tous les services configurés, chacun de son côté (un qui échoue ne retarde pas les autres). */
export async function configurerWebhooks(d: DepsConfig): Promise<void> {
  const concernes = SERVICES_WEBHOOK.filter((id) => d.configured(id));
  for (const id of concernes) d.etat[id] = "en cours";
  await Promise.all(concernes.map((id) => configurerAvecTentatives(id, d)));
}

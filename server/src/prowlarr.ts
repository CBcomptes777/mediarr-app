// Prowlarr : indexeurs (état, cause d'un échec, tests), statistiques sur 7 jours, recherche directe, alertes de santé.
// Lecture seule, sauf deux actions explicites : « Tester » un indexeur et « Tout tester » (ce sont des tests, rien n'est modifié ni supprimé).
// La clé API de Prowlarr reste ici : les adresses de téléchargement des résultats de recherche la contiennent, on ne les renvoie jamais.
import type { FastifyInstance } from "fastify";
import { lireJson, type Ecrire } from "./ajout.js";
import type { GetJson } from "./lecture.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface AlerteApp {
  /** Qui la signale : « Prowlarr », « Disque »… */
  source: string;
  niveau: "avertissement" | "erreur" | "critique";
  message: string;
}

/** Texte de cause lisible (français) pour un message d'erreur d'indexeur, le plus souvent en anglais. */
export function causeIndexeur(brut: string): string {
  const t = brut.replace(/\s+/g, " ").trim();
  if (/\b401\b|unauthori[sz]ed/i.test(t)) return "401 Unauthorized : clé API ou identifiants refusés par l'indexeur";
  if (/\b403\b|forbidden/i.test(t)) return "403 Forbidden : accès interdit (protection anti-robot ou compte bloqué ?)";
  if (/cloudflare|captcha|flaresolverr/i.test(t)) return "Protection anti-robot (Cloudflare) : un proxy FlareSolverr est peut-être nécessaire";
  if (/\b429\b|too many requests|rate.?limit/i.test(t)) return "429 : trop de requêtes, l'indexeur limite le débit";
  if (/timed? ?out|timeout|task was canceled/i.test(t)) return "Délai dépassé : l'indexeur ne répond pas";
  if (/unable to connect|connection refused|name or service not known|no such host|could not be resolved|dns/i.test(t)) return "Connexion impossible à l'indexeur";
  if (/\b5\d\d\b|server error|bad gateway|service unavailable/i.test(t)) return "Erreur côté indexeur (HTTP 5xx)";
  return t ? `Erreur : ${t.slice(0, 200)}` : "Échec sans détail";
}

/**
 * Langues annoncées par le NOM d'une release (Prowlarr ne les donne pas). Heuristique : les étiquettes courantes des
 * indexeurs francophones et anglophones. « MULTI » veut dire plusieurs langues sans dire lesquelles.
 */
export function languesDepuisTitre(titre: string): string[] {
  const t = ` ${titre.replace(/[._\-\[\]()]+/g, " ")} `;
  const trouvees: string[] = [];
  const motifs: [RegExp, string][] = [
    [/\b(truefrench|vff|vfq|vf2|vfi|french|fr)\b/i, "Français"],
    [/\b(vostfr|subfrench|stfr)\b/i, "Français (sous-titres)"],
    [/\b(multi|multi\s?vf\w*)\b/i, "Multi"],
    [/\b(english|vo|vost|eng)\b/i, "Anglais"],
    [/\b(german|ger|deutsch)\b/i, "Allemand"],
    [/\b(spanish|castellano|esp|latino)\b/i, "Espagnol"],
    [/\b(italian|ita)\b/i, "Italien"],
    [/\b(japanese|jpn)\b/i, "Japonais"],
    [/\b(korean|kor)\b/i, "Coréen"],
  ];
  for (const [motif, nom] of motifs) if (motif.test(t)) trouvees.push(nom);
  return trouvees;
}

/** Résolution annoncée par le nom (2160p, 1080p, 720p, 480p ; « 4K » = 2160). null si absente. */
export function resolutionDepuisTitre(titre: string): number | null {
  const m = /\b(2160|1080|720|576|480)[pi]\b/i.exec(titre);
  if (m) return Number(m[1]);
  return /\b(4k|uhd)\b/i.test(titre) ? 2160 : null;
}

/** Messages d'avertissement de Prowlarr (/health) en français quand on les connaît. */
function messageSante(m: string): string {
  let r = m.replace(/^Indexers unavailable due to failures for more than 6 hours:/i, "Indexeurs indisponibles depuis plus de 6 heures :");
  r = r.replace(/^Indexers unavailable due to failures:/i, "Indexeurs indisponibles à cause d'échecs :");
  r = r.replace(/^All indexers are unavailable due to failures/i, "Tous les indexeurs sont indisponibles à cause d'échecs");
  r = r.replace(/^No indexers available with (.+) enabled/i, "Aucun indexeur disponible avec $1 activé");
  return r === m ? `Prowlarr : ${m}` : r;
}

/** Alertes issues de la santé de Prowlarr ; liste vide si Prowlarr n'est pas configuré. */
export async function alertesProwlarr(getJson: GetJson, configured: (id: ServiceId) => boolean): Promise<AlerteApp[]> {
  if (!configured("prowlarr")) return [];
  const sante = (await getJson("prowlarr", "/health")) as Obj[];
  return (Array.isArray(sante) ? sante : [])
    .filter((h) => ["warning", "error"].includes(str(h.type).toLowerCase()))
    .map((h) => ({
      source: "Prowlarr",
      niveau: str(h.type).toLowerCase() === "error" ? ("erreur" as const) : ("avertissement" as const),
      message: messageSante(str(h.message)),
    }));
}

export interface ResultatTest {
  date: string;
  ok: boolean;
  /** Cause en français (null si le test réussit). */
  cause: string | null;
}

export function registerProwlarr(
  app: FastifyInstance,
  getJson: GetJson,
  ecrire: Ecrire,
  configured: (id: ServiceId) => boolean,
  /** Retire tous les secrets connus d'un texte (messages d'erreur renvoyés par les indexeurs). */
  purger: (texte: string) => string,
  maintenant: () => number = () => Date.now(),
) {
  const absent = (reply: { code: (n: number) => { send: (o: unknown) => unknown } }) =>
    reply.code(404).send({ error: "Prowlarr n'est pas configuré" });

  /** Dernier test de chaque indexeur (en mémoire) : c'est lui qui donne la vraie cause d'un échec. */
  const tests = new Map<number, ResultatTest>();
  const enregistrerTest = (id: number, ok: boolean, brut: string) => {
    const r = { date: new Date(maintenant()).toISOString(), ok, cause: ok ? null : causeIndexeur(purger(brut)) };
    tests.set(id, r);
    return r;
  };

  app.get("/api/indexeurs", async (_req, reply) => {
    if (!configured("prowlarr")) return absent(reply);
    const [liste, statuts, sante] = await Promise.allSettled([
      getJson("prowlarr", "/indexer"),
      getJson("prowlarr", "/indexerstatus"),
      getJson("prowlarr", "/health"),
    ]);
    if (liste.status === "rejected") {
      return reply.code(502).send({ error: liste.reason instanceof Error ? liste.reason.message : "Prowlarr injoignable" });
    }
    const parId = new Map<number, Obj>(((statuts.status === "fulfilled" ? statuts.value : []) as Obj[]).map((s) => [num(s.indexerId), s]));
    const t = maintenant();

    const items = (liste.value as Obj[])
      .map((i) => {
        const id = num(i.id);
        const st = parId.get(id);
        const actif = i.enable === true;
        const jusqua = str(st?.disabledTill);
        // Prowlarr garde une ligne de statut tant qu'un indexeur échoue, et la retire quand il refonctionne.
        const enEchec = actif && st !== undefined && (Boolean(str(st.mostRecentFailure)) || Boolean(jusqua));
        const test = tests.get(id) ?? null;
        let cause: string | null = null;
        let causeSource: "test" | "prowlarr" | null = null;
        if (enEchec) {
          if (test && !test.ok) {
            cause = test.cause;
            causeSource = "test";
          } else {
            const date = str(st?.mostRecentFailure) || str(st?.initialFailure);
            cause = `Prowlarr a mis cet indexeur en échec${date ? ` (dernier échec le ${date.slice(0, 10)})` : ""}. Appuie sur « Tester » pour connaître la cause exacte.`;
            causeSource = "prowlarr";
          }
        }
        return {
          id,
          nom: str(i.name),
          protocole: str(i.protocol).toLowerCase() === "usenet" ? ("usenet" as const) : ("torrent" as const),
          priorite: num(i.priority),
          actif,
          statut: !actif ? ("desactive" as const) : enEchec ? ("echec" as const) : ("actif" as const),
          dernierEchec: str(st?.mostRecentFailure) || null,
          premierEchec: str(st?.initialFailure) || null,
          reessaiApres: jusqua && new Date(jusqua).getTime() > t ? jusqua : null,
          cause,
          causeSource,
          test,
        };
      })
      .sort((a, b) => {
        const ordre = { echec: 0, actif: 1, desactive: 2 };
        return ordre[a.statut] - ordre[b.statut] || a.nom.localeCompare(b.nom, "fr");
      });

    const alertes =
      sante.status === "fulfilled"
        ? (sante.value as Obj[])
            .filter((h) => ["warning", "error"].includes(str(h.type).toLowerCase()))
            .map((h) => ({ niveau: str(h.type).toLowerCase() === "error" ? "erreur" : "avertissement", message: messageSante(str(h.message)) }))
        : [];
    return { items, alertes };
  });

  // « Tester » : Prowlarr veut la fiche complète de l'indexeur dans le corps de la requête de test.
  // Sert à la route ci-dessous ET au surveillant (un seul test, au moment d'annoncer qu'un indexeur est en échec).
  async function lancerTest(id: number): Promise<{ resultat: ResultatTest } | { http: number; erreur: string }> {
    let fiche: unknown;
    try {
      fiche = await getJson("prowlarr", `/indexer/${id}`);
    } catch (e) {
      const introuvable = e instanceof Error && /HTTP 404/.test(e.message);
      return { http: introuvable ? 404 : 502, erreur: introuvable ? "Cet indexeur n'existe plus" : e instanceof Error ? e.message : "Prowlarr injoignable" };
    }
    try {
      const res = await ecrire("prowlarr", "POST", "/indexer/test", fiche, { timeoutMs: 90_000 });
      if (res.ok) return { resultat: enregistrerTest(id, true, "") };
      return { resultat: enregistrerTest(id, false, await messagesValidation(res)) };
    } catch (e) {
      const brut = e instanceof Error ? e.message : "erreur";
      return { resultat: enregistrerTest(id, false, /abort|timeout/i.test(brut) ? "timed out" : brut) };
    }
  }

  app.post("/api/indexeurs/:id/tester", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^\d{1,9}$/.test(id)) return reply.code(400).send({ error: "Indexeur invalide" });
    if (!configured("prowlarr")) return absent(reply);
    const r = await lancerTest(Number(id));
    return "resultat" in r ? r.resultat : reply.code(r.http).send({ error: r.erreur });
  });

  let testToutEnCours = false;
  app.post("/api/indexeurs/tester-tout", async (_req, reply) => {
    if (!configured("prowlarr")) return absent(reply);
    if (testToutEnCours) return reply.code(409).send({ error: "Un test de tous les indexeurs est déjà en cours." });
    testToutEnCours = true;
    try {
      const [res, liste] = await Promise.all([
        ecrire("prowlarr", "POST", "/indexer/testall", undefined, { timeoutMs: 180_000 }),
        getJson("prowlarr", "/indexer").catch(() => [] as unknown),
      ]);
      if (!res.ok) return reply.code(502).send({ error: `Prowlarr a refusé le test (HTTP ${res.status})` });
      const noms = new Map<number, string>((liste as Obj[]).map((i) => [num(i.id), str(i.name)]));
      const resultats = ((await res.json().catch(() => [])) as Obj[]).map((r) => {
        const echecs = (Array.isArray(r.validationFailures) ? r.validationFailures : []).map((f: Obj) => str(f.errorMessage)).join(" ; ");
        const ok = r.isValid === true;
        return { id: num(r.id), nom: noms.get(num(r.id)) ?? `Indexeur ${num(r.id)}`, ...enregistrerTest(num(r.id), ok, echecs) };
      });
      return { items: resultats, ok: resultats.filter((r) => r.ok).length, echecs: resultats.filter((r) => !r.ok).length };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Prowlarr injoignable" });
    } finally {
      testToutEnCours = false;
    }
  });

  // Statistiques sur 7 jours.
  app.get("/api/indexeurs/stats", async (_req, reply) => {
    if (!configured("prowlarr")) return absent(reply);
    const fin = new Date(maintenant());
    const debut = new Date(fin.getTime() - 7 * 86_400_000);
    try {
      const r = (await getJson(
        "prowlarr",
        `/indexerstats?startDate=${encodeURIComponent(debut.toISOString())}&endDate=${encodeURIComponent(fin.toISOString())}`,
      )) as Obj;
      const items = ((r.indexers ?? []) as Obj[])
        .map((i) => ({
          id: num(i.indexerId),
          nom: str(i.indexerName),
          requetes: num(i.numberOfQueries) + num(i.numberOfRssQueries) + num(i.numberOfAuthQueries),
          echecs: num(i.numberOfFailedQueries) + num(i.numberOfFailedRssQueries) + num(i.numberOfFailedAuthQueries),
          grabs: num(i.numberOfGrabs),
          tempsMoyenMs: num(i.averageResponseTime) || null,
        }))
        .sort((a, b) => b.requetes - a.requetes || a.nom.localeCompare(b.nom, "fr"));
      return { jours: 7, debut: debut.toISOString(), fin: fin.toISOString(), items };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Prowlarr injoignable" });
    }
  });

  // Recherche directe : lecture seule, AUCUN lien de téléchargement renvoyé (il contient la clé de Prowlarr).
  app.get("/api/indexeurs/recherche", async (req, reply) => {
    if (!configured("prowlarr")) return absent(reply);
    const q = ((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2 || q.length > 100) return reply.code(400).send({ error: "Saisis entre 2 et 100 caractères" });
    try {
      const brut = (await getJson("prowlarr", `/search?query=${encodeURIComponent(q)}&type=search&limit=100&offset=0`, { timeoutMs: 90_000 })) as Obj[];
      const items = (Array.isArray(brut) ? brut : []).slice(0, 100).map((r) => {
        const torrent = str(r.protocol).toLowerCase() === "torrent";
        // Le guid sert à envoyer le résultat au client de téléchargement. S'il contenait un secret, il ne sortirait pas.
        const guid = str(r.guid);
        const guidSur = guid.length > 0 && guid.length <= 500 && purger(guid) === guid;
        const titreRelease = str(r.title);
        return {
          guid: guidSur ? guid : null,
          indexerId: guidSur ? num(r.indexerId) : null,
          langues: languesDepuisTitre(titreRelease),
          resolution: resolutionDepuisTitre(titreRelease),
          titre: titreRelease,
          indexeur: str(r.indexer),
          protocole: torrent ? ("torrent" as const) : ("usenet" as const),
          tailleOctets: num(r.size),
          seeders: torrent && typeof r.seeders === "number" ? r.seeders : null,
          leechers: torrent && typeof r.leechers === "number" ? r.leechers : null,
          ageMinutes: num(r.ageMinutes) || num(r.ageHours) * 60 || num(r.age) * 1440,
          categorie: str(Array.isArray(r.categories) ? r.categories[0]?.name : "") || null,
        };
      });
      return { items };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Recherche impossible" });
    }
  });

  // Envoi d'un résultat de recherche au client de téléchargement configuré DANS PROWLARR (POST /search : guid + indexeur).
  // C'est la seule écriture de cet écran en dehors des tests ; chaque envoi est confirmé par l'utilisateur côté app.
  const envoyees = new Map<string, number>();
  app.post("/api/indexeurs/envoyer", async (req, reply) => {
    if (!configured("prowlarr")) return absent(reply);
    const b = lireJson(req.body);
    if (!b || typeof b.guid !== "string" || b.guid.length === 0 || b.guid.length > 500 || !Number.isInteger(b.indexerId) || (b.indexerId as number) < 0) {
      return reply.code(400).send({ error: "Demande invalide" });
    }
    const t = maintenant();
    for (const [k, quand] of envoyees) if (t - quand > 15 * 60_000) envoyees.delete(k);
    const cle = `${b.indexerId}|${b.guid}`;
    if (envoyees.has(cle)) return reply.code(409).send({ error: "Ce résultat a déjà été envoyé il y a quelques minutes." });
    try {
      const res = await ecrire("prowlarr", "POST", "/search", { guid: b.guid, indexerId: b.indexerId }, { timeoutMs: 60_000 });
      if (!res.ok) {
        const cause = purger(await messagesValidation(res)).replace(/\s+/g, " ").slice(0, 200);
        return reply.code(502).send({ error: `Prowlarr a refusé l'envoi : ${cause}` });
      }
      envoyees.set(cle, t);
      // Client(s) de téléchargement connus de Prowlarr, pour dire où c'est parti (facultatif).
      let client: string | null = null;
      try {
        const clients = ((await getJson("prowlarr", "/downloadclient")) as Obj[]).filter((c) => c.enable !== false);
        client = clients.length === 1 ? str(clients[0].name) || null : null;
      } catch {
        /* nom inconnu */
      }
      return { ok: true, client };
    } catch (e) {
      return reply.code(502).send({ error: purger(e instanceof Error ? e.message : "Prowlarr injoignable") });
    }
  });

  return {
    /** Lance un test et renvoie la cause en français (null si le test réussit ou ne peut pas avoir lieu). */
    async causeParTest(id: number): Promise<string | null> {
      const r = await lancerTest(id);
      return "resultat" in r ? r.resultat.cause : null;
    },
    /** Dernière cause connue (test précédent), sans rien demander à Prowlarr. */
    causeConnue: (id: number): string | null => tests.get(id)?.cause ?? null,
  };
}

/** Messages d'une réponse de validation de Prowlarr : `[{ propertyName, errorMessage }]`. */
async function messagesValidation(res: Response): Promise<string> {
  const texte = (await res.text().catch(() => "")).trim();
  try {
    const j = JSON.parse(texte);
    return (Array.isArray(j) ? j : [j]).map((x: Obj) => str(x?.errorMessage) || str(x?.message)).filter(Boolean).join(" ; ") || `HTTP ${res.status}`;
  } catch {
    return texte.startsWith("<") ? `HTTP ${res.status}` : texte || `HTTP ${res.status}`;
  }
}

// Recherche manuelle : lister les releases proposées par les indexeurs pour un film ou un épisode,
// puis en envoyer une au client de téléchargement. Radarr et Sonarr gardent les résultats en
// mémoire un moment : on redonne seulement l'identifiant (guid) et l'indexeur.
import type { FastifyInstance } from "fastify";
import { lireJson, type Ecrire } from "./ajout.js";
import { noteMedia, type Note } from "./lecture.js";
import type { GetJson } from "./lecture.js";
import { ErreurService } from "./erreurs.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
type Cible = "film" | "episode" | "saison";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SERVICE: Record<Cible, "radarr" | "sonarr"> = { film: "radarr", episode: "sonarr", saison: "sonarr" };
const NOM_SERVICE = { radarr: "Radarr", sonarr: "Sonarr" } as const;
/** Une release envoyée ne l'est qu'une fois toutes les 15 minutes (Radarr/Sonarr ne préviennent pas toujours d'un doublon). */
const DELAI_DOUBLON_MS = 15 * 60_000;
/** Les indexeurs peuvent mettre une minute à répondre. */
const DELAI_RECHERCHE_MS = 90_000;

// ---------- qualité ----------

const SOURCES: Record<string, number> = {
  unknown: 0, cam: 1, telesync: 2, telecine: 2, workprint: 2, dvd: 3, tv: 4, television: 4, televisionraw: 4,
  web: 5, webdl: 5, webrip: 5, bluray: 6, blurayraw: 7,
};

/**
 * Note de qualité comparable entre deux fichiers : résolution d'abord, puis source
 * (CAM < DVD < TV < WEB < Blu-ray < Remux). Sert à repérer les mises à niveau.
 */
export function rangQualite(q: Obj | undefined | null): number {
  if (!q) return 0;
  const nom = str(q.name);
  const resolution = num(q.resolution) || Number(/(\d{3,4})p/i.exec(nom)?.[1] ?? 0);
  let source = SOURCES[str(q.source).toLowerCase().replace(/[^a-z]/g, "")];
  if (source === undefined) {
    source = /cam/i.test(nom) ? 1 : /telesync|hdts/i.test(nom) ? 2 : /dvd/i.test(nom) ? 3 : /tv/i.test(nom)
      ? 4 : /web/i.test(nom) ? 5 : /remux/i.test(nom) ? 7 : /blu/i.test(nom) ? 6 : 0;
  }
  if (/remux/i.test(nom)) source = Math.max(source, 7);
  return resolution * 10 + source;
}

// ---------- raisons de rejet en français ----------

const RAISONS: [RegExp, string][] = [
  [/blocklist|blacklist/i, "Release sur la liste noire"],
  [/already in (the )?queue|release in queue/i, "Déjà dans la file de téléchargement"],
  [/already (been )?(downloaded|imported)|existing file.*(equal|higher|better)|equal or higher/i, "Le fichier actuel est de qualité égale ou supérieure"],
  [/cutoff|meets/i, "Le fichier actuel atteint déjà la qualité souhaitée"],
  [/quality.*(not wanted|not allowed|disabled)|not wanted in profile/i, "Qualité non souhaitée dans le profil"],
  [/custom format.*(below|minimum|score)|format score/i, "Score des formats personnalisés trop bas"],
  [/seeders?/i, "Pas assez de pairs"],
  [/minimum age/i, "Trop récente (âge minimum du profil)"],
  [/retention|older than/i, "Trop ancienne (rétention de l'indexeur)"],
  [/too (big|large)|larger than|maximum size|exceeds.*size/i, "Trop volumineuse pour le profil"],
  [/too small|smaller than|minimum size/i, "Trop petite pour le profil"],
  [/language/i, "Langue non souhaitée"],
  [/unknown (movie|series|show)|not found in.*(radarr|sonarr)|wrong (movie|series)/i, "Ne correspond pas à ce titre"],
  [/not monitored|unmonitored/i, "Titre non surveillé"],
  [/sample/i, "Échantillon (sample)"],
  [/raw-?hd|unsupported|not supported/i, "Format non pris en charge"],
  [/(season|episode).*(pack|not wanted)|multi-?episode|full season/i, "Pack ou épisode non voulu"],
  [/indexer/i, "Refusée par l'indexeur"],
];

export function raisonEnFrancais(brut: unknown): string {
  const texte = typeof brut === "object" && brut ? str((brut as Obj).reason) : str(brut);
  for (const [motif, libelle] of RAISONS) if (motif.test(texte)) return libelle;
  return "Rejetée par le service";
}

// ---------- fichier actuel et annotation des releases ----------

export interface FichierActuel {
  qualite: string | null;
  rang: number;
  tailleOctets: number;
  langues: string[];
  groupe: string | null;
  nom: string;
}

export type EtatTitre =
  | { statut: "present"; fichier: FichierActuel | null }
  | { statut: "sans_fichier" | "absent" | "inconnu" };

/** « Film.2026.1080p.WEB-DL-GRP.mkv » et « film 2026 1080p web dl grp » doivent se reconnaître. */
const clef = (nom: string) =>
  nom.replace(/\.(mkv|mp4|avi|m4v|ts)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function fichierActuel(f: Obj): FichierActuel {
  const nom = str(f.sceneName) || str(f.relativePath).split("/").pop() || "";
  const langues = Array.isArray(f.languages) ? f.languages.map((l: Obj) => str(l?.name)).filter(Boolean) : [];
  if (langues.length === 0 && f.language?.name) langues.push(str(f.language.name));
  return {
    qualite: str(f.quality?.quality?.name) || null,
    rang: rangQualite(f.quality?.quality),
    tailleOctets: num(f.size),
    langues,
    groupe: str(f.releaseGroup) || null,
    nom,
  };
}

export function normaliserRelease(r: Obj, fichier: FichierActuel | null = null) {
  const torrent = str(r.protocol).toLowerCase() === "torrent";
  const raisons = Array.isArray(r.rejections) ? r.rejections.map(raisonEnFrancais) : [];
  const rang = rangQualite(r.quality?.quality);
  const titre = str(r.title);
  return {
    guid: str(r.guid),
    indexerId: num(r.indexerId),
    titre,
    indexeur: str(r.indexer),
    protocole: torrent ? ("torrent" as const) : ("usenet" as const),
    qualite: str(r.quality?.quality?.name) || null,
    rang,
    resolution: num(r.quality?.quality?.resolution) || Number(/(\d{3,4})p/i.exec(str(r.quality?.quality?.name))?.[1] ?? 0) || null,
    pack: r.fullSeason === true,
    tailleOctets: num(r.size),
    seeders: torrent && typeof r.seeders === "number" ? r.seeders : null,
    leechers: torrent && typeof r.leechers === "number" ? r.leechers : null,
    ageMinutes: num(r.ageMinutes) || num(r.ageHours) * 60 || num(r.age) * 1440,
    langues: Array.isArray(r.languages) ? r.languages.map((l: Obj) => str(l?.name)).filter(Boolean) : [],
    score: typeof r.customFormatScore === "number" ? r.customFormatScore : null,
    groupe: str(r.releaseGroup) || null,
    rejete: r.rejected === true || raisons.length > 0,
    raisons: [...new Set<string>(raisons)],
    telechargeable: r.downloadAllowed !== false,
    // Par rapport au fichier actuel :
    dejaTelecharge: fichier !== null && fichier.nom !== "" && clef(titre) === clef(fichier.nom),
    miseANiveau: fichier !== null && rang > fichier.rang,
    inferieure: fichier !== null && rang < fichier.rang,
    meilleurChoix: false,
  };
}

type Release = ReturnType<typeof normaliserRelease>;

/** Ordre « recommandé » : le meilleur choix, puis les non rejetées (mises à niveau d'abord), puis les rejetées. */
function ordreRecommande(a: Release, b: Release): number {
  return (
    Number(b.meilleurChoix) - Number(a.meilleurChoix) ||
    Number(a.rejete) - Number(b.rejete) ||
    Number(b.miseANiveau) - Number(a.miseANiveau) ||
    b.rang - a.rang ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.seeders ?? 0) - (a.seeders ?? 0) ||
    b.tailleOctets - a.tailleOctets
  );
}

/** Marque LA release à choisir : non rejetée, téléchargeable, pas déjà là, et meilleure que le fichier actuel s'il y en a un. */
export function marquerMeilleurChoix(items: Release[], aUnFichier: boolean): Release[] {
  const candidates = items.filter(
    (r) => !r.rejete && r.telechargeable && !r.dejaTelecharge && (!aUnFichier || r.miseANiveau),
  );
  const meilleur = [...candidates].sort(ordreRecommande)[0];
  if (meilleur) meilleur.meilleurChoix = true;
  return items.sort(ordreRecommande);
}

/** Cause lisible d'un refus de Radarr / Sonarr à l'envoi d'une release (corps JSON `message`, `errorMessage` ou liste). */
async function causeRefus(res: Response, purger: (t: string) => string): Promise<string> {
  const texte = (await res.text().catch(() => "")).trim();
  let brut = "";
  try {
    const j = JSON.parse(texte);
    brut = (Array.isArray(j) ? j : [j]).map((x: Obj) => str(x?.errorMessage) || str(x?.message) || str(x?.description)).filter(Boolean).join(" ; ");
  } catch {
    brut = texte.startsWith("<") ? "" : texte;
  }
  const propre = purger(brut).replace(/\s+/g, " ").trim().slice(0, 200);
  const traduit = raisonEnFrancais(propre);
  if (traduit !== "Rejetée par le service") return traduit;
  return propre || `HTTP ${res.status}`;
}

export function registerReleases(
  app: FastifyInstance,
  getJson: GetJson,
  ecrire: Ecrire,
  configured: (id: ServiceId) => boolean,
  purger: (texte: string) => string = (t) => t,
  maintenant: () => number = () => Date.now(),
  options: { delaiRechercheMs?: () => number; log?: (message: string) => void } = {},
) {
  const envoyees = new Map<string, number>();
  const delaiRecherche = () => options.delaiRechercheMs?.() ?? DELAI_RECHERCHE_MS;
  // Épisodes d'une série, groupés par saison.
  app.get("/api/episodes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Requête invalide" });
    if (!configured("sonarr")) return reply.code(404).send({ error: "Sonarr n'est pas configuré" });
    try {
      const liste = (await getJson("sonarr", `/episode?seriesId=${id}`)) as Obj[];
      const saisons = new Map<number, Obj[]>();
      for (const e of liste) saisons.set(num(e.seasonNumber), [...(saisons.get(num(e.seasonNumber)) ?? []), e]);
      return {
        // Les épisodes n'ont pas d'affiche : on prend celle de la série.
        affiche: `/image/sonarr/MediaCover/${id}/poster.jpg`,
        saisons: [...saisons.entries()]
          .sort(([a], [b]) => a - b)
          .map(([numero, eps]) => ({
            numero,
            episodes: eps
              .sort((a, b) => num(a.episodeNumber) - num(b.episodeNumber))
              .map((e) => ({
                id: num(e.id),
                numero: num(e.episodeNumber),
                titre: str(e.title),
                diffusion: str(e.airDateUtc) || str(e.airDate) || null,
                fichier: e.hasFile === true,
                suivi: e.monitored === true,
              })),
          })),
      };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Sonarr injoignable" });
    }
  });

  /** État du titre dans la bibliothèque, avec le fichier actuel (qualité, taille, langue, groupe). */
  async function etatDuTitre(cible: Cible, id: string): Promise<{ etat: EtatTitre; note: Note | null }> {
    try {
      if (cible === "film") {
        const m = (await getJson("radarr", `/movie/${id}`)) as Obj;
        const note = noteMedia(true, m);
        if (m.hasFile === true && m.movieFile) return { etat: { statut: "present", fichier: fichierActuel(m.movieFile) }, note };
        return { etat: { statut: m.hasFile === true ? "present" : "sans_fichier", fichier: null } as EtatTitre, note };
      }
      const e = (await getJson("sonarr", `/episode/${id}`)) as Obj;
      if (e.hasFile !== true) return { etat: { statut: "sans_fichier" }, note: null };
      let f = e.episodeFile as Obj | undefined;
      if (!f && num(e.episodeFileId) > 0) f = (await getJson("sonarr", `/episodefile/${num(e.episodeFileId)}`)) as Obj;
      return { etat: { statut: "present", fichier: f ? fichierActuel(f) : null }, note: null };
    } catch (e) {
      // 404 : le titre n'est pas (ou plus) dans la bibliothèque. Autre erreur : on ne prétend rien.
      const absent = e instanceof Error && /HTTP 404/.test(e.message);
      return { etat: { statut: absent ? "absent" : "inconnu" }, note: null };
    }
  }

  // Releases proposées : /api/releases/film/<id film>, /api/releases/episode/<id épisode>
  // ou /api/releases/saison/<id série>/<numéro de saison> (packs de saison).
  app.get("/api/releases/:cible/:id/:numero?", async (req, reply) => {
    const { cible, id, numero } = req.params as { cible: string; id: string; numero?: string };
    if (
      (cible !== "film" && cible !== "episode" && cible !== "saison") ||
      !/^\d+$/.test(id) ||
      (cible === "saison" ? !/^\d{1,3}$/.test(numero ?? "") : numero !== undefined)
    ) {
      return reply.code(400).send({ error: "Requête invalide" });
    }
    const service = SERVICE[cible];
    if (!configured(service)) return reply.code(404).send({ error: "Service non configuré" });
    // La recherche a son propre délai (90 s par défaut, réglable) et s'arrête si l'app ferme la feuille.
    const delai = delaiRecherche();
    const arret = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) arret.abort();
    });
    const debut = Date.now();
    try {
      const chemin =
        cible === "film" ? `/release?movieId=${id}` : cible === "episode" ? `/release?episodeId=${id}` : `/release?seriesId=${id}&seasonNumber=${numero}`;
      const [liste, titre] = await Promise.all([
        getJson(service, chemin, { timeoutMs: delai, signal: arret.signal }) as Promise<Obj[]>,
        // Une saison n'a pas « un » fichier à comparer : pas d'état de titre.
        cible === "saison" ? Promise.resolve({ etat: { statut: "inconnu" } as EtatTitre, note: null }) : etatDuTitre(cible, id),
      ]);
      const fichier = titre.etat.statut === "present" ? titre.etat.fichier : null;
      const items = marquerMeilleurChoix(
        liste.map((r) => normaliserRelease(r, fichier)).filter((r) => r.guid),
        fichier !== null,
      ).slice(0, 100);
      options.log?.(`[releases] ${NOM_SERVICE[service]} ${cible} ${id}${numero ? `/${numero}` : ""} : ${liste.length} résultat(s) en ${((Date.now() - debut) / 1000).toFixed(1)} s`);
      return { titre: { ...titre.etat, note: titre.note }, items, dureeMs: Date.now() - debut };
    } catch (e) {
      const duree = Date.now() - debut;
      if (arret.signal.aborted) {
        options.log?.(`[releases] ${NOM_SERVICE[service]} ${cible} ${id} : annulée par l'app après ${(duree / 1000).toFixed(1)} s`);
        return reply.code(499).send({ error: "Recherche annulée" });
      }
      const delaiDepasse = e instanceof ErreurService && e.nature === "reseau" && /délai dépassé/.test(e.message);
      const statut = e instanceof ErreurService ? e.statut : undefined;
      options.log?.(`[releases] ${NOM_SERVICE[service]} ${cible} ${id} : échec après ${(duree / 1000).toFixed(1)} s (${delaiDepasse ? "délai dépassé" : statut ? `HTTP ${statut}` : "erreur"})`);
      if (delaiDepasse) {
        return reply.code(504).send({
          error: `Les indexeurs n'ont pas répondu à temps (${Math.round(delai / 1000)} s).`,
          code: "delai",
        });
      }
      if (statut && statut >= 500) {
        return reply.code(502).send({
          error: `${NOM_SERVICE[service]} a répondu par une erreur (HTTP ${statut}) : un indexeur est peut-être en panne, vérifie Prowlarr.`,
          code: "service",
        });
      }
      return reply.code(502).send({ error: purger(e instanceof Error ? e.message : "Recherche impossible"), code: "service" });
    }
  });

  // Envoie une release choisie au client de téléchargement.
  app.post("/api/releases/:cible", async (req, reply) => {
    const { cible } = req.params as { cible: string };
    if (cible !== "film" && cible !== "episode" && cible !== "saison") return reply.code(400).send({ error: "Requête invalide" });
    const b = lireJson(req.body);
    if (
      !b ||
      typeof b.guid !== "string" ||
      b.guid.length === 0 ||
      b.guid.length > 500 ||
      !Number.isInteger(b.indexerId) ||
      b.indexerId < 0
    ) {
      return reply.code(400).send({ error: "Demande invalide" });
    }
    const service = SERVICE[cible];
    if (!configured(service)) return reply.code(404).send({ error: "Service non configuré" });
    const protocole = b.protocole === "usenet" ? "usenet" : "torrent";
    const t = maintenant();
    for (const [k, quand] of envoyees) if (t - quand > DELAI_DOUBLON_MS) envoyees.delete(k);
    const cleDoublon = `${service}|${b.guid}`;
    if (envoyees.has(cleDoublon)) {
      return reply.code(409).send({ error: "Cette release a déjà été envoyée il y a quelques minutes." });
    }
    try {
      const res = await ecrire(service, "POST", "/release", { guid: b.guid, indexerId: b.indexerId });
      if (res.status === 404) {
        return reply.code(410).send({ error: "Ce résultat a expiré : relance la recherche." });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: `${NOM_SERVICE[service]} a refusé le téléchargement : ${await causeRefus(res, purger)}` });
      }
      envoyees.set(cleDoublon, t);
      // Nom du client qui a reçu la release (facultatif : on ne bloque rien s'il manque).
      let client: string | null = null;
      try {
        const clients = (await getJson(service, "/downloadclient")) as Obj[];
        const actifs = (Array.isArray(clients) ? clients : []).filter((c) => c.enable !== false && str(c.protocol).toLowerCase() === protocole);
        client = actifs.length === 1 ? str(actifs[0].name) || null : null;
      } catch {
        /* nom inconnu */
      }
      return { ok: true, client };
    } catch (e) {
      return reply.code(502).send({ error: purger(e instanceof Error ? e.message : "Service injoignable") });
    }
  });
}

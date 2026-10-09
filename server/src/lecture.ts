// Routes de lecture (phase 2) : le serveur interroge les services et renvoie des données
// déjà simplifiées au téléphone (pas de clés, pas de gros JSON bruts).
import type { FastifyInstance } from "fastify";
import { ErreurService } from "./erreurs.js";
import { externe } from "./images.js";
import type { ServiceId } from "./services.js";

export type GetJson = (id: ServiceId, path: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;

type Obj = Record<string, any>;
export type Etat = "complet" | "partiel" | "manquant";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const jour = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Affiche ou fond d'un média, sous forme de chemin Mediarr (/image/… ou /image-externe?…), jamais l'adresse
 * du service ni sa clé. Ordre : 1) l'image locale du service (url → /MediaCover/…), 2) son adresse distante
 * si elle est sur un site autorisé, 3) /MediaCover/<id>/<type>.jpg construit à partir de l'identifiant
 * (le service l'a pour tout média de sa bibliothèque). null seulement si on ne sait rien du média.
 */
export function image(
  service: "radarr" | "sonarr",
  images: unknown,
  type: "poster" | "fanart",
  mediaId?: number,
): string | null {
  const candidates = (Array.isArray(images) ? images : []).filter(
    (i: Obj) => str(i?.coverType).toLowerCase() === type,
  );
  for (const img of candidates) {
    const url = str(img?.url);
    const i = url.indexOf("/MediaCover/"); // ignore un éventuel préfixe d'URL (urlBase) du service
    if (i >= 0) return `/image/${service}${url.slice(i)}`;
  }
  for (const img of candidates) {
    const distante = externe(str(img?.remoteUrl)) ?? externe(str(img?.url));
    if (distante) return distante;
  }
  return mediaId && mediaId > 0 ? `/image/${service}/MediaCover/${mediaId}/${type}.jpg` : null;
}

export interface Note {
  valeur: number;
  votes: number | null;
  /** « imdb » (films, via Radarr), « tmdb » (repli honnête), « note » (séries : Sonarr ne donne pas d'IMDb). */
  source: "imdb" | "tmdb" | "note";
}

/** Note d'un film ou d'une série ; null s'il n'y en a aucune (jamais « 0 »). */
export function noteMedia(film: boolean, m: Obj): Note | null {
  const lire = (r: Obj | undefined, source: Note["source"]): Note | null =>
    r && typeof r.value === "number" && r.value > 0
      ? { valeur: r.value, votes: typeof r.votes === "number" && r.votes > 0 ? r.votes : null, source }
      : null;
  return film ? lire(m.ratings?.imdb, "imdb") ?? lire(m.ratings?.tmdb, "tmdb") : lire(m.ratings, "note");
}

function etatSerie(s: Obj): Etat {
  const total = num(s.statistics?.episodeCount);
  const fichiers = num(s.statistics?.episodeFileCount);
  if (fichiers === 0) return "manquant";
  return total > 0 && fichiers >= total ? "complet" : "partiel";
}

/** État de sortie normalisé : « avenir » (pas encore sorti), « sorti », « enCours » (série diffusée), « termine » (série finie). */
function statutSortie(film: boolean, brut: string): "avenir" | "sorti" | "enCours" | "termine" | null {
  const s = brut.toLowerCase();
  if (film) return s === "released" ? "sorti" : s === "announced" || s === "incinemas" ? "avenir" : null;
  return s === "continuing" ? "enCours" : s === "ended" ? "termine" : s === "upcoming" ? "avenir" : null;
}

function resume(m: Obj, type: "film" | "serie", profils: Map<number, string> = new Map()) {
  const film = type === "film";
  const service = film ? "radarr" : "sonarr";
  const sortie = film
    ? str(m.digitalRelease) || str(m.physicalRelease) || str(m.inCinemas)
    : str(m.nextAiring) || str(m.previousAiring);
  return {
    ajoute: str(m.added) || null,
    tailleOctets: film ? num(m.sizeOnDisk) : num(m.statistics?.sizeOnDisk),
    noteValeur: noteMedia(film, m)?.valeur ?? null,
    studio: (film ? str(m.studio) : str(m.network)) || null,
    statut: statutSortie(film, str(m.status)),
    sortie: sortie || null,
    profil: profils.get(num(m.qualityProfileId)) ?? null,
    langue: str(m.originalLanguage?.name) || null,
    id: num(m.id),
    type,
    titre: str(m.title),
    annee: num(m.year) || null,
    affiche: image(service, m.images, "poster", num(m.id)),
    etat: (film ? (m.hasFile ? "complet" : "manquant") : etatSerie(m)) as Etat,
    progression: film ? null : num(m.statistics?.percentOfEpisodes),
    suivi: Boolean(m.monitored),
    synopsis: str(m.overview),
    genres: Array.isArray(m.genres) ? m.genres.map(String) : [],
    dureeMin: num(m.runtime) || null,
    qualite: film ? (m.movieFile?.quality?.quality?.name ?? null) : null,
  };
}

/** Vignette Plex : on ne garde que les chemins de la médiathèque (relayés avec le jeton côté serveur). */
function cheminPlex(thumb: unknown): string | null {
  const t = str(thumb);
  return t.startsWith("/library/metadata/") && !t.includes("..") ? `/image/plex${t}` : null;
}

export type EtatTorrent = { code: string; libelle: string; attention: boolean };

/** États qBittorrent (v4 et v5) → libellé français. */
export function etatTorrent(state: string): EtatTorrent {
  const t = (code: string, libelle: string, attention = false) => ({ code, libelle, attention });
  switch (state) {
    case "downloading":
    case "forcedDL":
      return t("actif", "Téléchargement");
    case "metaDL":
    case "forcedMetaDL":
      return t("actif", "Métadonnées");
    case "stalledDL":
      return t("attente", "En attente de pairs", true);
    case "queuedDL":
      return t("file", "En file");
    case "pausedDL":
    case "stoppedDL":
      return t("pause", "En pause");
    case "checkingDL":
    case "checkingUP":
    case "checkingResumeData":
      return t("verif", "Vérification");
    case "allocating":
      return t("verif", "Allocation");
    case "moving":
      return t("verif", "Déplacement");
    case "uploading":
    case "forcedUP":
      return t("partage", "Partage");
    case "stalledUP":
      return t("termine", "Terminé");
    case "pausedUP":
    case "stoppedUP":
      return t("pause", "Terminé · en pause");
    case "queuedUP":
      return t("file", "En file (envoi)");
    case "error":
      return t("erreur", "Erreur", true);
    case "missingFiles":
      return t("erreur", "Fichiers manquants", true);
    default:
      return t("autre", state || "Inconnu");
  }
}

export interface EtatHistorique {
  code: "importe" | "recupere" | "supprime" | "echec" | "renomme" | "ignore" | "autre";
  libelle: string;
}

/** Type d'évènement de l'historique Radarr/Sonarr → badge français. */
export function etatHistorique(evenement: string): EtatHistorique {
  switch (evenement) {
    case "downloadFolderImported":
    case "seriesFolderImported":
      return { code: "importe", libelle: "Importé" };
    case "grabbed":
      return { code: "recupere", libelle: "Récupéré" };
    case "movieFileDeleted":
    case "episodeFileDeleted":
      return { code: "supprime", libelle: "Supprimé" };
    case "downloadFailed":
      return { code: "echec", libelle: "Échec" };
    case "movieFileRenamed":
    case "episodeFileRenamed":
      return { code: "renomme", libelle: "Renommé" };
    case "downloadIgnored":
      return { code: "ignore", libelle: "Ignoré" };
    default:
      return { code: "autre", libelle: "Autre" };
  }
}

const TTL_LISTES_MS = 30_000;

/** Garde 30 s les listes complètes (centaines de films) : l'accueil, rafraîchi toutes les 15 s, ne les redemande pas. */
export class ListesEnMemoire {
  private memo = new Map<string, { at: number; valeur: Promise<unknown> }>();

  lire(cle: string, charger: () => Promise<unknown>): Promise<unknown> {
    const garde = this.memo.get(cle);
    if (garde && Date.now() - garde.at < TTL_LISTES_MS) return garde.valeur;
    const valeur = charger();
    this.memo.set(cle, { at: Date.now(), valeur });
    valeur.catch(() => this.memo.delete(cle));
    return valeur;
  }

  /** À appeler après un ajout : la bibliothèque doit montrer le nouveau titre tout de suite. */
  vider() {
    this.memo.clear();
  }
}

export function registerLecture(
  app: FastifyInstance,
  getJsonDirect: GetJson,
  configured: (id: ServiceId) => boolean,
  listes = new ListesEnMemoire(),
) {
  const getJson: GetJson = (id, path, opts) =>
    path === "/movie" || path === "/series"
      ? listes.lire(`${id}${path}`, () => getJsonDirect(id, path, opts))
      : getJsonDirect(id, path, opts);

  app.get("/api/accueil", async () => {
    const section = async <T extends object>(id: ServiceId, fn: () => Promise<T>) => {
      if (!configured(id)) return undefined;
      try {
        return { ok: true as const, ...(await fn()) };
      } catch (e) {
        // La nature (réseau, accès refusé, réponse illisible, autre) et le détail permettent d'afficher le bon message.
        const err = e instanceof ErreurService ? e : null;
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : "Erreur",
          nature: err?.nature ?? ("reseau" as const),
          detail: err?.detail || undefined,
        };
      }
    };

    const [films, series, qbit, plex, overseerr] = await Promise.all([
      section("radarr", async () => {
        const list = (await getJson("radarr", "/movie")) as Obj[];
        return {
          total: list.length,
          disponibles: list.filter((m) => m.hasFile).length,
          tailleOctets: list.reduce((n, m) => n + num(m.sizeOnDisk), 0),
        };
      }),
      section("sonarr", async () => {
        const list = (await getJson("sonarr", "/series")) as Obj[];
        return {
          total: list.length,
          episodes: list.reduce((n, s) => n + num(s.statistics?.episodeFileCount), 0),
          episodesTotal: list.reduce((n, s) => n + num(s.statistics?.episodeCount), 0),
          tailleOctets: list.reduce((n, s) => n + num(s.statistics?.sizeOnDisk), 0),
        };
      }),
      section("qbittorrent", async () => {
        const [info, actifs] = (await Promise.all([
          getJson("qbittorrent", "/transfer/info"),
          getJson("qbittorrent", "/torrents/info?filter=downloading"),
        ])) as [Obj, Obj[]];
        const principal = [...actifs].sort((a, b) => num(b.dlspeed) - num(a.dlspeed))[0];
        return {
          telechargement: num(info.dl_info_speed),
          envoi: num(info.up_info_speed),
          actifs: actifs.length,
          principal: principal
            ? {
                nom: str(principal.name),
                progression: num(principal.progress),
                resteSec: num(principal.eta) >= 8_640_000 ? null : num(principal.eta),
              }
            : null,
        };
      }),
      section("plex", async () => {
        const data = (await getJson("plex", "/status/sessions")) as Obj;
        const conteneur = data?.MediaContainer;
        if (!conteneur || typeof conteneur !== "object") {
          throw new ErreurService("Plex : format inattendu", "illisible", 200, JSON.stringify(data ?? null).slice(0, 200));
        }
        // Aucune lecture en cours : Plex répond { MediaContainer: { size: 0 } } SANS tableau Metadata. Ce n'est pas une erreur.
        const items: Obj[] = Array.isArray(conteneur.Metadata) ? conteneur.Metadata : [];
        return {
          lectures: items.map((m) => ({
            titre: m.grandparentTitle
              ? `${str(m.grandparentTitle)} · S${String(num(m.parentIndex)).padStart(2, "0")}E${String(
                  num(m.index),
                ).padStart(2, "0")}`
              : str(m.title),
            utilisateur: str(m.User?.title),
            appareil: str(m.Player?.title),
            etat: str(m.Player?.state) || "playing",
            transcode: str(m.TranscodeSession?.videoDecision) === "transcode",
            resolution: str(m.Media?.[0]?.videoResolution) || null,
            local: m.Session?.location ? m.Session.location === "lan" : Boolean(m.Player?.local),
            affiche: cheminPlex(m.grandparentThumb ?? m.thumb),
          })),
        };
      }),
      section("overseerr", async () => {
        const c = (await getJson("overseerr", "/request/count")) as Obj;
        return { enAttente: num(c.pending) };
      }),
    ]);
    return { films, series, qbit, plex, overseerr };
  });

  app.get("/api/bibliotheque", async (_req, reply) => {
    if (!configured("radarr") && !configured("sonarr")) {
      return reply.code(404).send({ error: "Radarr et Sonarr ne sont pas configurés" });
    }
    const [films, series] = await Promise.allSettled([
      configured("radarr") ? getJson("radarr", "/movie") : Promise.resolve([]),
      configured("sonarr") ? getJson("sonarr", "/series") : Promise.resolve([]),
    ]);
    // Noms des profils de qualité (facultatif : sans eux, le filtre « Qualité » n'a simplement pas de choix).
    const noms = async (id: "radarr" | "sonarr") => {
      try {
        return new Map(((await getJson(id, "/qualityprofile")) as Obj[]).map((p) => [num(p.id), str(p.name)] as [number, string]));
      } catch {
        return new Map<number, string>();
      }
    };
    const [profilsFilms, profilsSeries] = await Promise.all([
      configured("radarr") && films.status === "fulfilled" ? noms("radarr") : new Map<number, string>(),
      configured("sonarr") && series.status === "fulfilled" ? noms("sonarr") : new Map<number, string>(),
    ]);
    const items = [
      ...((films.status === "fulfilled" ? films.value : []) as Obj[]).map((m) => resume(m, "film", profilsFilms)),
      ...((series.status === "fulfilled" ? series.value : []) as Obj[]).map((s) =>
        resume(s, "serie", profilsSeries),
      ),
    ].sort((a, b) => a.titre.localeCompare(b.titre, "fr"));
    return {
      items,
      erreurs: [
        ...(films.status === "rejected" ? ["Radarr injoignable"] : []),
        ...(series.status === "rejected" ? ["Sonarr injoignable"] : []),
      ],
    };
  });

  app.get("/api/detail/:type/:id", async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!/^\d+$/.test(id) || (type !== "film" && type !== "serie")) {
      return reply.code(400).send({ error: "Requête invalide" });
    }
    const service: ServiceId = type === "film" ? "radarr" : "sonarr";
    if (!configured(service)) return reply.code(404).send({ error: "Service non configuré" });
    let m: Obj;
    try {
      m = (await getJson(service, type === "film" ? `/movie/${id}` : `/series/${id}`)) as Obj;
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Service injoignable" });
    }
    const film = type === "film";

    // Saga : les autres films de la même collection qui sont dans la bibliothèque (Radarr seulement).
    let collection: { titre: string; films: { id: number; titre: string; annee: number | null; affiche: string | null; etat: Etat }[] } | null = null;
    if (film && num(m.collection?.tmdbId) > 0) {
      const tmdb = num(m.collection.tmdbId);
      let membres: Obj[] = [];
      try {
        membres = ((await getJson("radarr", "/movie")) as Obj[]).filter((x) => num(x.collection?.tmdbId) === tmdb);
      } catch {
        /* la saga est un plus : sans la liste, on garde au moins son nom */
      }
      collection = {
        titre: str(m.collection.title) || str(m.collection.name) || "Collection",
        films: membres
          .map((x) => ({ id: num(x.id), titre: str(x.title), annee: num(x.year) || null, affiche: image("radarr", x.images, "poster", num(x.id)), etat: (x.hasFile ? "complet" : "manquant") as Etat }))
          .sort((a, b) => (a.annee ?? 9999) - (b.annee ?? 9999)),
      };
    }

    return {
      ...resume(m, film ? "film" : "serie"),
      collection,
      fond: image(film ? "radarr" : "sonarr", m.images, "fanart", num(m.id)),
      chemin: str(m.path),
      note: noteMedia(film, m),
      tailleOctets: film ? num(m.sizeOnDisk) : num(m.statistics?.sizeOnDisk),
      studio: str(film ? m.studio : m.network) || null,
      saisons: film
        ? []
        : ((m.seasons ?? []) as Obj[])
            .filter((s) => num(s.seasonNumber) > 0)
            .map((s) => ({
              numero: num(s.seasonNumber),
              episodes: num(s.statistics?.episodeFileCount),
              total: num(s.statistics?.totalEpisodeCount),
              suivi: Boolean(s.monitored),
            })),
    };
  });

  // Distribution d'un film (acteurs et équipe) d'après Radarr ; Sonarr ne fournit rien de tel pour les séries.
  app.get("/api/detail/film/:id/distribution", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Requête invalide" });
    if (!configured("radarr")) return reply.code(404).send({ error: "Radarr n'est pas configuré" });
    try {
      const credits = (await getJson("radarr", `/credit?movieId=${id}`)) as Obj[];
      const photo = (c: Obj) => {
        const h = (Array.isArray(c.images) ? c.images : []).find((i: Obj) => str(i?.coverType).toLowerCase() === "headshot");
        return externe(str(h?.remoteUrl)) ?? externe(str(h?.url));
      };
      const acteurs = credits
        .filter((c) => str(c.type) === "cast" && str(c.personName))
        .sort((a, b) => num(a.order) - num(b.order))
        .slice(0, 12)
        .map((c) => ({ nom: str(c.personName), role: str(c.character) || null, photo: photo(c) }));
      const postes: Record<string, string> = {
        Director: "Réalisateur", Writer: "Scénariste", Screenplay: "Scénario", Novel: "Roman", Story: "Histoire",
        Producer: "Producteur", "Executive Producer": "Producteur exécutif", "Original Music Composer": "Musique",
        "Director of Photography": "Image", Editor: "Montage",
      };
      const vus = new Set<string>();
      const equipe = credits
        .filter((c) => str(c.type) === "crew" && postes[str(c.job)] && str(c.personName))
        .sort((a, b) => Object.keys(postes).indexOf(str(a.job)) - Object.keys(postes).indexOf(str(b.job)))
        .map((c) => ({ nom: str(c.personName), poste: postes[str(c.job)] }))
        .filter((c) => !vus.has(`${c.nom}|${c.poste}`) && vus.add(`${c.nom}|${c.poste}`))
        .slice(0, 8);
      return { acteurs, equipe };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Radarr injoignable" });
    }
  });

  // Calendrier : ?debut=AAAA-MM-JJ (aujourd'hui par défaut) &jours=7 (1 à 60).
  app.get("/api/calendrier", async (req, reply) => {
    const q = req.query as { debut?: string; jours?: string };
    if (q.debut && !/^\d{4}-\d{2}-\d{2}$/.test(q.debut)) {
      return reply.code(400).send({ error: "Date invalide" });
    }
    const n = Math.min(60, Math.max(1, Number.parseInt(q.jours ?? "14", 10) || 14));
    const debut = q.debut ? new Date(`${q.debut}T00:00:00Z`) : new Date(`${jour(new Date())}T00:00:00Z`);
    if (Number.isNaN(debut.getTime())) return reply.code(400).send({ error: "Date invalide" });
    const fin = new Date(debut.getTime() + (n - 1) * 86_400_000);
    const plage = `start=${jour(debut)}&end=${jour(fin)}`;
    const dansPlage = (iso: unknown) =>
      typeof iso === "string" && iso.slice(0, 10) >= jour(debut) && iso.slice(0, 10) <= jour(fin);

    const [films, series] = await Promise.allSettled([
      configured("radarr") ? getJson("radarr", `/calendar?${plage}`) : Promise.resolve([]),
      configured("sonarr")
        ? getJson("sonarr", `/calendar?${plage}&includeSeries=true`)
        : Promise.resolve([]),
    ]);

    // Éléments en cours de téléchargement (file d'attente de Radarr / Sonarr) : facultatif, ignoré si le service ne répond pas.
    const enFile = async (id: "radarr" | "sonarr", champ: "movieId" | "episodeId") => {
      try {
        const r = (await getJson(id, "/queue?page=1&pageSize=200")) as Obj;
        return new Set<number>((Array.isArray(r.records) ? r.records : []).map((x: Obj) => num(x[champ])).filter((n: number) => n > 0));
      } catch {
        return new Set<number>();
      }
    };
    const [filmsEnFile, episodesEnFile] = await Promise.all([
      configured("radarr") && films.status === "fulfilled" ? enFile("radarr", "movieId") : new Set<number>(),
      configured("sonarr") && series.status === "fulfilled" ? enFile("sonarr", "episodeId") : new Set<number>(),
    ]);

    const sorties = [
      ["digitalRelease", "Sortie numérique"],
      ["physicalRelease", "Sortie physique"],
      ["inCinemas", "Sortie au cinéma"],
    ] as const;

    const items = [
      ...((films.status === "fulfilled" ? films.value : []) as Obj[]).flatMap((m) => {
        const s = sorties.find(([champ]) => dansPlage(m[champ]));
        if (!s) return [];
        return [
          {
            type: "film" as const,
            id: num(m.id),
            titre: str(m.title),
            sousTitre: s[1],
            date: str(m[s[0]]),
            heure: false,
            disponible: Boolean(m.hasFile),
            enTelechargement: filmsEnFile.has(num(m.id)),
            suivi: Boolean(m.monitored),
            affiche: image("radarr", m.images, "poster", num(m.id)),
          },
        ];
      }),
      ...((series.status === "fulfilled" ? series.value : []) as Obj[]).flatMap((e) => {
        const date = str(e.airDateUtc) || str(e.airDate);
        if (!date) return [];
        return [
          {
            type: "serie" as const,
            id: num(e.seriesId),
            titre: str(e.series?.title) || str(e.title),
            sousTitre: `S${String(num(e.seasonNumber)).padStart(2, "0")}E${String(
              num(e.episodeNumber),
            ).padStart(2, "0")}`,
            episodeId: num(e.id),
            saison: num(e.seasonNumber),
            numero: num(e.episodeNumber),
            date,
            heure: Boolean(e.airDateUtc),
            disponible: Boolean(e.hasFile),
            enTelechargement: episodesEnFile.has(num(e.id)),
            suivi: Boolean(e.monitored),
            affiche: image("sonarr", e.series?.images, "poster", num(e.seriesId)),
          },
        ];
      }),
    ].sort((a, b) => a.date.localeCompare(b.date));

    return {
      items,
      erreurs: [
        ...(films.status === "rejected" ? ["Radarr injoignable"] : []),
        ...(series.status === "rejected" ? ["Sonarr injoignable"] : []),
      ],
    };
  });

  // Derniers imports (Radarr + Sonarr), du plus récent au plus ancien, un par film / série.
  app.get("/api/telechargements", async () => {
    const hist = "/history?page=1&pageSize=40&sortKey=date&sortDirection=descending&eventType=3";
    const [films, series] = await Promise.allSettled([
      configured("radarr") ? getJson("radarr", `${hist}&includeMovie=true`) : Promise.resolve({}),
      configured("sonarr")
        ? getJson("sonarr", `${hist}&includeSeries=true&includeEpisode=true`)
        : Promise.resolve({}),
    ]);
    const records = (r: PromiseSettledResult<unknown>): Obj[] =>
      r.status === "fulfilled" ? ((r.value as Obj)?.records ?? []) : [];

    const items = [
      ...records(films).flatMap((h) =>
        h.movie
          ? [
              {
                type: "film" as const,
                id: num(h.movieId) || num(h.movie.id),
                titre: str(h.movie.title),
                sousTitre: "",
                date: str(h.date),
                affiche: image("radarr", h.movie.images, "poster", num(h.movieId) || num(h.movie.id)),
              },
            ]
          : [],
      ),
      ...records(series).flatMap((h) =>
        h.series
          ? [
              {
                type: "serie" as const,
                id: num(h.seriesId) || num(h.series.id),
                titre: str(h.series.title),
                sousTitre: h.episode
                  ? `S${String(num(h.episode.seasonNumber)).padStart(2, "0")}E${String(
                      num(h.episode.episodeNumber),
                    ).padStart(2, "0")}`
                  : "",
                date: str(h.date),
                affiche: image("sonarr", h.series.images, "poster", num(h.seriesId) || num(h.series.id)),
              },
            ]
          : [],
      ),
    ]
      .filter((i) => i.date)
      .sort((a, b) => b.date.localeCompare(a.date));

    const vus = new Set<string>();
    const uniques = items.filter((i) => !vus.has(`${i.type}${i.id}`) && vus.add(`${i.type}${i.id}`));
    return {
      items: uniques.slice(0, 12),
      erreurs: [
        ...(films.status === "rejected" ? ["Radarr injoignable"] : []),
        ...(series.status === "rejected" ? ["Sonarr injoignable"] : []),
      ],
    };
  });

  // File qBittorrent : ce qui n'est pas encore terminé, les téléchargements actifs d'abord.
  app.get("/api/activite", async (_req, reply) => {
    if (!configured("qbittorrent")) {
      return reply.code(404).send({ error: "qBittorrent n'est pas configuré" });
    }
    try {
      const [info, torrents] = (await Promise.all([
        getJson("qbittorrent", "/transfer/info"),
        getJson("qbittorrent", "/torrents/info?filter=all&sort=added_on&reverse=true"),
      ])) as [Obj, Obj[]];
      // Torrents à problème (« Fichiers manquants »…) : on retrouve le film / l'épisode concerné par la file de Radarr et Sonarr,
      // pour proposer une recherche manuelle. Facultatif : sans lien, le torrent s'affiche comme avant.
      const liens = new Map<string, { cible: "film" | "episode"; id: number; titre: string }>();
      if (torrents.some((t) => num(t.progress) < 1 && etatTorrent(str(t.state)).attention)) {
        const lire = async (id: "radarr" | "sonarr", suite: string) => {
          if (!configured(id)) return [] as Obj[];
          try {
            const r = (await getJson(id, `/queue?page=1&pageSize=200${suite}`)) as Obj;
            return Array.isArray(r.records) ? (r.records as Obj[]) : [];
          } catch {
            return [] as Obj[];
          }
        };
        const [filmsFile, episodesFile] = await Promise.all([lire("radarr", "&includeMovie=true"), lire("sonarr", "&includeSeries=true&includeEpisode=true")]);
        for (const q of filmsFile) {
          if (str(q.downloadId) && num(q.movieId) > 0) liens.set(str(q.downloadId).toLowerCase(), { cible: "film", id: num(q.movieId), titre: str(q.movie?.title) || str(q.title) });
        }
        for (const q of episodesFile) {
          if (str(q.downloadId) && num(q.episodeId) > 0) {
            const code = `S${String(num(q.episode?.seasonNumber ?? q.seasonNumber)).padStart(2, "0")}E${String(num(q.episode?.episodeNumber)).padStart(2, "0")}`;
            liens.set(str(q.downloadId).toLowerCase(), { cible: "episode", id: num(q.episodeId), titre: `${str(q.series?.title) || str(q.title)} · ${code}` });
          }
        }
      }
      const items = torrents
        .filter((t) => num(t.progress) < 1)
        .map((t) => ({
          lien: liens.get(str(t.hash).toLowerCase()) ?? null,
          hash: str(t.hash),
          nom: str(t.name),
          etat: etatTorrent(str(t.state)),
          progression: num(t.progress),
          vitesse: num(t.dlspeed),
          resteSec: num(t.eta) >= 8_640_000 ? null : num(t.eta),
          tailleOctets: num(t.size),
          telechargesOctets: num(t.downloaded) || Math.round(num(t.size) * num(t.progress)),
          categorie: str(t.category),
        }))
        .sort((a, b) => b.vitesse - a.vitesse);
      return {
        telechargement: num(info.dl_info_speed),
        envoi: num(info.up_info_speed),
        items,
      };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "qBittorrent injoignable" });
    }
  });

  // Historique Radarr + Sonarr (les 100 derniers évènements de chaque), du plus récent au plus ancien.
  // Recherche, tri et filtres se font dans l'app : la liste est courte.
  app.get("/api/historique", async () => {
    const hist = "/history?page=1&pageSize=100&sortKey=date&sortDirection=descending";
    const [films, series] = await Promise.allSettled([
      configured("radarr") ? getJson("radarr", `${hist}&includeMovie=true`) : Promise.resolve({}),
      configured("sonarr")
        ? getJson("sonarr", `${hist}&includeSeries=true&includeEpisode=true`)
        : Promise.resolve({}),
    ]);
    const records = (r: PromiseSettledResult<unknown>): Obj[] =>
      r.status === "fulfilled" ? ((r.value as Obj)?.records ?? []) : [];

    const commun = (h: Obj) => {
      const langues = Array.isArray(h.languages) ? h.languages.map((l: Obj) => str(l?.name)).filter(Boolean) : [];
      const score = h.customFormatScore;
      return {
        id: String(h.id ?? ""),
        release: str(h.sourceTitle),
        etat: etatHistorique(str(h.eventType)),
        qualite: str(h.quality?.quality?.name) || null,
        score: typeof score === "number" ? score : null,
        langue: langues.join(", ") || null,
        groupe: str(h.data?.releaseGroup) || null,
        client: str(h.data?.downloadClientName) || str(h.data?.downloadClient) || null,
        date: str(h.date),
      };
    };

    const items = [
      ...records(films).flatMap((h) =>
        h.movie
          ? [
              {
                ...commun(h),
                id: `radarr-${str(h.id) || num(h.id)}`,
                service: "radarr" as const,
                type: "film" as const,
                mediaId: num(h.movieId) || num(h.movie.id),
                titre: str(h.movie.title),
                sousTitre: "",
                affiche: image("radarr", h.movie.images, "poster", num(h.movieId) || num(h.movie.id)),
              },
            ]
          : [],
      ),
      ...records(series).flatMap((h) =>
        h.series
          ? [
              {
                ...commun(h),
                id: `sonarr-${str(h.id) || num(h.id)}`,
                service: "sonarr" as const,
                type: "serie" as const,
                mediaId: num(h.seriesId) || num(h.series.id),
                titre: str(h.series.title),
                sousTitre: h.episode
                  ? `S${String(num(h.episode.seasonNumber)).padStart(2, "0")}E${String(
                      num(h.episode.episodeNumber),
                    ).padStart(2, "0")}`
                  : "",
                affiche: image("sonarr", h.series.images, "poster", num(h.seriesId) || num(h.series.id)),
              },
            ]
          : [],
      ),
    ]
      .filter((i) => i.date)
      .sort((a, b) => b.date.localeCompare(a.date));

    return {
      items,
      erreurs: [
        ...(films.status === "rejected" ? ["Radarr injoignable"] : []),
        ...(series.status === "rejected" ? ["Sonarr injoignable"] : []),
      ],
    };
  });
}

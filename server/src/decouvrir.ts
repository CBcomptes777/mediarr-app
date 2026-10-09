// « Découvrir » d'Overseerr : tendances, populaires, à venir, genres, recherche, fiche d'un titre et création d'une demande.
// Chaque titre est croisé avec Overseerr (mediaInfo.status) ET avec la bibliothèque Radarr / Sonarr pour dire s'il est déjà là.
import type { FastifyInstance } from "fastify";
import { lireJson, type Ecrire } from "./ajout.js";
import { externe } from "./images.js";
import { ListesEnMemoire, type GetJson } from "./lecture.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Ce que l'on sait d'un titre : disponible ✓, partiellement disponible, demandé (en attente / approuvé), dans la bibliothèque (sans fichier). */
export type StatutTitre = "disponible" | "partiel" | "demande" | "bibliotheque" | null;
type TypeTitre = "film" | "serie";

const RANGEES: Record<string, { chemin: string; type: TypeTitre | null }> = {
  tendances: { chemin: "/discover/trending", type: null },
  films: { chemin: "/discover/movies", type: "film" },
  series: { chemin: "/discover/tv", type: "serie" },
  "films-avenir": { chemin: "/discover/movies/upcoming", type: "film" },
  "series-avenir": { chemin: "/discover/tv/upcoming", type: "serie" },
};

/** États de média d'Overseerr : 2 en attente, 3 en traitement, 4 partiellement disponible, 5 disponible. */
function statutOverseerr(n: number): StatutTitre {
  return n === 5 ? "disponible" : n === 4 ? "partiel" : n === 2 || n === 3 ? "demande" : null;
}
const RANG: Record<NonNullable<StatutTitre>, number> = { disponible: 4, partiel: 3, demande: 2, bibliotheque: 1 };
const meilleur = (a: StatutTitre, b: StatutTitre): StatutTitre => (a && (!b || RANG[a] >= RANG[b]) ? a : b);

const affiche = (chemin: unknown, taille = "w342") =>
  str(chemin) ? externe(`https://image.tmdb.org/t/p/${taille}${str(chemin)}`) : null;

interface Bibliotheque {
  films: Map<number, StatutTitre>;
  seriesTmdb: Map<number, StatutTitre>;
  seriesTvdb: Map<number, StatutTitre>;
}

export function registerDecouvrir(
  app: FastifyInstance,
  getJson: GetJson,
  ecrire: Ecrire,
  configured: (id: ServiceId) => boolean,
  listes: ListesEnMemoire,
  purger: (texte: string) => string = (t) => t,
) {
  const absent = (reply: { code: (n: number) => { send: (o: unknown) => unknown } }) =>
    reply.code(404).send({ error: "Overseerr n'est pas configuré" });

  /** Titres de la bibliothèque, par identifiant TMDB (et TVDB pour les séries). Une panne de Radarr / Sonarr n'empêche rien. */
  async function bibliotheque(): Promise<Bibliotheque> {
    const b: Bibliotheque = { films: new Map(), seriesTmdb: new Map(), seriesTvdb: new Map() };
    const [films, series] = await Promise.allSettled([
      configured("radarr") ? (listes.lire("radarr/movie", () => getJson("radarr", "/movie")) as Promise<Obj[]>) : Promise.resolve([]),
      configured("sonarr") ? (listes.lire("sonarr/series", () => getJson("sonarr", "/series")) as Promise<Obj[]>) : Promise.resolve([]),
    ]);
    if (films.status === "fulfilled") {
      for (const m of films.value) if (num(m.tmdbId) > 0) b.films.set(num(m.tmdbId), m.hasFile ? "disponible" : "bibliotheque");
    }
    if (series.status === "fulfilled") {
      for (const s of series.value) {
        const total = num(s.statistics?.episodeCount);
        const fichiers = num(s.statistics?.episodeFileCount);
        const st: StatutTitre = fichiers === 0 ? "bibliotheque" : total > 0 && fichiers >= total ? "disponible" : "partiel";
        if (num(s.tmdbId) > 0) b.seriesTmdb.set(num(s.tmdbId), st);
        if (num(s.tvdbId) > 0) b.seriesTvdb.set(num(s.tvdbId), st);
      }
    }
    return b;
  }

  function statutDe(type: TypeTitre, tmdbId: number, mediaInfo: Obj | undefined, lib: Bibliotheque): StatutTitre {
    const overseerr = statutOverseerr(num(mediaInfo?.status));
    const local = type === "film" ? lib.films.get(tmdbId) : lib.seriesTmdb.get(tmdbId) ?? lib.seriesTvdb.get(num(mediaInfo?.tvdbId));
    return meilleur(overseerr, local ?? null);
  }

  /** Un résultat Overseerr (film, série ou personne) sous la forme d'une carte ; null pour une personne. */
  function carte(r: Obj, lib: Bibliotheque) {
    if (r.mediaType !== "movie" && r.mediaType !== "tv") return null;
    const type: TypeTitre = r.mediaType === "tv" ? "serie" : "film";
    const date = str(type === "film" ? r.releaseDate : r.firstAirDate);
    return {
      type,
      tmdbId: num(r.id),
      titre: str(type === "film" ? r.title : r.name) || "Titre inconnu",
      annee: Number(date.slice(0, 4)) || null,
      note: num(r.voteAverage) > 0 ? Math.round(num(r.voteAverage) * 10) / 10 : null,
      affiche: affiche(r.posterPath),
      synopsis: str(r.overview),
      statut: statutDe(type, num(r.id), r.mediaInfo, lib),
    };
  }

  async function lireListe(chemin: string, defaut: TypeTitre | null) {
    const r = (await getJson("overseerr", chemin, { timeoutMs: 30_000 })) as Obj;
    const lib = await bibliotheque();
    const items = (Array.isArray(r.results) ? (r.results as Obj[]) : [])
      // Les listes /discover/movies et /discover/tv n'indiquent pas toujours mediaType.
      .map((x) => carte(defaut && !x.mediaType ? { ...x, mediaType: defaut === "film" ? "movie" : "tv" } : x, lib))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { page: num(r.page) || 1, pages: num(r.totalPages) || 1, items };
  }

  const erreur502 = (reply: { code: (n: number) => { send: (o: unknown) => unknown } }, e: unknown) =>
    reply.code(502).send({ error: e instanceof Error ? e.message : "Overseerr injoignable" });

  // Une rangée (tendances, populaires, à venir) ou une liste filtrée (type + genre + année).
  app.get("/api/decouvrir/liste", async (req, reply) => {
    if (!configured("overseerr")) return absent(reply);
    const q = req.query as { rangee?: string; type?: string; genre?: string; annee?: string; page?: string };
    const page = Math.min(500, Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1));
    if (q.genre !== undefined && !/^\d{1,6}$/.test(q.genre)) return reply.code(400).send({ error: "Genre invalide" });
    if (q.annee !== undefined && !/^(19|20)\d{2}$/.test(q.annee)) return reply.code(400).send({ error: "Année invalide" });
    try {
      if (q.rangee !== undefined) {
        const rangee = RANGEES[q.rangee];
        if (!rangee) return reply.code(400).send({ error: "Rangée inconnue" });
        return await lireListe(`${rangee.chemin}?page=${page}&language=fr`, rangee.type);
      }
      if (q.type !== "film" && q.type !== "serie") return reply.code(400).send({ error: "Choisis Films ou Séries" });
      const film = q.type === "film";
      const filtres = [
        q.genre ? `genre=${q.genre}` : "",
        q.annee ? (film ? `primaryReleaseDateGte=${q.annee}-01-01&primaryReleaseDateLte=${q.annee}-12-31` : `firstAirDateGte=${q.annee}-01-01&firstAirDateLte=${q.annee}-12-31`) : "",
      ].filter(Boolean);
      return await lireListe(`${film ? "/discover/movies" : "/discover/tv"}?page=${page}&language=fr${filtres.length ? `&${filtres.join("&")}` : ""}`, q.type);
    } catch (e) {
      return erreur502(reply, e);
    }
  });

  app.get("/api/decouvrir/genres", async (_req, reply) => {
    if (!configured("overseerr")) return absent(reply);
    try {
      const lire = async (t: "movie" | "tv") =>
        ((await getJson("overseerr", `/genres/${t}?language=fr`)) as Obj[]).map((g) => ({ id: num(g.id), nom: str(g.name) })).filter((g) => g.id > 0 && g.nom);
      const [films, series] = await Promise.all([lire("movie"), lire("tv")]);
      return { films, series };
    } catch (e) {
      return erreur502(reply, e);
    }
  });

  app.get("/api/decouvrir/recherche", async (req, reply) => {
    if (!configured("overseerr")) return absent(reply);
    const t = ((req.query as { q?: string }).q ?? "").trim();
    if (t.length < 2 || t.length > 100) return reply.code(400).send({ error: "Saisis entre 2 et 100 caractères" });
    try {
      return await lireListe(`/search?query=${encodeURIComponent(t)}&page=1&language=fr`, null);
    } catch (e) {
      return erreur502(reply, e);
    }
  });

  /** Fiche détaillée d'un titre. */
  async function fiche(type: TypeTitre, tmdbId: number) {
    const film = type === "film";
    const [f, lib] = await Promise.all([
      getJson("overseerr", `/${film ? "movie" : "tv"}/${tmdbId}?language=fr`, { timeoutMs: 30_000 }) as Promise<Obj>,
      bibliotheque(),
    ]);
    const date = str(film ? f.releaseDate : f.firstAirDate);
    const videos = Array.isArray(f.relatedVideos) ? (f.relatedVideos as Obj[]) : [];
    const bande = videos.find((v) => str(v.site).toLowerCase() === "youtube" && /trailer|bande/i.test(str(v.type)) && /^[\w-]{6,20}$/.test(str(v.key)));
    // Saisons : disponibles / demandées d'après Overseerr (statut par saison + demandes en cours).
    const parSaison = new Map<number, StatutTitre>();
    for (const s of Array.isArray(f.mediaInfo?.seasons) ? (f.mediaInfo.seasons as Obj[]) : []) parSaison.set(num(s.seasonNumber), statutOverseerr(num(s.status)));
    for (const dm of Array.isArray(f.mediaInfo?.requests) ? (f.mediaInfo.requests as Obj[]) : []) {
      if (![1, 2].includes(num(dm.status))) continue; // en attente ou approuvée
      for (const s of Array.isArray(dm.seasons) ? (dm.seasons as Obj[]) : []) parSaison.set(num(s.seasonNumber), meilleur(parSaison.get(num(s.seasonNumber)) ?? null, "demande"));
    }
    return {
      type,
      tmdbId,
      titre: str(film ? f.title : f.name) || "Titre inconnu",
      annee: Number(date.slice(0, 4)) || null,
      note: num(f.voteAverage) > 0 ? Math.round(num(f.voteAverage) * 10) / 10 : null,
      synopsis: str(f.overview),
      genres: (Array.isArray(f.genres) ? (f.genres as Obj[]) : []).map((g) => str(g.name)).filter(Boolean),
      dureeMin: film ? num(f.runtime) || null : null,
      affiche: affiche(f.posterPath),
      distribution: (Array.isArray(f.credits?.cast) ? (f.credits.cast as Obj[]) : []).slice(0, 12).map((c) => ({
        nom: str(c.name),
        role: str(c.character) || null,
        photo: affiche(c.profilePath, "w185"),
      })),
      bandeAnnonce: bande ? `https://www.youtube.com/watch?v=${str(bande.key)}` : null,
      statut: statutDe(type, tmdbId, f.mediaInfo, lib),
      saisons: film
        ? []
        : (Array.isArray(f.seasons) ? (f.seasons as Obj[]) : [])
            .filter((s) => num(s.seasonNumber) > 0)
            .map((s) => ({ numero: num(s.seasonNumber), episodes: num(s.episodeCount), statut: parSaison.get(num(s.seasonNumber)) ?? null })),
    };
  }

  app.get("/api/decouvrir/fiche/:type/:id", async (req, reply) => {
    if (!configured("overseerr")) return absent(reply);
    const { type, id } = req.params as { type: string; id: string };
    if ((type !== "film" && type !== "serie") || !/^\d{1,9}$/.test(id)) return reply.code(400).send({ error: "Titre invalide" });
    try {
      return await fiche(type, Number(id));
    } catch (e) {
      const introuvable = e instanceof Error && /HTTP 404/.test(e.message);
      return introuvable ? reply.code(404).send({ error: "Titre introuvable chez Overseerr" }) : erreur502(reply, e);
    }
  });

  // Crée une demande Overseerr. Refusée AVANT l'envoi si le titre (ou toutes les saisons choisies) est déjà disponible ou demandé.
  app.post("/api/decouvrir/demander", async (req, reply) => {
    if (!configured("overseerr")) return absent(reply);
    const b = lireJson(req.body);
    if (!b || (b.type !== "film" && b.type !== "serie") || !Number.isInteger(b.tmdbId) || (b.tmdbId as number) <= 0) {
      return reply.code(400).send({ error: "Demande invalide" });
    }
    const type = b.type as TypeTitre;
    const tmdbId = b.tmdbId as number;
    let saisons: number[] = [];
    if (type === "serie") {
      saisons = [...new Set(Array.isArray(b.saisons) ? (b.saisons as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 1000) : [])];
      if (saisons.length === 0) return reply.code(400).send({ error: "Choisis au moins une saison" });
    }
    try {
      const f = await fiche(type, tmdbId);
      if (type === "film" && f.statut) {
        const raison = f.statut === "demande" ? "déjà demandé" : f.statut === "bibliotheque" ? "déjà dans la bibliothèque" : "déjà disponible";
        return reply.code(409).send({ error: `${f.titre} est ${raison}.` });
      }
      if (type === "serie") {
        const bloquees = new Set(f.saisons.filter((s) => s.statut !== null).map((s) => s.numero));
        // Série entièrement présente dans la bibliothèque sans détail par saison : rien à demander.
        const aDemander = saisons.filter((n) => !bloquees.has(n));
        if (aDemander.length === 0) return reply.code(409).send({ error: `${f.titre} : les saisons choisies sont déjà disponibles ou demandées.` });
        saisons = aDemander;
      }
      const res = await ecrire("overseerr", "POST", "/request", {
        mediaType: type === "film" ? "movie" : "tv",
        mediaId: tmdbId,
        is4k: false,
        ...(type === "serie" ? { seasons: saisons } : {}),
      });
      if (res.status === 403) return reply.code(403).send({ error: "Cette clé API n'a pas le droit de créer des demandes" });
      if (res.status === 409) return reply.code(409).send({ error: "Ce titre est déjà demandé." });
      if (!res.ok) {
        const texte = purger((await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
        let message = texte;
        try {
          message = str(JSON.parse(texte).message) || texte;
        } catch {
          /* texte brut */
        }
        return reply.code(502).send({ error: `Overseerr a refusé la demande${message ? ` : ${message}` : ` (HTTP ${res.status})`}` });
      }
      return { ok: true, titre: f.titre, saisons };
    } catch (e) {
      return erreur502(reply, e);
    }
  });
}

// Statistiques de la médiathèque : calculées côté serveur (une seule lecture des listes Radarr / Sonarr),
// gardées quelques minutes pour que l'écran Stats et le widget Genres de l'accueil ne les recalculent pas.
import type { FastifyInstance } from "fastify";
import type { GetJson } from "./lecture.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TTL_MS = 5 * 60_000;

/** Genres TMDB / TheTVDB (anglais) → français. Un genre inconnu reste tel quel. */
const GENRES_FR: Record<string, string> = {
  action: "Action", adventure: "Aventure", animation: "Animation", comedy: "Comédie", crime: "Policier",
  documentary: "Documentaire", drama: "Drame", family: "Famille", fantasy: "Fantastique", history: "Histoire",
  horror: "Horreur", music: "Musique", musical: "Comédie musicale", mystery: "Mystère", romance: "Romance",
  "science fiction": "Science-fiction", "sci-fi": "Science-fiction", "sci-fi & fantasy": "Science-fiction et fantastique",
  thriller: "Thriller", "tv movie": "Téléfilm", war: "Guerre", western: "Western", kids: "Enfants",
  news: "Actualités", reality: "Téléréalité", soap: "Feuilleton", talk: "Débat", "action & adventure": "Action et aventure",
  "war & politics": "Guerre et politique", biography: "Biographie", sport: "Sport", "game show": "Jeu télévisé",
  "reality-tv": "Téléréalité", "mini-series": "Mini-série", suspense: "Suspense", "talk show": "Débat", "home and garden": "Maison et jardin",
};

export const genreFr = (g: string) => GENRES_FR[g.trim().toLowerCase()] ?? g.trim();

export interface Statistiques {
  calculeA: string;
  apercu: {
    films: { total: number; disponibles: number } | null;
    series: { total: number; episodes: number; episodesTotal: number } | null;
  };
  stockage: { total: number; parts: { nom: string; octets: number }[] };
  croissance: { points: { mois: string; ajouts: number; total: number }[]; ajoutsPeriode: number; debut: string; fin: string };
  genres: { nom: string; total: number }[];
  decennies: { decennie: number; total: number; pct: number }[];
  profils: { nom: string; total: number; pct: number }[];
  erreurs: string[];
}

/** Les 12 derniers mois (le mois en cours inclus), du plus ancien au plus récent : « 2025-11 » … « 2026-10 ». */
export function derniersMois(maintenant: Date, n = 12): string[] {
  const mois: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - i, 1));
    mois.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return mois;
}

export function calculer(
  films: Obj[] | null,
  series: Obj[] | null,
  profilsParService: { radarr: Map<number, string>; sonarr: Map<number, string> },
  maintenant = new Date(),
): Omit<Statistiques, "erreurs"> {
  const tous = [
    ...(films ?? []).map((m) => ({ m, service: "radarr" as const })),
    ...(series ?? []).map((m) => ({ m, service: "sonarr" as const })),
  ];

  // Genres
  const genres = new Map<string, number>();
  for (const { m } of tous) {
    for (const g of Array.isArray(m.genres) ? m.genres : []) {
      if (typeof g === "string" && g.trim()) genres.set(genreFr(g), (genres.get(genreFr(g)) ?? 0) + 1);
    }
  }

  // Décennies
  const decennies = new Map<number, number>();
  for (const { m } of tous) {
    const annee = num(m.year);
    if (annee >= 1880 && annee <= 2100) decennies.set(Math.floor(annee / 10) * 10, (decennies.get(Math.floor(annee / 10) * 10) ?? 0) + 1);
  }
  const totalDecennies = [...decennies.values()].reduce((a, b) => a + b, 0);

  // Profils de qualité (noms réels des profils, regroupés d'un service à l'autre)
  const profils = new Map<string, number>();
  for (const { m, service } of tous) {
    const nom = profilsParService[service].get(num(m.qualityProfileId));
    if (nom) profils.set(nom, (profils.get(nom) ?? 0) + 1);
  }
  const totalProfils = [...profils.values()].reduce((a, b) => a + b, 0);

  // Croissance : ajouts par mois sur 12 mois, et total cumulé (les titres plus anciens forment le socle).
  const mois = derniersMois(maintenant);
  const ajoutsParMois = new Map<string, number>(mois.map((k) => [k, 0]));
  let avant = 0;
  for (const { m } of tous) {
    const cle = str(m.added).slice(0, 7);
    if (!cle) {
      avant++; // pas de date d'ajout : on le compte dans le socle plutôt que de l'inventer
    } else if (cle < mois[0]) {
      avant++;
    } else if (ajoutsParMois.has(cle)) {
      ajoutsParMois.set(cle, (ajoutsParMois.get(cle) ?? 0) + 1);
    }
  }
  let cumul = avant;
  const points = mois.map((k) => {
    cumul += ajoutsParMois.get(k) ?? 0;
    return { mois: k, ajouts: ajoutsParMois.get(k) ?? 0, total: cumul };
  });

  const taille = (liste: Obj[] | null, f: (m: Obj) => number) => (liste ?? []).reduce((n, m) => n + f(m), 0);
  const octetsFilms = taille(films, (m) => num(m.sizeOnDisk));
  const octetsSeries = taille(series, (m) => num(m.statistics?.sizeOnDisk));
  const parts = [
    ...(series ? [{ nom: "Sonarr", octets: octetsSeries }] : []),
    ...(films ? [{ nom: "Radarr", octets: octetsFilms }] : []),
  ].filter((p) => p.octets > 0);

  return {
    calculeA: maintenant.toISOString(),
    apercu: {
      films: films ? { total: films.length, disponibles: films.filter((m) => m.hasFile).length } : null,
      series: series
        ? {
            total: series.length,
            episodes: taille(series, (m) => num(m.statistics?.episodeFileCount)),
            episodesTotal: taille(series, (m) => num(m.statistics?.episodeCount)),
          }
        : null,
    },
    stockage: { total: parts.reduce((n, p) => n + p.octets, 0), parts },
    croissance: {
      points,
      ajoutsPeriode: points.reduce((n, p) => n + p.ajouts, 0),
      debut: mois[0],
      fin: mois[mois.length - 1],
    },
    genres: [...genres.entries()].map(([nom, total]) => ({ nom, total })).sort((a, b) => b.total - a.total || a.nom.localeCompare(b.nom, "fr")).slice(0, 12),
    decennies: [...decennies.entries()]
      .map(([decennie, total]) => ({ decennie, total, pct: totalDecennies ? total / totalDecennies : 0 }))
      .sort((a, b) => b.decennie - a.decennie),
    profils: [...profils.entries()]
      .map(([nom, total]) => ({ nom, total, pct: totalProfils ? total / totalProfils : 0 }))
      .sort((a, b) => b.total - a.total || a.nom.localeCompare(b.nom, "fr")),
  };
}

export function registerStats(app: FastifyInstance, getJson: GetJson, configured: (id: ServiceId) => boolean) {
  let memo: { at: number; valeur: Promise<Statistiques> } | null = null;

  async function calculerTout(): Promise<Statistiques> {
    const lire = async (id: "radarr" | "sonarr", chemin: string) => (configured(id) ? ((await getJson(id, chemin, { timeoutMs: 60000 })) as Obj[]) : null);
    const [films, series, pf, ps] = await Promise.allSettled([
      lire("radarr", "/movie"), lire("sonarr", "/series"), lire("radarr", "/qualityprofile"), lire("sonarr", "/qualityprofile"),
    ]);
    const val = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
    const noms = (r: Obj[] | null) => new Map<number, string>((r ?? []).map((p) => [num(p.id), str(p.name)]));
    const erreurs = [
      ...(films.status === "rejected" ? ["Radarr injoignable"] : []),
      ...(series.status === "rejected" ? ["Sonarr injoignable"] : []),
    ];
    return {
      ...calculer(val(films), val(series), { radarr: noms(val(pf)), sonarr: noms(val(ps)) }),
      erreurs,
    };
  }

  app.get("/api/stats", async (_req, reply) => {
    if (!configured("radarr") && !configured("sonarr")) {
      return reply.code(404).send({ error: "Radarr et Sonarr ne sont pas configurés" });
    }
    if (!memo || Date.now() - memo.at > TTL_MS) {
      const valeur = calculerTout();
      memo = { at: Date.now(), valeur };
      valeur.catch(() => (memo = null));
    }
    return memo.valeur;
  });

  return { vider: () => (memo = null) };
}

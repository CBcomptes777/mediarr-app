// Logique pure de la recherche manuelle (sans React ni navigateur) : couleur des seeders, tri, message « tout est
// rejeté », préférence mémorisée. Testée par server/npm test (../web/src/releasesLogique.test.ts).
import type { Release } from "./api";

export type Tri = "seeders" | "taille" | "age" | "qualite" | "score";

export const TRIS: { code: Tri; libelle: string }[] = [
  { code: "seeders", libelle: "Seeders" },
  { code: "taille", libelle: "Taille" },
  { code: "age", libelle: "Âge" },
  { code: "qualite", libelle: "Qualité" },
  { code: "score", libelle: "Score" },
];

export type ClasseSeeders = "vert" | "orange" | "rouge" | "rouge-vif";

/** ≥ 50 vert, 5 à 49 orange, 1 à 4 rouge, 0 rouge vif (« Aucun seed »). */
export function classeSeeders(seeders: number): ClasseSeeders {
  if (seeders <= 0) return "rouge-vif";
  if (seeders < 5) return "rouge";
  if (seeders < 50) return "orange";
  return "vert";
}

/** Texte du badge de seeders : « ▲ 735 », ou « Aucun seed » quand il n'y en a aucun. */
export const texteSeeders = (seeders: number) => (seeders <= 0 ? "Aucun seed" : `▲ ${seeders}`);

/**
 * Valeur de tri des seeders. Une release Usenet n'a pas de seeders (null) : elle se range entre les torrents « corrects »
 * (5 seeders ou plus) et les torrents presque morts, plutôt qu'avec les « 0 seed ».
 */
export const cleSeeders = (r: Release) => (r.seeders === null ? 4.5 : r.seeders);

/** Acceptées d'abord, puis le critère choisi (décroissant sauf l'âge : les plus récentes d'abord). Ne modifie pas la liste. */
export function trier(items: Release[], tri: Tri): Release[] {
  const critere: Record<Tri, (a: Release, b: Release) => number> = {
    seeders: (a, b) => cleSeeders(b) - cleSeeders(a) || b.rang - a.rang || b.tailleOctets - a.tailleOctets,
    taille: (a, b) => b.tailleOctets - a.tailleOctets || cleSeeders(b) - cleSeeders(a),
    age: (a, b) => a.ageMinutes - b.ageMinutes || cleSeeders(b) - cleSeeders(a),
    qualite: (a, b) => b.rang - a.rang || cleSeeders(b) - cleSeeders(a) || b.tailleOctets - a.tailleOctets,
    score: (a, b) => (b.score ?? 0) - (a.score ?? 0) || b.rang - a.rang || cleSeeders(b) - cleSeeders(a),
  };
  return [...items].sort((a, b) => Number(a.rejete) - Number(b.rejete) || critere[tri](a, b));
}

/** La raison de rejet qui revient le plus souvent (la première en cas d'égalité), avec son nombre. */
export function raisonLaPlusFrequente(items: Release[]): { raison: string; n: number } | null {
  const comptes = new Map<string, number>();
  for (const r of items) if (r.rejete) for (const raison of r.raisons) comptes.set(raison, (comptes.get(raison) ?? 0) + 1);
  let meilleure: { raison: string; n: number } | null = null;
  for (const [raison, n] of comptes) if (!meilleure || n > meilleure.n) meilleure = { raison, n };
  return meilleure;
}

/** « Tout est rejeté : … » quand il y a des résultats et qu'AUCUN n'est accepté ; null sinon. */
export function messageToutRejete(items: Release[]): string | null {
  if (items.length === 0 || !items.every((r) => r.rejete)) return null;
  const f = raisonLaPlusFrequente(items);
  if (!f) return "Tout est rejeté par le service.";
  return `Tout est rejeté : ${f.raison.charAt(0).toLowerCase()}${f.raison.slice(1)}.`;
}

// ---------- « Masquer les résultats rejetés » : coché par défaut, mémorisé ----------

export const CLE_MASQUER_REJETEES = "mediarr_releases_masquer_rejetees";
type Lecture = { getItem(cle: string): string | null };
type Ecriture = { setItem(cle: string, valeur: string): void };

/** Vrai tant que rien n'est mémorisé (ou si le stockage est inaccessible) ; faux seulement si on l'a décoché. */
export function lireMasquerRejetees(stockage?: Lecture): boolean {
  try {
    const v = stockage?.getItem(CLE_MASQUER_REJETEES);
    return v === null || v === undefined ? true : v !== "0";
  } catch {
    return true;
  }
}

export function ecrireMasquerRejetees(stockage: Ecriture | undefined, valeur: boolean): void {
  try {
    stockage?.setItem(CLE_MASQUER_REJETEES, valeur ? "1" : "0");
  } catch {
    /* facultatif : le choix vaut alors pour cette session seulement */
  }
}

// ---------- filtres de la recherche (Langue, Indexeur, Résolution, Protocole, Seeders minimum) ----------

export interface FiltresReleases {
  langues: string[];
  indexeurs: string[];
  /** 2160, 1080, 720, 480 ; 0 = résolution inconnue. */
  resolutions: number[];
  protocoles: ("torrent" | "usenet")[];
  /** Un résultat Usenet (sans seeders) n'est jamais écarté par ce seuil. */
  seedersMin: number;
}
export const FILTRES_REL_VIDES: FiltresReleases = { langues: [], indexeurs: [], resolutions: [], protocoles: [], seedersMin: 0 };

export type Filtrable = Pick<Release, "indexeur" | "langues" | "protocole" | "seeders"> & { resolution?: number | null };

export const nbFiltresReleases = (f: FiltresReleases) =>
  [f.langues, f.indexeurs, f.resolutions, f.protocoles].filter((g) => g.length > 0).length + (f.seedersMin > 0 ? 1 : 0);

/** Garde ce qui passe TOUS les groupes ; dans un groupe, un seul choix suffit. */
export function filtrerReleases<T extends Filtrable>(items: T[], f: FiltresReleases): T[] {
  return items.filter(
    (r) =>
      (!f.langues.length || r.langues.some((l) => f.langues.includes(l))) &&
      (!f.indexeurs.length || f.indexeurs.includes(r.indexeur)) &&
      (!f.resolutions.length || f.resolutions.includes(r.resolution ?? 0)) &&
      (!f.protocoles.length || f.protocoles.includes(r.protocole)) &&
      (f.seedersMin <= 0 || r.seeders === null || r.seeders >= f.seedersMin),
  );
}

const collator = new Intl.Collator("fr", { sensitivity: "base" });

/** Indexeurs présents avec leur nombre de résultats (du plus fourni au moins fourni). */
export function comptesIndexeurs(items: Pick<Release, "indexeur">[]): { nom: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of items) if (r.indexeur) m.set(r.indexeur, (m.get(r.indexeur) ?? 0) + 1);
  return [...m.entries()].map(([nom, n]) => ({ nom, n })).sort((a, b) => b.n - a.n || collator.compare(a.nom, b.nom));
}

export function languesPresentes(items: Pick<Release, "langues">[]): string[] {
  return [...new Set(items.flatMap((r) => r.langues))].sort(collator.compare);
}

/** Résolutions présentes, de la plus haute à la plus basse (0 = inconnue, en dernier). */
export function resolutionsPresentes(items: { resolution?: number | null }[]): number[] {
  return [...new Set(items.map((r) => r.resolution ?? 0))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : b - a));
}
export const libelleResolution = (r: number) => (r === 0 ? "Autre" : r >= 2160 ? "4K · 2160p" : `${r}p`);

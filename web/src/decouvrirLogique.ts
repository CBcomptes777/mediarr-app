// Logique pure de « Découvrir » (filtres, fusion des pages, statuts) : sans React ni navigateur, testée par server/npm test
// (../web/src/decouvrirLogique.test.ts).

export type StatutTitre = "disponible" | "partiel" | "demande" | "bibliotheque" | null;
export type TypeTitre = "film" | "serie";

export interface CarteTitre {
  type: TypeTitre;
  tmdbId: number;
  titre: string;
  annee: number | null;
  note: number | null;
  affiche: string | null;
  synopsis: string;
  statut: StatutTitre;
}

export interface ReglageDecouvrir {
  type: "tout" | TypeTitre;
  genre: number | null;
  annee: number | null;
  /** Cache ce qui est déjà disponible, partiellement disponible ou dans la bibliothèque. */
  masquerPossedes: boolean;
}
export const REGLAGE_DECOUVRIR_DEFAUT: ReglageDecouvrir = { type: "tout", genre: null, annee: null, masquerPossedes: false };

export const LIBELLE_STATUT: Record<NonNullable<StatutTitre>, string> = {
  disponible: "Disponible ✓",
  partiel: "Partiellement disponible",
  demande: "Demandé",
  bibliotheque: "Dans la bibliothèque",
};

/** Un titre sur lequel on ne peut plus rien demander (film). Pour une série, le détail se joue saison par saison. */
export const dejaPris = (s: StatutTitre) => s !== null;

export const cleCarte = (c: Pick<CarteTitre, "type" | "tmdbId">) => `${c.type}:${c.tmdbId}`;

/** Ajoute une page de résultats à ceux déjà reçus, sans doublon (Overseerr en répète parfois d'une page à l'autre). */
export function fusionner(existants: CarteTitre[], nouveaux: CarteTitre[]): CarteTitre[] {
  const vus = new Set(existants.map(cleCarte));
  return [...existants, ...nouveaux.filter((n) => !vus.has(cleCarte(n)))];
}

/**
 * Cartes à afficher d'après les réglages. `surcharges` = titres qu'on vient de demander (statut « Demandé » tout de suite,
 * sans attendre que la liste soit rechargée).
 */
export function visibles(cartes: CarteTitre[], r: ReglageDecouvrir, surcharges: ReadonlyMap<string, StatutTitre> = new Map()): CarteTitre[] {
  return cartes
    .map((c) => (surcharges.has(cleCarte(c)) ? { ...c, statut: surcharges.get(cleCarte(c)) ?? c.statut } : c))
    .filter(
      (c) =>
        (r.type === "tout" || c.type === r.type) &&
        !(r.masquerPossedes && (c.statut === "disponible" || c.statut === "partiel" || c.statut === "bibliotheque")),
    );
}

/** Les 30 dernières années, de la plus récente à la plus ancienne (+ l'année prochaine pour les sorties annoncées). */
export function anneesProposees(annee: number): number[] {
  return Array.from({ length: 32 }, (_, i) => annee + 1 - i);
}

// ---------- mémorisation ----------

export const CLE_DECOUVRIR = "mediarr_decouvrir_reglage";
type Lecture = Pick<Storage, "getItem">;
type Ecriture = Pick<Storage, "setItem"> | undefined;

export function nettoyerReglageDecouvrir(brut: unknown): ReglageDecouvrir {
  const o = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const type = o.type === "film" || o.type === "serie" ? o.type : "tout";
  const genre = Number.isInteger(o.genre) && (o.genre as number) > 0 ? (o.genre as number) : null;
  const annee = Number.isInteger(o.annee) && (o.annee as number) >= 1900 && (o.annee as number) <= 2100 ? (o.annee as number) : null;
  // Un genre n'a de sens que pour un type précis (les genres des films et des séries diffèrent).
  return { type, genre: type === "tout" ? null : genre, annee: type === "tout" ? null : annee, masquerPossedes: o.masquerPossedes === true };
}
export function lireReglageDecouvrir(stockage?: Lecture): ReglageDecouvrir {
  try {
    const brut = stockage?.getItem(CLE_DECOUVRIR);
    return nettoyerReglageDecouvrir(brut ? JSON.parse(brut) : {});
  } catch {
    return { ...REGLAGE_DECOUVRIR_DEFAUT };
  }
}
export function ecrireReglageDecouvrir(stockage: Ecriture, r: ReglageDecouvrir): void {
  try {
    stockage?.setItem(CLE_DECOUVRIR, JSON.stringify(r));
  } catch {
    /* facultatif */
  }
}

// Logique pure de la bibliothèque (filtres, tri, options) : sans React ni navigateur, testée par server/npm test
// (../web/src/bibliothequeLogique.test.ts). Tout se calcule côté client sur la liste déjà chargée.
import type { ResumeMedia, TypeMedia } from "./api";

export type StatutFiltre = "complet" | "partiel" | "manquant" | "avenir" | "enCours" | "termine";
export type CleTri = "titre" | "annee" | "ajout" | "sortie" | "taille" | "note";

export interface Filtres {
  recherche: string;
  types: TypeMedia[];
  statuts: StatutFiltre[];
  suivi: "tous" | "oui" | "non";
  services: string[];
  genres: string[];
  decennies: number[];
  profils: string[];
  langues: string[];
  studios: string[];
}
export interface Tri {
  cle: CleTri;
  desc: boolean;
}
export interface Reglage {
  filtres: Filtres;
  tri: Tri;
}

export const FILTRES_VIDES: Filtres = {
  recherche: "", types: [], statuts: [], suivi: "tous", services: [], genres: [], decennies: [], profils: [], langues: [], studios: [],
};
export const TRI_DEFAUT: Tri = { cle: "titre", desc: false };

export const STATUTS: { id: StatutFiltre; libelle: string }[] = [
  { id: "complet", libelle: "Complet" },
  { id: "partiel", libelle: "Partiel" },
  { id: "manquant", libelle: "Manquant" },
  { id: "avenir", libelle: "À venir" },
  { id: "enCours", libelle: "En cours (série)" },
  { id: "termine", libelle: "Terminée (série)" },
];
export const TRIS_BIBLIO: { id: CleTri; libelle: string }[] = [
  { id: "titre", libelle: "Titre" },
  { id: "annee", libelle: "Année" },
  { id: "ajout", libelle: "Date d'ajout" },
  { id: "sortie", libelle: "Dernière sortie / prochain épisode" },
  { id: "taille", libelle: "Taille sur disque" },
  { id: "note", libelle: "Note" },
];
export const NOM_SERVICE = { film: "Radarr", serie: "Sonarr" } as const;

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const sansAccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const decennie = (annee: number) => Math.floor(annee / 10) * 10;

/** Nombre de groupes de filtres actifs (la recherche texte n'est pas comptée : elle a son propre champ). */
export function nbFiltresActifs(f: Filtres): number {
  return [f.types, f.statuts, f.services, f.genres, f.decennies, f.profils, f.langues, f.studios].filter((g) => g.length > 0).length + (f.suivi !== "tous" ? 1 : 0);
}

function correspondStatut(m: ResumeMedia, s: StatutFiltre): boolean {
  if (s === "complet" || s === "partiel" || s === "manquant") return m.etat === s;
  return m.statut === s;
}

/** Garde les titres qui passent TOUS les groupes de filtres ; à l'intérieur d'un groupe, un seul choix suffit (OU). */
export function filtrer(items: ResumeMedia[], f: Filtres): ResumeMedia[] {
  const q = sansAccent(f.recherche.trim());
  return items.filter((m) => {
    if (q && !sansAccent(m.titre).includes(q)) return false;
    if (f.types.length && !f.types.includes(m.type)) return false;
    if (f.services.length && !f.services.includes(NOM_SERVICE[m.type])) return false;
    if (f.statuts.length && !f.statuts.some((s) => correspondStatut(m, s))) return false;
    if (f.suivi !== "tous" && m.suivi !== (f.suivi === "oui")) return false;
    if (f.genres.length && !f.genres.some((g) => m.genres.includes(g))) return false;
    if (f.decennies.length && !(m.annee !== null && f.decennies.includes(decennie(m.annee)))) return false;
    if (f.profils.length && !(m.profil !== null && f.profils.includes(m.profil))) return false;
    if (f.langues.length && !(m.langue !== null && f.langues.includes(m.langue))) return false;
    if (f.studios.length && !(m.studio !== null && f.studios.includes(m.studio))) return false;
    return true;
  });
}

function valeurTri(m: ResumeMedia, cle: CleTri): number | string | null {
  switch (cle) {
    case "titre": return m.titre;
    case "annee": return m.annee;
    case "ajout": return m.ajoute ? Date.parse(m.ajoute) || null : null;
    case "sortie": return m.sortie ? Date.parse(m.sortie) || null : null;
    case "taille": return m.tailleOctets > 0 ? m.tailleOctets : null;
    case "note": return m.noteValeur;
  }
}

/** Tri stable ; les titres sans valeur (pas de note, pas de date…) restent TOUJOURS à la fin, quel que soit le sens. */
export function trier(items: ResumeMedia[], tri: Tri): ResumeMedia[] {
  const sens = tri.desc ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = valeurTri(a, tri.cle);
    const vb = valeurTri(b, tri.cle);
    if (va === null && vb === null) return collator.compare(a.titre, b.titre);
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "string" ? collator.compare(va, vb as string) : va - (vb as number);
    return c !== 0 ? c * sens : collator.compare(a.titre, b.titre);
  });
}

export interface OptionsFiltres {
  genres: string[];
  decennies: number[];
  profils: string[];
  langues: string[];
  studios: string[];
}

/** Les choix proposés dans le menu : seulement ce qui existe dans la liste affichée. */
export function optionsDe(items: ResumeMedia[]): OptionsFiltres {
  const uniques = (valeurs: (string | null)[]) => [...new Set(valeurs.filter((v): v is string => Boolean(v)))].sort(collator.compare);
  return {
    genres: uniques(items.flatMap((m) => m.genres)),
    decennies: [...new Set(items.flatMap((m) => (m.annee !== null ? [decennie(m.annee)] : [])))].sort((a, b) => b - a),
    profils: uniques(items.map((m) => m.profil)),
    langues: uniques(items.map((m) => m.langue)),
    studios: uniques(items.map((m) => m.studio)),
  };
}

// ---------- mémorisation entre les visites ----------

export const CLE_BIBLIO = "mediarr_biblio_reglage";
type Lecture = Pick<Storage, "getItem">;
type Ecriture = Pick<Storage, "setItem"> | undefined;

const listeDe = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok).slice(0, 80) : []);
const estTexte = (x: unknown): x is string => typeof x === "string" && x.length <= 120;

/** Remet en forme un réglage lu (localStorage ou filtre enregistré) : tout champ absent ou invalide retombe sur la valeur par défaut. */
export function nettoyerReglage(brut: unknown): Reglage {
  const o = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const f = (o.filtres && typeof o.filtres === "object" ? o.filtres : {}) as Record<string, unknown>;
  const t = (o.tri && typeof o.tri === "object" ? o.tri : {}) as Record<string, unknown>;
  const statutsOk = STATUTS.map((s) => s.id) as string[];
  return {
    filtres: {
      recherche: typeof f.recherche === "string" ? f.recherche.slice(0, 100) : "",
      types: listeDe(f.types, (x): x is TypeMedia => x === "film" || x === "serie"),
      statuts: listeDe(f.statuts, (x): x is StatutFiltre => typeof x === "string" && statutsOk.includes(x)),
      suivi: f.suivi === "oui" || f.suivi === "non" ? f.suivi : "tous",
      services: listeDe(f.services, estTexte),
      genres: listeDe(f.genres, estTexte),
      decennies: listeDe(f.decennies, (x): x is number => Number.isInteger(x) && (x as number) >= 1800 && (x as number) <= 2100),
      profils: listeDe(f.profils, estTexte),
      langues: listeDe(f.langues, estTexte),
      studios: listeDe(f.studios, estTexte),
    },
    tri: {
      cle: TRIS_BIBLIO.some((x) => x.id === t.cle) ? (t.cle as CleTri) : TRI_DEFAUT.cle,
      desc: t.desc === true,
    },
  };
}

export function lireReglage(stockage?: Lecture): Reglage {
  try {
    const brut = stockage?.getItem(CLE_BIBLIO);
    return nettoyerReglage(brut ? JSON.parse(brut) : {});
  } catch {
    return nettoyerReglage({});
  }
}

export function ecrireReglage(stockage: Ecriture, r: Reglage): void {
  try {
    stockage?.setItem(CLE_BIBLIO, JSON.stringify(r));
  } catch {
    /* facultatif : mode privé, stockage plein… */
  }
}

// Logique pure du calendrier (grilles, statuts, filtres, tri) : sans React ni navigateur, testée par server/npm test
// (../web/src/calendrierLogique.test.ts).
import type { ItemCalendrier, TypeMedia } from "./api";

export type Vue = "mois" | "semaine" | "liste";
export type StatutCal = "disponible" | "telechargement" | "manquant" | "avenir";
export type TriCal = "date" | "titre" | "service";

export interface FiltresCal {
  types: TypeMedia[];
  statuts: StatutCal[];
  suivi: "tous" | "oui" | "non";
}
export interface ReglageCal {
  vue: Vue;
  filtres: FiltresCal;
  tri: TriCal;
}

export const FILTRES_CAL_VIDES: FiltresCal = { types: [], statuts: [], suivi: "tous" };
export const REGLAGE_CAL_DEFAUT: ReglageCal = { vue: "semaine", filtres: FILTRES_CAL_VIDES, tri: "date" };
export const STATUTS_CAL: { id: StatutCal; libelle: string }[] = [
  { id: "disponible", libelle: "Disponible" },
  { id: "telechargement", libelle: "Téléchargement en cours" },
  { id: "manquant", libelle: "Manquant" },
  { id: "avenir", libelle: "À venir" },
];
export const TRIS_CAL: { id: TriCal; libelle: string }[] = [
  { id: "date", libelle: "Date" },
  { id: "titre", libelle: "Titre" },
  { id: "service", libelle: "Service" },
];

const pad = (n: number) => String(n).padStart(2, "0");
export const cle = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Midi local : évite tout décalage au changement d'heure. */
export const depuisCle = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};
export const plusJours = (k: string, n: number) => {
  const d = depuisCle(k);
  d.setDate(d.getDate() + n);
  return cle(d);
};
/** Lundi de la semaine qui contient ce jour. */
export const lundiDe = (k: string) => plusJours(k, -((depuisCle(k).getDay() + 6) % 7));

/** Jour d'un élément : local pour un épisode (heure UTC connue), tel quel pour une sortie de film. */
export const jourDe = (i: Pick<ItemCalendrier, "date" | "heure">) => (i.heure ? cle(new Date(i.date)) : i.date.slice(0, 10));

/** Statut d'un élément : disponible, téléchargement en cours, manquant (date passée sans fichier) ou à venir. */
export function statutDe(i: ItemCalendrier, maintenant: Date): StatutCal {
  if (i.disponible) return "disponible";
  if (i.enTelechargement) return "telechargement";
  const passe = i.heure ? new Date(i.date) < maintenant : i.date.slice(0, 10) < cle(maintenant);
  return passe ? "manquant" : "avenir";
}

export const service = (i: Pick<ItemCalendrier, "type">) => (i.type === "film" ? "Radarr" : "Sonarr");

/** Jours affichés (clés) selon la vue, avec `decalage` périodes avant/après aujourd'hui. */
export function joursDeVue(vue: Vue, decalage: number, aujourdhui: string): string[] {
  if (vue === "semaine") {
    const l = plusJours(lundiDe(aujourdhui), decalage * 7);
    return Array.from({ length: 7 }, (_, i) => plusJours(l, i));
  }
  if (vue === "liste") {
    const debut = plusJours(aujourdhui, decalage * 30);
    return Array.from({ length: 30 }, (_, i) => plusJours(debut, i));
  }
  // mois : grille de semaines entières (lundi → dimanche) autour du mois visé
  const base = depuisCle(aujourdhui);
  const premier = new Date(base.getFullYear(), base.getMonth() + decalage, 1, 12);
  const dernier = new Date(premier.getFullYear(), premier.getMonth() + 1, 0, 12);
  const debut = lundiDe(cle(premier));
  const fin = plusJours(lundiDe(cle(dernier)), 6);
  const jours: string[] = [];
  for (let k = debut; k <= fin; k = plusJours(k, 1)) jours.push(k);
  return jours;
}

/** Mois visé par la vue « mois » (pour le titre et pour griser les jours voisins). */
export const moisDeVue = (decalage: number, aujourdhui: string) => {
  const base = depuisCle(aujourdhui);
  return new Date(base.getFullYear(), base.getMonth() + decalage, 1, 12);
};

export function filtrerCal(items: ItemCalendrier[], f: FiltresCal, maintenant: Date): ItemCalendrier[] {
  return items.filter(
    (i) =>
      (!f.types.length || f.types.includes(i.type)) &&
      (!f.statuts.length || f.statuts.includes(statutDe(i, maintenant))) &&
      (f.suivi === "tous" || i.suivi === (f.suivi === "oui")),
  );
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
export function trierCal(items: ItemCalendrier[], tri: TriCal): ItemCalendrier[] {
  const parDate = (a: ItemCalendrier, b: ItemCalendrier) => a.date.localeCompare(b.date) || collator.compare(a.titre, b.titre);
  return [...items].sort((a, b) => {
    if (tri === "titre") return collator.compare(a.titre, b.titre) || parDate(a, b);
    if (tri === "service") return collator.compare(service(a), service(b)) || parDate(a, b);
    return parDate(a, b);
  });
}

export function regrouperParJour(items: ItemCalendrier[]): Map<string, ItemCalendrier[]> {
  const m = new Map<string, ItemCalendrier[]>();
  for (const i of items) {
    const k = jourDe(i);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}

// ---------- mémorisation ----------

export const CLE_CAL = "mediarr_calendrier_reglage";
type Lecture = Pick<Storage, "getItem">;
type Ecriture = Pick<Storage, "setItem"> | undefined;

export function nettoyerReglageCal(brut: unknown): ReglageCal {
  const o = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const f = (o.filtres && typeof o.filtres === "object" ? o.filtres : {}) as Record<string, unknown>;
  const liste = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    vue: o.vue === "mois" || o.vue === "liste" || o.vue === "semaine" ? o.vue : REGLAGE_CAL_DEFAUT.vue,
    tri: TRIS_CAL.some((t) => t.id === o.tri) ? (o.tri as TriCal) : "date",
    filtres: {
      types: liste(f.types).filter((x): x is TypeMedia => x === "film" || x === "serie"),
      statuts: liste(f.statuts).filter((x): x is StatutCal => STATUTS_CAL.some((s) => s.id === x)),
      suivi: f.suivi === "oui" || f.suivi === "non" ? f.suivi : "tous",
    },
  };
}
export function lireReglageCal(stockage?: Lecture): ReglageCal {
  try {
    const brut = stockage?.getItem(CLE_CAL);
    return nettoyerReglageCal(brut ? JSON.parse(brut) : {});
  } catch {
    return nettoyerReglageCal({});
  }
}
export function ecrireReglageCal(stockage: Ecriture, r: ReglageCal): void {
  try {
    stockage?.setItem(CLE_CAL, JSON.stringify(r));
  } catch {
    /* facultatif */
  }
}

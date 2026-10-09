// Logique pure de l'écran Activité (qBittorrent) : groupes d'états, filtres, tri, compteurs, arborescence des fichiers.
// Sans React ni navigateur ; testée par server/npm test (../web/src/qbitLogique.test.ts).

export interface TorrentApp {
  hash: string;
  nom: string;
  etat: { code: string; libelle: string; attention: boolean; brut: string };
  progression: number;
  vitesse: number;
  vitesseEnvoi: number;
  resteSec: number | null;
  tailleOctets: number;
  telechargesOctets: number;
  televersesOctets: number;
  ratio: number;
  categorie: string;
  etiquettes: string[];
  tracker: string;
  ajouteLe: string | null;
  termineLe: string | null;
  chemin: string;
  priorite: number;
  sequentiel: boolean;
  premierDernier: boolean;
  forcer: boolean;
  limiteDl: number;
  limiteUp: number;
  seeds: number;
  seedsTotal: number;
  pairs: number;
  pairsTotal: number;
}

export interface EtatQbitApp {
  v: number;
  torrents: TorrentApp[];
  categories: { nom: string; chemin: string }[];
  etiquettes: string[];
  trackers: string[];
  global: {
    vitesseDl: number;
    vitesseUp: number;
    limiteDl: number;
    limiteUp: number;
    alternatif: boolean;
    libreOctets: number | null;
    connexion: string | null;
  };
}

export type Groupe = "en-cours" | "pause" | "attente" | "termine" | "bloque" | "erreur";
export const GROUPES: { id: Groupe; libelle: string }[] = [
  { id: "en-cours", libelle: "En cours" },
  { id: "pause", libelle: "En pause" },
  { id: "attente", libelle: "En attente" },
  { id: "termine", libelle: "Terminé" },
  { id: "bloque", libelle: "Bloqué" },
  { id: "erreur", libelle: "Erreur" },
];

/** Dans quel groupe d'état tombe un torrent (un seul). */
export function groupeDe(t: Pick<TorrentApp, "etat" | "progression">): Groupe {
  const s = t.etat.brut;
  if (s === "error" || s === "missingFiles") return "erreur";
  if (s === "stalledDL") return "bloque";
  if (/^(paused|stopped)(DL|UP)$/.test(s)) return "pause";
  if (["downloading", "forcedDL", "metaDL", "forcedMetaDL", "allocating"].includes(s)) return "en-cours";
  if (["queuedDL", "queuedUP", "checkingDL", "checkingUP", "checkingResumeData", "moving"].includes(s)) return "attente";
  if (t.progression >= 1 || ["uploading", "forcedUP", "stalledUP"].includes(s)) return "termine";
  return "attente";
}

export type CleTri = "nom" | "progression" | "vitesse" | "taille" | "ratio" | "ajout" | "eta";
export const TRIS_QBIT: { id: CleTri; libelle: string }[] = [
  { id: "ajout", libelle: "Date d'ajout" },
  { id: "nom", libelle: "Nom" },
  { id: "progression", libelle: "Progression" },
  { id: "vitesse", libelle: "Vitesse" },
  { id: "taille", libelle: "Taille" },
  { id: "ratio", libelle: "Ratio" },
  { id: "eta", libelle: "Temps restant" },
];

export interface FiltresQbit {
  recherche: string;
  groupes: Groupe[];
  categories: string[];
  etiquettes: string[];
  trackers: string[];
}
export interface TriQbit {
  cle: CleTri;
  desc: boolean;
}
export interface ReglageQbit {
  filtres: FiltresQbit;
  tri: TriQbit;
}
/** Valeur de `categories` pour « sans catégorie ». */
export const SANS_CATEGORIE = "";
export const FILTRES_QBIT_VIDES: FiltresQbit = { recherche: "", groupes: [], categories: [], etiquettes: [], trackers: [] };
export const TRI_QBIT_DEFAUT: TriQbit = { cle: "ajout", desc: true };

const sansAccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const nbFiltresQbit = (f: FiltresQbit) => [f.groupes, f.categories, f.etiquettes, f.trackers].filter((g) => g.length > 0).length;

/** Plusieurs choix dans un groupe = OU ; groupes différents = ET. La recherche porte sur le nom. */
export function filtrerTorrents(items: TorrentApp[], f: FiltresQbit): TorrentApp[] {
  const q = sansAccent(f.recherche.trim());
  return items.filter(
    (t) =>
      (!q || sansAccent(t.nom).includes(q)) &&
      (!f.groupes.length || f.groupes.includes(groupeDe(t))) &&
      (!f.categories.length || f.categories.includes(t.categorie)) &&
      (!f.etiquettes.length || f.etiquettes.some((e) => t.etiquettes.includes(e))) &&
      (!f.trackers.length || f.trackers.includes(t.tracker)),
  );
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
function valeur(t: TorrentApp, cle: CleTri): number | string | null {
  switch (cle) {
    case "nom": return t.nom;
    case "progression": return t.progression;
    case "vitesse": return t.vitesse + t.vitesseEnvoi;
    case "taille": return t.tailleOctets;
    case "ratio": return t.ratio;
    case "ajout": return t.ajouteLe ? Date.parse(t.ajouteLe) || null : null;
    case "eta": return t.resteSec;
  }
}
/** Tri stable ; les torrents sans valeur (pas de temps restant, pas de date) restent à la fin quel que soit le sens. */
export function trierTorrents(items: TorrentApp[], tri: TriQbit): TorrentApp[] {
  const sens = tri.desc ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = valeur(a, tri.cle);
    const vb = valeur(b, tri.cle);
    if (va === null && vb === null) return collator.compare(a.nom, b.nom);
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "string" ? collator.compare(va, vb as string) : va - (vb as number);
    return c !== 0 ? c * sens : collator.compare(a.nom, b.nom);
  });
}

/** Nombre de torrents par groupe d'état (avant tout filtre). */
export function compterGroupes(items: TorrentApp[]): Record<Groupe | "tous", number> {
  const c: Record<Groupe | "tous", number> = { tous: items.length, "en-cours": 0, pause: 0, attente: 0, termine: 0, bloque: 0, erreur: 0 };
  for (const t of items) c[groupeDe(t)]++;
  return c;
}

// ---------- fichiers d'un torrent : arborescence ----------

export interface FichierTorrent {
  index: number;
  nom: string;
  tailleOctets: number;
  progression: number;
  priorite: number;
}
export interface NoeudFichier {
  nom: string;
  chemin: string;
  dossier: boolean;
  enfants: NoeudFichier[];
  /** Indices de tous les fichiers sous ce nœud (pour changer leur priorité d'un coup). */
  indices: number[];
  tailleOctets: number;
  progression: number;
  /** Priorité commune (0, 1, 6, 7) ou null si elle diffère. */
  priorite: number | null;
}

/** « Dossier/Saison 1/ep1.mkv » → arbre de dossiers et de fichiers, avec taille, progression et priorité agrégées. */
export function construireArbre(fichiers: FichierTorrent[]): NoeudFichier[] {
  const racine: NoeudFichier = { nom: "", chemin: "", dossier: true, enfants: [], indices: [], tailleOctets: 0, progression: 0, priorite: null };
  for (const f of fichiers) {
    const parties = f.nom.split("/").filter(Boolean);
    let courant = racine;
    parties.forEach((p, i) => {
      const dernier = i === parties.length - 1;
      const chemin = parties.slice(0, i + 1).join("/");
      let n = courant.enfants.find((e) => e.nom === p && e.dossier === !dernier);
      if (!n) {
        n = { nom: p, chemin, dossier: !dernier, enfants: [], indices: [], tailleOctets: 0, progression: 0, priorite: null };
        courant.enfants.push(n);
      }
      n.indices.push(f.index);
      n.tailleOctets += f.tailleOctets;
      if (dernier) {
        n.progression = f.progression;
        n.priorite = f.priorite;
      }
      courant = n;
    });
  }
  const finir = (n: NoeudFichier, parIndex: Map<number, FichierTorrent>) => {
    if (n.dossier) {
      n.enfants.sort((a, b) => Number(b.dossier) - Number(a.dossier) || collator.compare(a.nom, b.nom));
      n.enfants.forEach((e) => finir(e, parIndex));
      const fs = n.indices.map((i) => parIndex.get(i)!).filter(Boolean);
      n.progression = n.tailleOctets > 0 ? fs.reduce((s, f) => s + f.progression * f.tailleOctets, 0) / n.tailleOctets : 0;
      const ps = new Set(fs.map((f) => f.priorite));
      n.priorite = ps.size === 1 ? [...ps][0] : null;
    }
  };
  const parIndex = new Map(fichiers.map((f) => [f.index, f]));
  finir(racine, parIndex);
  return racine.enfants;
}

// ---------- saisies ----------

/** Un lien magnet dans un texte (presse-papiers, champ) ? */
export const contientMagnet = (texte: string) => /(^|\s)magnet:\?xt=urn:btih:[0-9a-z]{32,40}/i.test(texte);

/** « 500 » (Ko/s) → octets par seconde ; vide ou « 0 » = illimité (0) ; invalide → null. */
export function koVersOctets(saisie: string): number | null {
  const s = saisie.trim().replace(",", ".");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n * 1024) : null;
}
export const octetsVersKo = (octets: number) => (octets > 0 ? String(Math.round((octets / 1024) * 10) / 10) : "");

// ---------- mémorisation ----------

export const CLE_QBIT = "mediarr_activite_reglage";
type Lecture = Pick<Storage, "getItem">;
type Ecriture = Pick<Storage, "setItem"> | undefined;

const textes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, 100) : []);

export function nettoyerReglageQbit(brut: unknown): ReglageQbit {
  const o = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const f = (o.filtres && typeof o.filtres === "object" ? o.filtres : {}) as Record<string, unknown>;
  const t = (o.tri && typeof o.tri === "object" ? o.tri : {}) as Record<string, unknown>;
  return {
    filtres: {
      recherche: typeof f.recherche === "string" ? f.recherche.slice(0, 100) : "",
      groupes: textes(f.groupes).filter((g): g is Groupe => GROUPES.some((x) => x.id === g)),
      categories: textes(f.categories),
      etiquettes: textes(f.etiquettes),
      trackers: textes(f.trackers),
    },
    tri: { cle: TRIS_QBIT.some((x) => x.id === t.cle) ? (t.cle as CleTri) : TRI_QBIT_DEFAUT.cle, desc: typeof t.desc === "boolean" ? t.desc : TRI_QBIT_DEFAUT.desc },
  };
}
export function lireReglageQbit(stockage?: Lecture): ReglageQbit {
  try {
    const brut = stockage?.getItem(CLE_QBIT);
    return nettoyerReglageQbit(brut ? JSON.parse(brut) : {});
  } catch {
    return nettoyerReglageQbit({});
  }
}
export function ecrireReglageQbit(stockage: Ecriture, r: ReglageQbit): void {
  try {
    stockage?.setItem(CLE_QBIT, JSON.stringify(r));
  } catch {
    /* facultatif */
  }
}

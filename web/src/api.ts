export interface ServiceHealth {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number | null;
  version?: string;
  error?: string;
  /** Adresse à ouvrir dans un nouvel onglet (Homarr). */
  lien?: string;
}

export type Etat = "complet" | "partiel" | "manquant";
export type TypeMedia = "film" | "serie";

export interface ResumeMedia {
  id: number;
  type: TypeMedia;
  titre: string;
  annee: number | null;
  affiche: string | null;
  etat: Etat;
  /** Pourcentage d'épisodes présents (séries seulement). */
  progression: number | null;
  suivi: boolean;
  synopsis: string;
  genres: string[];
  dureeMin: number | null;
  qualite: string | null;
  /** Date d'ajout à la bibliothèque (ISO). */
  ajoute: string | null;
  tailleOctets: number;
  /** Note (IMDb pour un film, note Sonarr pour une série). */
  noteValeur: number | null;
  /** Studio (film) ou chaîne (série). */
  studio: string | null;
  statut: "avenir" | "sorti" | "enCours" | "termine" | null;
  /** Film : date de sortie ; série : prochain épisode, sinon le dernier. */
  sortie: string | null;
  /** Nom du profil de qualité. */
  profil: string | null;
  langue: string | null;
}

/** Note d'un titre. `source` dit d'où elle vient : on n'appelle jamais « IMDb » une note qui n'en est pas une. */
export interface Note {
  valeur: number;
  votes: number | null;
  source: "imdb" | "tmdb" | "note";
}

export interface DetailMedia extends ResumeMedia {
  fond: string | null;
  chemin: string;
  note: Note | null;
  tailleOctets: number;
  studio: string | null;
  collection: { titre: string; films: { id: number; titre: string; annee: number | null; affiche: string | null; etat: Etat }[] } | null;
  saisons: { numero: number; episodes: number; total: number; suivi: boolean }[];
}

export interface Distribution {
  acteurs: { nom: string; role: string | null; photo: string | null }[];
  equipe: { nom: string; poste: string }[];
}

export interface ItemCalendrier {
  type: TypeMedia;
  id: number;
  titre: string;
  sousTitre: string;
  /** Date ISO. Si `heure` est faux, seul le jour compte (sortie de film). */
  date: string;
  heure: boolean;
  disponible: boolean;
  /** Dans la file de téléchargement de Radarr / Sonarr. */
  enTelechargement: boolean;
  /** Épisodes seulement : identifiant Sonarr et numéros. */
  episodeId?: number;
  saison?: number;
  numero?: number;
  suivi: boolean;
  affiche: string | null;
}

/** Pourquoi une section de l'accueil a échoué : réseau, accès refusé (401/403), réponse illisible, autre erreur HTTP. */
export type NatureErreur = "reseau" | "refuse" | "illisible" | "http";
type Section<T> = ({ ok: true } & T) | { ok: false; error: string; nature?: NatureErreur; detail?: string } | undefined;

export interface Accueil {
  films: Section<{ total: number; disponibles: number; tailleOctets: number }>;
  series: Section<{ total: number; episodes: number; episodesTotal: number; tailleOctets: number }>;
  qbit: Section<{
    telechargement: number;
    envoi: number;
    actifs: number;
    principal: { nom: string; progression: number; resteSec: number | null } | null;
  }>;
  overseerr: Section<{ enAttente: number }>;
  plex: Section<{
    lectures: {
      titre: string;
      utilisateur: string;
      appareil: string;
      etat: string;
      transcode: boolean;
      resolution: string | null;
      local: boolean;
      affiche: string | null;
    }[];
  }>;
}

export interface Telechargement {
  type: TypeMedia;
  id: number;
  titre: string;
  sousTitre: string;
  date: string;
  affiche: string | null;
}

export interface EtatTorrent {
  code: string;
  libelle: string;
  attention: boolean;
}

export interface Torrent {
  /** Film ou épisode concerné d'après Radarr / Sonarr (torrents à problème seulement). */
  lien: { cible: "film" | "episode"; id: number; titre: string } | null;
  hash: string;
  nom: string;
  etat: EtatTorrent;
  progression: number;
  vitesse: number;
  resteSec: number | null;
  tailleOctets: number;
  telechargesOctets: number;
  categorie: string;
}

export interface Activite {
  telechargement: number;
  envoi: number;
  items: Torrent[];
}

export interface EvenementHistorique {
  id: string;
  service: "radarr" | "sonarr";
  type: TypeMedia;
  mediaId: number;
  titre: string;
  sousTitre: string;
  release: string;
  etat: { code: "importe" | "recupere" | "supprime" | "echec" | "renomme" | "ignore" | "autre"; libelle: string };
  qualite: string | null;
  score: number | null;
  langue: string | null;
  groupe: string | null;
  client: string | null;
  date: string;
  affiche: string | null;
}

export interface ResultatRecherche {
  type: TypeMedia;
  titre: string;
  annee: number | null;
  synopsis: string;
  genres: string[];
  affiche: string | null;
  externeId: number;
  dansBibliotheque: boolean;
  mediaId: number | null;
  detail: string | null;
  note: Note | null;
  /** Date ISO de sortie (tri par date). */
  sortie: string | null;
}

export interface OptionsAjout {
  racines: { chemin: string; libreOctets: number }[];
  profils: { id: number; nom: string }[];
}

export interface FichierActuel {
  qualite: string | null;
  rang: number;
  tailleOctets: number;
  langues: string[];
  groupe: string | null;
  nom: string;
}

export interface EtatTitre {
  statut: "present" | "sans_fichier" | "absent" | "inconnu";
  fichier?: FichierActuel | null;
  note: Note | null;
}

export interface Release {
  guid: string;
  indexerId: number;
  titre: string;
  indexeur: string;
  protocole: "torrent" | "usenet";
  qualite: string | null;
  rang: number;
  /** Résolution (2160, 1080…) si connue. */
  resolution?: number | null;
  /** Pack de saison complet (Sonarr). */
  pack?: boolean;
  groupe: string | null;
  dejaTelecharge: boolean;
  miseANiveau: boolean;
  inferieure: boolean;
  meilleurChoix: boolean;
  tailleOctets: number;
  seeders: number | null;
  leechers: number | null;
  ageMinutes: number;
  langues: string[];
  score: number | null;
  rejete: boolean;
  raisons: string[];
  telechargeable: boolean;
}

export interface SaisonEpisodes {
  numero: number;
  episodes: {
    id: number;
    numero: number;
    titre: string;
    diffusion: string | null;
    fichier: boolean;
    suivi: boolean;
  }[];
}

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

const TOKEN_KEY = "mediarr_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const effacerToken = () => localStorage.removeItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);

export class UnauthorizedError extends Error {}

let onUnauthorized: (() => void) | undefined;
/** L'app s'abonne ici pour afficher le formulaire de jeton quel que soit l'écran qui a échoué. */
export const setUnauthorizedHandler = (fn: (() => void) | undefined) => {
  onUnauthorized = fn;
};

/** Appelle le serveur Mediarr (jamais les services directement). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "X-Requested-With": "mediarr", // exigé par le serveur pour toute action qui modifie quelque chose
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new UnauthorizedError("Jeton requis");
  }
  if (!res.ok) {
    // Les routes d'action renvoient un message français prêt à afficher.
    const message = await res.json().then((j: { error?: string }) => j?.error, () => undefined);
    throw new ErreurApi(message ?? `Erreur ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/** Erreur renvoyée par le serveur ; `message` est lisible tel quel par l'utilisateur. */
export class ErreurApi extends Error {
  constructor(
    message: string,
    public statut: number,
  ) {
    super(message);
  }
}

/** Action qui modifie quelque chose (pause, suppression…) : POST ou DELETE sur le serveur Mediarr. */
export const action = <T = { ok: true }>(methode: "POST" | "DELETE", chemin: string, corps?: unknown) =>
  api<T>(
    chemin,
    corps === undefined
      ? { method: methode }
      : { method: methode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) },
  );

/** Télécharge une image relayée par le serveur (avec le jeton) et renvoie un blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new UnauthorizedError("Jeton requis");
  }
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return res.blob();
}

export const fetchHealth = () => api<{ services: ServiceHealth[] }>("/health");

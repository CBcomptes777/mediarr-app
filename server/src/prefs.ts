// Préférences de l'app (ordre des services, widgets de l'accueil, apparence…), gardées côté serveur dans un
// fichier JSON : elles survivent à une réinstallation du navigateur ou de l'iPhone.
// Où ? DATA_DIR s'il est défini ; sinon /data s'il existe (volume monté sur le TrueNAS) ; sinon ./data dans le
// conteneur, avec un avertissement : ce dossier disparaît quand le conteneur est recréé.
import type { FastifyInstance } from "fastify";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lireJson } from "./ajout.js";
import type { Env } from "./services.js";

export const SERVICES_ORDRE = ["radarr", "sonarr", "overseerr", "qbittorrent", "plex", "prowlarr", "homarr"] as const;
/** Widgets de l'accueil : [identifiant, visible par défaut]. */
export const WIDGETS: [string, boolean][] = [
  ["alertes", true], ["services", true], ["ajout", true], ["apercu", true], ["telechargements", true], ["completude", true],
  ["stockage", true], ["qbit", true], ["plex", true], ["sorties", true], ["genres", false], ["actions", false],
];
export const CARTES_STATS: [string, boolean][] = [
  ["apercu", true], ["stockage", true], ["croissance", true], ["genres", true], ["decennies", true], ["profils", true],
];
export const ONGLETS: [string, boolean][] = [
  ["accueil", true], ["biblio", true], ["films", true], ["series", true], ["calendrier", true],
  ["activite", true], ["demandes", false], ["services", true],
];

/** Types de notifications ntfy qu'on peut activer ou couper un par un. */
export const TYPES_NOTIF = ["disque", "indexeur", "torrent", "service", "resume"] as const;
export type TypeNotif = (typeof TYPES_NOTIF)[number];

export interface ReglagesNotifs {
  types: Record<TypeNotif, boolean>;
  /** Fréquence de la surveillance, en minutes. */
  intervalleMin: number;
  seuils: {
    /** Alerte « disque presque plein » sous ce pourcentage libre… */
    disquePct: number;
    /** …ou sous cet espace libre (Go). */
    disqueGo: number;
    /** Alerte critique sous ce pourcentage libre. */
    disqueCritiquePct: number;
    /** Torrent bloqué depuis plus de N heures. */
    torrentHeures: number;
    /** Service hors ligne depuis plus de N minutes. */
    serviceMinutes: number;
  };
}

/** Filtre de bibliothèque enregistré sous un nom (rappelable d'un tap). */
export interface FiltreEnregistre {
  id: string;
  nom: string;
  filtres: Record<string, unknown>;
  tri: { cle: string; desc: boolean };
}

export interface ActionRapide {
  id: string;
  libelle: string;
  /** media : fiche d'un film/série ; ecran : un écran de l'app ; url : adresse web. */
  type: "media" | "ecran" | "url";
  mediaType?: "film" | "serie";
  mediaId?: number;
  ecran?: string;
  url?: string;
}

export interface Prefs {
  version: 1;
  reglages: {
    reseau: { maison: string; tailscale: string; preferee: "auto" | "maison" | "tailscale" };
    ordreServices: string[];
    delaiHttpMs: number;
    /** Délai d'une recherche de releases chez les indexeurs (plus long qu'une requête ordinaire). */
    delaiRechercheMs: number;
    masquerSuppression: boolean;
    webhooksAuto: boolean;
    /** Dossiers où l'app peut ajouter ou déplacer des torrents (vide = ceux de Radarr, Sonarr et qBittorrent). */
    racinesQbit: string[];
  };
  accueil: { widgets: { id: string; visible: boolean }[] };
  actionsRapides: ActionRapide[];
  stats: { cartes: { id: string; visible: boolean }[] };
  notifications: ReglagesNotifs;
  filtresBiblio: FiltreEnregistre[];
  apparence: {
    theme: "auto" | "clair" | "sombre";
    accent: string;
    intensite: number;
    bibliothequeScindee: boolean;
    serviceSwitcherSepare: boolean;
    onglets: { id: string; visible: boolean }[];
    libelles: boolean;
    badges: { activite: boolean; demandes: boolean };
    detail: { distribution: boolean; studios: boolean; collection: boolean };
  };
}

const ECRANS = ["accueil", "biblio", "films", "series", "calendrier", "activite", "historique", "demandes", "plex", "indexeurs", "recherche", "stats", "reglages"];
/** Widgets ajoutés après coup qui doivent apparaître EN TÊTE de l'accueil des personnes qui ont déjà des préférences enregistrées. */
const WIDGETS_EN_TETE = ["alertes"];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, defaut: boolean) => (typeof v === "boolean" ? v : defaut);
const borne = (v: unknown, min: number, max: number, defaut: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : defaut;
const choix = <T extends string>(v: unknown, valeurs: readonly T[], defaut: T): T =>
  typeof v === "string" && (valeurs as readonly string[]).includes(v) ? (v as T) : defaut;

/** Adresse http(s) sans slash final ; chaîne vide si invalide. */
export function nettoyerUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Liste ordonnée d'éléments connus : l'ordre et la visibilité de l'entrée, les manquants à la fin (par défaut). */
function listeOrdonnee(entree: unknown, connus: [string, boolean][], enTete: string[] = []): { id: string; visible: boolean }[] {
  const defauts = new Map(connus);
  const vus = new Set<string>();
  const sortie: { id: string; visible: boolean }[] = [];
  for (const e of Array.isArray(entree) ? entree : []) {
    const o = obj(e);
    if (typeof o.id === "string" && defauts.has(o.id) && !vus.has(o.id)) {
      vus.add(o.id);
      sortie.push({ id: o.id, visible: bool(o.visible, defauts.get(o.id)!) });
    }
  }
  const nouveaux = connus.filter(([id]) => !vus.has(id)).map(([id, visible]) => ({ id, visible }));
  return [...nouveaux.filter((n) => enTete.includes(n.id)), ...sortie, ...nouveaux.filter((n) => !enTete.includes(n.id))];
}

function actionRapide(brut: unknown): ActionRapide | null {
  const o = obj(brut);
  const libelle = typeof o.libelle === "string" ? o.libelle.trim().slice(0, 40) : "";
  const id = typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "";
  if (!libelle || !id) return null;
  if (o.type === "media" && (o.mediaType === "film" || o.mediaType === "serie") && Number.isInteger(o.mediaId) && (o.mediaId as number) > 0) {
    return { id, libelle, type: "media", mediaType: o.mediaType, mediaId: o.mediaId as number };
  }
  if (o.type === "ecran" && typeof o.ecran === "string" && ECRANS.includes(o.ecran)) {
    return { id, libelle, type: "ecran", ecran: o.ecran };
  }
  if (o.type === "url" && typeof o.url === "string" && o.url.length <= 500) {
    const url = nettoyerUrl(o.url) && /^https?:\/\//i.test(o.url.trim()) ? o.url.trim() : "";
    if (url) return { id, libelle, type: "url", url };
  }
  return null;
}

const TRIS_BIBLIO = ["titre", "annee", "ajout", "sortie", "taille", "note"];
const STATUTS_BIBLIO = ["complet", "partiel", "manquant", "avenir", "enCours", "termine"];
const textes = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 120).slice(0, 80) : []);

/** Filtres de bibliothèque enregistrés : mêmes champs que l'écran, tout le reste est ignoré. */
function nettoyerFiltres(brut: unknown): FiltreEnregistre[] {
  const vus = new Set<string>();
  const sortie: FiltreEnregistre[] = [];
  for (const e of Array.isArray(brut) ? brut : []) {
    const o = obj(e);
    const id = typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "";
    const nom = typeof o.nom === "string" ? o.nom.trim().slice(0, 40) : "";
    if (!id || !nom || vus.has(id) || sortie.length >= 30) continue;
    vus.add(id);
    const f = obj(o.filtres);
    const t = obj(o.tri);
    sortie.push({
      id,
      nom,
      filtres: {
        recherche: typeof f.recherche === "string" ? f.recherche.slice(0, 100) : "",
        types: textes(f.types).filter((x) => x === "film" || x === "serie"),
        statuts: textes(f.statuts).filter((x) => STATUTS_BIBLIO.includes(x)),
        suivi: f.suivi === "oui" || f.suivi === "non" ? f.suivi : "tous",
        services: textes(f.services),
        genres: textes(f.genres),
        decennies: (Array.isArray(f.decennies) ? f.decennies : []).filter((x): x is number => Number.isInteger(x) && x >= 1800 && x <= 2100).slice(0, 40),
        profils: textes(f.profils),
        langues: textes(f.langues),
        studios: textes(f.studios),
      },
      tri: { cle: typeof t.cle === "string" && TRIS_BIBLIO.includes(t.cle) ? t.cle : "titre", desc: t.desc === true },
    });
  }
  return sortie;
}

function nettoyerNotifs(brut: unknown): ReglagesNotifs {
  const n = obj(brut);
  const types = obj(n.types);
  const s = obj(n.seuils);
  const disquePct = borne(s.disquePct, 1, 50, 10);
  return {
    types: Object.fromEntries(TYPES_NOTIF.map((t) => [t, bool(types[t], true)])) as Record<TypeNotif, boolean>,
    intervalleMin: borne(n.intervalleMin, 1, 60, 2),
    seuils: {
      disquePct,
      disqueGo: borne(s.disqueGo, 0, 10000, 200),
      // Le seuil critique ne peut pas dépasser le seuil d'alerte.
      disqueCritiquePct: Math.min(borne(s.disqueCritiquePct, 1, 50, 5), disquePct),
      torrentHeures: borne(s.torrentHeures, 1, 72, 2),
      serviceMinutes: borne(s.serviceMinutes, 1, 120, 5),
    },
  };
}

/** Valide et complète des préférences reçues : tout ce qui est inconnu ou invalide est remplacé par le défaut. */
export function nettoyerPrefs(brut: unknown): Prefs {
  const b = obj(brut);
  const r = obj(b.reglages);
  const reseau = obj(r.reseau);
  const a = obj(b.apparence);
  const badges = obj(a.badges);
  const detail = obj(a.detail);

  const ordre = [...new Set((Array.isArray(r.ordreServices) ? r.ordreServices : []).filter(
    (x): x is string => typeof x === "string" && (SERVICES_ORDRE as readonly string[]).includes(x),
  ))];
  for (const s of SERVICES_ORDRE) if (!ordre.includes(s)) ordre.push(s);

  const ids = new Set<string>();
  const actions: ActionRapide[] = [];
  for (const e of Array.isArray(b.actionsRapides) ? b.actionsRapides : []) {
    const x = actionRapide(e);
    if (x && !ids.has(x.id) && actions.length < 24) {
      ids.add(x.id);
      actions.push(x);
    }
  }

  const onglets = listeOrdonnee(a.onglets, ONGLETS);
  return {
    version: 1,
    reglages: {
      reseau: {
        maison: nettoyerUrl(reseau.maison),
        tailscale: nettoyerUrl(reseau.tailscale),
        preferee: choix(reseau.preferee, ["auto", "maison", "tailscale"], "auto"),
      },
      ordreServices: ordre,
      delaiHttpMs: borne(r.delaiHttpMs, 5000, 120000, 15000),
      delaiRechercheMs: borne(r.delaiRechercheMs, 15000, 300000, 90000),
      masquerSuppression: bool(r.masquerSuppression, false),
      webhooksAuto: bool(r.webhooksAuto, true),
      racinesQbit: [...new Set((Array.isArray(r.racinesQbit) ? r.racinesQbit : []).filter((c): c is string => typeof c === "string").map((c) => c.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/").filter((c) => /^(\/|[a-zA-Z]:\/)/.test(c) && c.length <= 300 && !/[\0\r\n]/.test(c) && !c.split("/").some((s) => s === ".." || s === ".")))].slice(0, 20),
    },
    accueil: { widgets: listeOrdonnee(obj(b.accueil).widgets, WIDGETS, WIDGETS_EN_TETE) },
    actionsRapides: actions,
    stats: { cartes: listeOrdonnee(obj(b.stats).cartes, CARTES_STATS) },
    notifications: nettoyerNotifs(b.notifications),
    filtresBiblio: nettoyerFiltres(b.filtresBiblio),
    apparence: {
      theme: choix(a.theme, ["auto", "clair", "sombre"], "auto"),
      accent: typeof a.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(a.accent) ? a.accent.toLowerCase() : "#a78bfa",
      intensite: borne(a.intensite, 0, 100, 50),
      bibliothequeScindee: bool(a.bibliothequeScindee, false),
      serviceSwitcherSepare: bool(a.serviceSwitcherSepare, true),
      onglets,
      libelles: bool(a.libelles, true),
      badges: { activite: bool(badges.activite, true), demandes: bool(badges.demandes, true) },
      detail: {
        distribution: bool(detail.distribution, true),
        studios: bool(detail.studios, true),
        collection: bool(detail.collection, true),
      },
    },
  };
}

export class StockagePrefs {
  readonly dossier: string;
  readonly persistant: boolean;
  private avertissementEcriture: string | null = null;
  private avertissementInitial: string | null = null;
  private courant: Prefs;

  constructor(env: Env) {
    const ecrivable = (d: string) => {
      try {
        accessSync(d, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    const demande = env.DATA_DIR?.trim();
    if (demande && (existsSync(demande) ? ecrivable(demande) : true)) {
      this.dossier = resolve(demande);
      this.persistant = true;
    } else if (!demande && existsSync("/data") && ecrivable("/data")) {
      this.dossier = "/data";
      this.persistant = true;
    } else {
      this.dossier = resolve("./data");
      this.persistant = false;
      this.avertissementInitial = demande
        ? `Le dossier DATA_DIR (${demande}) n'est pas accessible en écriture : les préférences sont gardées dans le conteneur et seront perdues s'il est recréé.`
        : "Aucun volume monté sur /data : les préférences sont gardées dans le conteneur et seront perdues s'il est recréé. Monte un volume sur /data (voir le README).";
    }
    this.courant = this.charger();
  }

  private fichier() {
    return join(this.dossier, "prefs.json");
  }

  private charger(): Prefs {
    try {
      return nettoyerPrefs(JSON.parse(readFileSync(this.fichier(), "utf8")));
    } catch {
      return nettoyerPrefs({});
    }
  }

  lire(): Prefs {
    return this.courant;
  }

  /** Valide, garde en mémoire, puis écrit (fichier temporaire puis renommage : jamais de fichier à moitié écrit). */
  ecrire(brut: unknown): Prefs {
    this.courant = nettoyerPrefs(brut);
    try {
      mkdirSync(this.dossier, { recursive: true });
      const tmp = `${this.fichier()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.courant, null, 2), "utf8");
      renameSync(tmp, this.fichier());
      this.avertissementEcriture = null;
    } catch {
      this.avertissementEcriture = `Impossible d'écrire dans ${this.dossier} : les préférences ne sont gardées qu'en mémoire jusqu'au prochain redémarrage.`;
    }
    return this.courant;
  }

  get avertissement(): string | null {
    return this.avertissementEcriture ?? this.avertissementInitial;
  }
}

export function registerPrefs(app: FastifyInstance, stockage: StockagePrefs, jetonActif: boolean) {
  const reponse = () => ({
    prefs: stockage.lire(),
    stockage: { persistant: stockage.persistant && stockage.avertissement === null, dossier: stockage.dossier, avertissement: stockage.avertissement },
    jetonActif,
  });
  app.get("/api/prefs", async () => reponse());
  app.put("/api/prefs", async (req, reply) => {
    const b = lireJson(req.body);
    if (!b) return reply.code(400).send({ error: "Préférences invalides" });
    stockage.ecrire(b);
    return reponse();
  });
}

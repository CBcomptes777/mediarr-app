import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Reglage } from "./bibliothequeLogique";

// Miroir de server/src/prefs.ts : le serveur valide tout, l'app ne fait que lire et renvoyer l'ensemble.
export interface ActionRapide {
  id: string;
  libelle: string;
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
    delaiRechercheMs: number;
    masquerSuppression: boolean;
    webhooksAuto: boolean;
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

export interface FiltreEnregistre extends Reglage {
  id: string;
  nom: string;
}

export interface ReglagesNotifs {
  types: { disque: boolean; indexeur: boolean; torrent: boolean; service: boolean; resume: boolean };
  intervalleMin: number;
  seuils: { disquePct: number; disqueGo: number; disqueCritiquePct: number; torrentHeures: number; serviceMinutes: number };
}

export interface StockagePrefs {
  persistant: boolean;
  dossier: string;
  avertissement: string | null;
}

interface Reponse {
  prefs: Prefs;
  stockage: StockagePrefs;
  jetonActif: boolean;
}

const liste = (ids: [string, boolean][]) => ids.map(([id, visible]) => ({ id, visible }));

export const PREFS_DEFAUT: Prefs = {
  version: 1,
  reglages: {
    reseau: { maison: "", tailscale: "", preferee: "auto" },
    ordreServices: ["radarr", "sonarr", "overseerr", "qbittorrent", "plex", "prowlarr", "homarr"],
    delaiHttpMs: 15000,
    delaiRechercheMs: 90000,
    masquerSuppression: false,
    webhooksAuto: true,
    racinesQbit: [],
  },
  accueil: {
    widgets: liste([
      ["alertes", true], ["services", true], ["ajout", true], ["apercu", true], ["telechargements", true], ["completude", true],
      ["stockage", true], ["qbit", true], ["plex", true], ["sorties", true], ["genres", false], ["actions", false],
    ]),
  },
  actionsRapides: [],
  stats: { cartes: liste([["apercu", true], ["stockage", true], ["croissance", true], ["genres", true], ["decennies", true], ["profils", true]]) },
  notifications: {
    types: { disque: true, indexeur: true, torrent: true, service: true, resume: true },
    intervalleMin: 2,
    seuils: { disquePct: 10, disqueGo: 200, disqueCritiquePct: 5, torrentHeures: 2, serviceMinutes: 5 },
  },
  filtresBiblio: [],
  apparence: {
    theme: "auto",
    accent: "#a78bfa",
    intensite: 50,
    bibliothequeScindee: false,
    serviceSwitcherSepare: true,
    onglets: liste([
      ["accueil", true], ["biblio", true], ["films", true], ["series", true], ["calendrier", true],
      ["activite", true], ["demandes", false], ["services", true],
    ]),
    libelles: true,
    badges: { activite: true, demandes: true },
    detail: { distribution: true, studios: true, collection: true },
  },
};

const CLE_CACHE = "mediarr_prefs";

/** Dernières préférences connues : premier affichage sans attente, et repli si le serveur ne répond pas. */
export function lireCachePrefs(): Prefs | null {
  try {
    const brut = localStorage.getItem(CLE_CACHE);
    return brut ? ({ ...PREFS_DEFAUT, ...JSON.parse(brut) } as Prefs) : null;
  } catch {
    return null;
  }
}
function ecrireCache(p: Prefs) {
  try {
    localStorage.setItem(CLE_CACHE, JSON.stringify(p));
  } catch {
    /* facultatif */
  }
}

interface Contexte {
  prefs: Prefs;
  stockage: StockagePrefs | null;
  jetonActif: boolean;
  /** Vrai une fois la réponse du serveur reçue. */
  charge: boolean;
  /** Modifie les préférences : `modifier` reçoit les préférences actuelles et renvoie les nouvelles. */
  sauvegarder: (modifier: (p: Prefs) => Prefs) => Promise<void>;
}

const Ctx = createContext<Contexte>({
  prefs: PREFS_DEFAUT,
  stockage: null,
  jetonActif: false,
  charge: false,
  sauvegarder: async () => {},
});

export const usePrefs = () => useContext(Ctx);

export function PrefsProvider({ session, children }: { session: number; children: ReactNode }) {
  const [etat, setEtat] = useState<Reponse | null>(null);
  const [cache] = useState<Prefs | null>(lireCachePrefs);
  const courant = useRef<Prefs>(cache ?? PREFS_DEFAUT);

  useEffect(() => {
    let annule = false;
    api<Reponse>("/prefs")
      .then((r) => {
        if (annule) return;
        courant.current = r.prefs;
        ecrireCache(r.prefs);
        setEtat(r);
      })
      .catch(() => {});
    return () => {
      annule = true;
    };
  }, [session]);

  const sauvegarder = useCallback(async (modifier: (p: Prefs) => Prefs) => {
    const suivantes = modifier(courant.current);
    courant.current = suivantes;
    setEtat((e) => ({ prefs: suivantes, stockage: e?.stockage ?? { persistant: true, dossier: "", avertissement: null }, jetonActif: e?.jetonActif ?? false }));
    ecrireCache(suivantes);
    const r = await api<Reponse>("/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(suivantes),
    });
    courant.current = r.prefs; // la version validée par le serveur
    ecrireCache(r.prefs);
    setEtat(r);
  }, []);

  const valeur = useMemo<Contexte>(
    () => ({
      prefs: etat?.prefs ?? cache ?? PREFS_DEFAUT,
      stockage: etat?.stockage ?? null,
      jetonActif: etat?.jetonActif ?? false,
      charge: etat !== null,
      sauvegarder,
    }),
    [etat, cache, sauvegarder],
  );
  return <Ctx.Provider value={valeur}>{children}</Ctx.Provider>;
}

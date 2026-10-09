import { useCallback, useEffect, useState } from "react";
import { api, ErreurApi, UnauthorizedError } from "./api";

export interface EtatApi<T> {
  data: T | null;
  /** Message prêt à afficher, ou null. */
  erreur: string | null;
  chargement: boolean;
  recharger: () => void;
}

/** Charge `path` (relatif à /api) ; recharge toutes les `refreshMs` ms si demandé. */
export function useApi<T>(path: string | null, refreshMs?: number): EtatApi<T> {
  const [data, setData] = useState<T | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(path !== null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let annule = false;
    // Fermer l'écran (ou changer de chemin) annule la requête : le serveur annule alors sa recherche chez le service.
    const arret = new AbortController();
    setChargement(true);
    setErreur(null);
    api<T>(path, { signal: arret.signal })
      .then((d) => {
        if (annule) return;
        setData(d);
        setErreur(null);
      })
      .catch((e) => {
        if (annule || e instanceof UnauthorizedError) return;
        // Message français du serveur s'il y en a un (ex. « Radarr n'est pas configuré »).
        setErreur(
          e instanceof ErreurApi ? e.message : "Serveur Mediarr injoignable. Le VPN est-il actif ?",
        );
      })
      .finally(() => !annule && setChargement(false));
    return () => {
      annule = true;
      arret.abort();
    };
  }, [path, tick]);

  useEffect(() => {
    if (!refreshMs || path === null) return;
    // Rien n'est demandé tant que l'app est cachée (iPhone verrouillé, autre onglet) ; une relecture part dès qu'elle revient.
    const t = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, refreshMs);
    const visible = () => {
      if (!document.hidden) setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, refreshMs]);

  const recharger = useCallback(() => setTick((n) => n + 1), []);
  return { data, erreur, chargement, recharger };
}

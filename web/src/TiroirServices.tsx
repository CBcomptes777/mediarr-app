import { useMemo, useState } from "react";
import type { ServiceHealth } from "./api";
import { normaliser } from "./format";
import { usePrefs } from "./prefs";
import { Feuille } from "./ui";

export const COULEURS_SERVICES: Record<string, string> = {
  radarr: "#f59e42",
  sonarr: "#4f9cf9",
  overseerr: "#818cf8",
  qbittorrent: "#60a5fa",
  plex: "#fbbf24",
  prowlarr: "#e879f9",
  homarr: "#34d399",
};

/** Services dans l'ordre choisi dans Réglages ; ceux qu'on ne connaît pas à la fin. */
export function ordonner<T extends { id: string }>(services: T[], ordre: string[]): T[] {
  const rang = (id: string) => {
    const i = ordre.indexOf(id);
    return i < 0 ? ordre.length : i;
  };
  return [...services].sort((a, b) => rang(a.id) - rang(b.id));
}

/** Tiroir « Services » : Accueil + chaque service avec sa pastille d'état, et une recherche. */
export function TiroirServices({
  services,
  onChoisir,
  onFermer,
}: {
  services: ServiceHealth[] | null;
  /** « accueil » ou l'identifiant d'un service. */
  onChoisir: (cible: string) => void;
  onFermer: () => void;
}) {
  const { prefs } = usePrefs();
  const [q, setQ] = useState("");
  const visibles = useMemo(() => {
    const n = normaliser(q.trim());
    return ordonner(services ?? [], prefs.reglages.ordreServices).filter((s) => !n || normaliser(s.label).includes(n));
  }, [services, q, prefs.reglages.ordreServices]);
  const montrerAccueil = !q.trim() || normaliser("accueil").includes(normaliser(q.trim()));

  return (
    <Feuille titre="Services" onFermer={onFermer}>
      <label className="recherche">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <input aria-label="Rechercher un service" placeholder="Rechercher un service…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      {montrerAccueil && (
        <button className="service-ligne accueil" onClick={() => onChoisir("accueil")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
          </svg>
          <span className="strong">Accueil</span>
        </button>
      )}

      <button className="service-ligne accueil" onClick={() => onChoisir("recherche")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <span className="strong">Recherche interactive</span>
      </button>

      {services === null && <span className="muted">Chargement…</span>}
      {services !== null && visibles.length === 0 && !montrerAccueil && <span className="muted">Aucun service ne correspond.</span>}

      {visibles.map((s) => {
        const contenu = (
          <>
            <span className="bar" style={{ background: COULEURS_SERVICES[s.id] ?? "#a78bfa" }} />
            <span className="name strong">{s.label}</span>
            <span className="muted">
              {s.lien ? "Ouvrir ↗" : s.ok ? (s.version ? `v${s.version}` : "En ligne") : (s.error ?? "Hors ligne")}
            </span>
            <span className={s.ok ? "dot ok" : "dot down"} role="img" aria-label={s.ok ? "En ligne" : "Hors ligne"} />
          </>
        );
        // Homarr s'ouvre dans un nouvel onglet : c'est un tableau de bord externe, pas un écran de Mediarr.
        return s.lien ? (
          <a key={s.id} className="service-ligne" href={s.lien} target="_blank" rel="noopener noreferrer" onClick={onFermer}>
            {contenu}
          </a>
        ) : (
          <button key={s.id} className="service-ligne" onClick={() => onChoisir(s.id)}>
            {contenu}
          </button>
        );
      })}
    </Feuille>
  );
}

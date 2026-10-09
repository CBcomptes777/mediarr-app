import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiBlob, type Etat, type Note } from "./api";
import { ETIQUETTE_NOTE, entier, noteTexte } from "./format";

/** Onglets possibles de la barre du bas (la liste affichée dépend des préférences). */
export type Onglet = "accueil" | "biblio" | "films" | "series" | "calendrier" | "activite" | "demandes" | "services";

const DEGRADES = [
  ["#ef4444", "#450a0a"],
  ["#3b82f6", "#172554"],
  ["#f59e0b", "#78350f"],
  ["#a78bfa", "#4c1d95"],
  ["#10b981", "#064e3b"],
];

/** Dégradé stable selon le titre, quand il n'y a pas d'affiche. */
export function degrade(titre: string): string {
  let h = 0;
  for (const c of titre) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = DEGRADES[h % DEGRADES.length];
  return `linear-gradient(160deg,${a},${b})`;
}

// Les affiches passent par le serveur (jeton + clé côté serveur) : on les télécharge avec fetch,
// puis on les affiche depuis une URL locale. Cache par chemin, 6 chargements en parallèle au plus.
const cacheImages = new Map<string, Promise<string>>();
let enCours = 0;
const attente: Array<() => void> = [];

async function creneau<T>(fn: () => Promise<T>): Promise<T> {
  if (enCours >= 6) await new Promise<void>((ok) => attente.push(ok));
  enCours++;
  try {
    return await fn();
  } finally {
    enCours--;
    attente.shift()?.();
  }
}

function chargerImage(chemin: string): Promise<string> {
  let p = cacheImages.get(chemin);
  if (!p) {
    p = creneau(() => apiBlob(chemin)).then((b) => URL.createObjectURL(b));
    p.catch(() => cacheImages.delete(chemin));
    cacheImages.set(chemin, p);
  }
  return p;
}

/** Affiche d'un média. `src` est un chemin du serveur (/image/…) ; `w` demande une version réduite. */
export function Affiche({
  src,
  titre,
  className,
  w = 250,
}: {
  src: string | null;
  titre: string;
  className: string;
  w?: 250 | 500;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const chemin = src ? `${src}${src.includes("?") ? "&" : "?"}w=${w}` : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !chemin) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    const obs = new IntersectionObserver(
      (e) => e.some((x) => x.isIntersecting) && (setVisible(true), obs.disconnect()),
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [chemin]);

  useEffect(() => {
    if (!visible || !chemin) return;
    let annule = false;
    chargerImage(chemin)
      .then((u) => !annule && setUrl(u))
      .catch(() => {});
    return () => {
      annule = true;
    };
  }, [visible, chemin]);

  if (url) return <img className={className} src={url} alt={titre} />;
  // En attendant (ou sans affiche) : un dégradé stable selon le titre.
  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      className={className}
      style={{ background: degrade(titre) }}
      role="img"
      aria-label={titre}
    />
  );
}

/** Feuille modale qui monte du bas (ajout de média, releases). Échap, croix ou clic à côté la ferme. */
export function Feuille({
  titre,
  sousTitre,
  onFermer,
  children,
}: {
  titre: string;
  sousTitre?: string;
  onFermer: () => void;
  children: ReactNode;
}) {
  const fermer = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    fermer.current?.focus();
    const touche = (e: KeyboardEvent) => e.key === "Escape" && onFermer();
    window.addEventListener("keydown", touche);
    const avant = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // la page derrière ne défile pas
    return () => {
      window.removeEventListener("keydown", touche);
      document.body.style.overflow = avant;
    };
  }, [onFermer]);

  return (
    <div className="voile feuille-voile" onClick={onFermer}>
      <div
        className="feuille"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feuille-titre"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="feuille-tete">
          <button ref={fermer} className="rond" aria-label="Fermer" onClick={onFermer}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div className="feuille-titres">
            <h2 id="feuille-titre">{titre}</h2>
            {sousTitre && <span className="muted">{sousTitre}</span>}
          </div>
        </header>
        <div className="feuille-corps">{children}</div>
      </div>
    </div>
  );
}

/** Étoile + note, avec sa source (IMDb pour les films, « Note » pour les séries). Rien s'il n'y a pas de note. */
export function PastilleNote({ note }: { note: Note | null | undefined }) {
  if (!note) return null;
  const etiquette = ETIQUETTE_NOTE[note.source];
  const votes = note.votes ? `, ${entier(note.votes)} votes` : "";
  return (
    <span
      className="pastille-note"
      title={`${etiquette} : ${noteTexte(note.valeur)} sur 10${votes}`}
      aria-label={`${etiquette} : ${noteTexte(note.valeur)} sur 10${votes}`}
    >
      <span aria-hidden="true">★</span> {noteTexte(note.valeur)}
      <span className="pastille-note-source">{etiquette}</span>
    </span>
  );
}

export function TitreCarte({ couleur, children, droite }: { couleur: string; children: ReactNode; droite?: ReactNode }) {
  return (
    <div className="card-title">
      <span className="card-title-l">
        <span className="stripe" style={{ background: couleur }} />
        {children}
      </span>
      {droite}
    </div>
  );
}

export const LIBELLE_ETAT: Record<Etat, string> = {
  complet: "Complet",
  partiel: "En cours",
  manquant: "Manquant",
};

export function BadgeEtat({ etat, pct }: { etat: Etat; pct?: number | null }) {
  const texte = etat === "partiel" && pct ? `En cours ${Math.round(pct)} %` : LIBELLE_ETAT[etat];
  return <span className={`badge etat-${etat}`}>{texte}</span>;
}

export function Message({ children, erreur }: { children: ReactNode; erreur?: boolean }) {
  return <p className={`card ${erreur ? "error" : "muted"}`}>{children}</p>;
}

const ICONES: Record<Onglet, ReactNode> = {
  accueil: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  biblio: <path d="M5 4v16M10 4v16M15 5l4 15" />,
  films: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M3 12h18M7 7l-2-4M13 7l-2-4M19 7l-2-4" />
    </>
  ),
  series: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  calendrier: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  activite: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />,
  demandes: (
    <>
      <path d="M4 13l2-8h12l2 8" />
      <path d="M4 13v6h16v-6h-5a3 3 0 0 1-6 0z" />
    </>
  ),
  services: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
};

export const NOMS_ONGLETS: Record<Onglet, string> = {
  accueil: "Accueil",
  biblio: "Biblio",
  films: "Films",
  series: "Séries",
  calendrier: "Calendrier",
  activite: "Activité",
  demandes: "Demandes",
  services: "Services",
};

export function IconeOnglet({ onglet, taille = 22 }: { onglet: Onglet; taille?: number }) {
  return (
    <svg width={taille} height={taille} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONES[onglet]}
    </svg>
  );
}

export function Navigation({
  onglets,
  actif,
  onChoix,
  badges = {},
  libelles = true,
  onServices,
}: {
  onglets: Onglet[];
  actif: Onglet | null;
  onChoix: (o: Onglet) => void;
  /** Pastille par onglet (nombre de téléchargements, de demandes…) ; absente si 0. */
  badges?: Partial<Record<Onglet, number>>;
  libelles?: boolean;
  /** Si défini, le sélecteur de services est un bouton rond à côté de la barre. */
  onServices?: () => void;
}) {
  return (
    <div className="nav-conteneur">
      <nav className={libelles ? "nav" : "nav sans-libelles"} aria-label="Navigation principale">
        {onglets.map((o) => {
          const n = badges[o] ?? 0;
          return (
            <button
              key={o}
              className={o === actif ? "nav-item actif" : "nav-item"}
              aria-current={o === actif ? "page" : undefined}
              aria-label={libelles ? undefined : NOMS_ONGLETS[o]}
              onClick={() => onChoix(o)}
            >
              {n > 0 && (
                <span className="pastille" role="status" aria-label={`${n} ${o === "activite" ? `téléchargement${n > 1 ? "s" : ""} en cours` : `demande${n > 1 ? "s" : ""} en attente`}`}>
                  {n}
                </span>
              )}
              <IconeOnglet onglet={o} />
              {libelles && NOMS_ONGLETS[o]}
            </button>
          );
        })}
      </nav>
      {onServices && (
        <button className="nav-services" aria-label="Services" onClick={onServices}>
          <IconeOnglet onglet="services" />
        </button>
      )}
    </div>
  );
}

/** Interrupteur accessible (role="switch") avec son explication. */
export function Interrupteur({
  libelle,
  description,
  valeur,
  onChange,
  desactive,
}: {
  libelle: string;
  description?: string;
  valeur: boolean;
  onChange: (v: boolean) => void;
  desactive?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={valeur}
      disabled={desactive}
      className="interrupteur"
      onClick={() => onChange(!valeur)}
    >
      <span className="interrupteur-texte">
        <strong>{libelle}</strong>
        {description && <span className="muted">{description}</span>}
      </span>
      <span className={valeur ? "bascule on" : "bascule"} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export interface ElementOrdonne {
  id: string;
  libelle: string;
  /** Si défini, une case permet d'afficher / masquer l'élément. */
  visible?: boolean;
  detail?: string;
}

/**
 * Liste réordonnable : on glisse la poignée (doigt ou souris) ou on utilise les boutons Monter / Descendre
 * (toujours disponibles, pour le clavier et les lecteurs d'écran).
 */
export function ListeOrdonnable({
  elements,
  onChange,
  onRetirer,
}: {
  elements: ElementOrdonne[];
  onChange: (suite: ElementOrdonne[]) => void;
  /** Si défini, un bouton « − » retire l'élément. */
  onRetirer?: (id: string) => void;
}) {
  const lignes = useRef<(HTMLLIElement | null)[]>([]);
  const [glisse, setGlisse] = useState<string | null>(null);

  const deplacer = (de: number, vers: number) => {
    if (vers < 0 || vers >= elements.length || de === vers) return;
    const copie = [...elements];
    const [x] = copie.splice(de, 1);
    copie.splice(vers, 0, x);
    onChange(copie);
  };

  // Pendant un glissement, on écoute au niveau de la fenêtre : réordonner déplace les nœuds du DOM, ce qui ferait
  // perdre la capture du pointeur à la poignée (le glissement s'arrêterait après un cran).
  useEffect(() => {
    if (!glisse) return;
    const bouge = (e: PointerEvent) => {
      const de = elements.findIndex((x) => x.id === glisse);
      if (de < 0) return;
      // Nouvelle place = nombre d'autres éléments dont le milieu est au-dessus du doigt.
      let vers = 0;
      elements.forEach((x, i) => {
        if (x.id === glisse) return;
        const r = lignes.current[i]?.getBoundingClientRect();
        if (r && r.top + r.height / 2 < e.clientY) vers++;
      });
      deplacer(de, vers);
    };
    const fin = () => setGlisse(null);
    window.addEventListener("pointermove", bouge);
    window.addEventListener("pointerup", fin);
    window.addEventListener("pointercancel", fin);
    return () => {
      window.removeEventListener("pointermove", bouge);
      window.removeEventListener("pointerup", fin);
      window.removeEventListener("pointercancel", fin);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glisse, elements]);

  return (
    <ul className="ordonnable">
      {elements.map((el, i) => (
        <li
          key={el.id}
          ref={(n) => {
            lignes.current[i] = n;
          }}
          className={glisse === el.id ? "glisse" : undefined}
        >
          {onRetirer && (
            <button className="moins" aria-label={`Retirer ${el.libelle}`} onClick={() => onRetirer(el.id)}>
              −
            </button>
          )}
          {el.visible !== undefined && (
            <input
              type="checkbox"
              className="case-visible"
              checked={el.visible}
              aria-label={`Afficher ${el.libelle}`}
              onChange={(e) => onChange(elements.map((x) => (x.id === el.id ? { ...x, visible: e.target.checked } : x)))}
            />
          )}
          <span className="ordonnable-texte">
            <strong>{el.libelle}</strong>
            {el.detail && <span className="muted">{el.detail}</span>}
          </span>
          <button className="fleche" aria-label={`Monter ${el.libelle}`} disabled={i === 0} onClick={() => deplacer(i, i - 1)}>
            ▲
          </button>
          <button className="fleche" aria-label={`Descendre ${el.libelle}`} disabled={i === elements.length - 1} onClick={() => deplacer(i, i + 1)}>
            ▼
          </button>
          <span
            className="poignee"
            role="img"
            aria-label={`Glisser pour déplacer ${el.libelle}`}
            onPointerDown={(e) => {
              e.preventDefault();
              setGlisse(el.id);
            }}
          >
            ≡
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface BoutonDialogue {
  libelle: string;
  variante?: "plein" | "danger" | "contour";
  onClick: () => void;
}

/** Boîte de confirmation : « Annuler » a le focus, Échap ferme. */
export function DialogueConfirmation({
  titre,
  texte,
  boutons,
  onAnnuler,
}: {
  titre: string;
  texte?: string;
  boutons: BoutonDialogue[];
  onAnnuler: () => void;
}) {
  const annuler = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    annuler.current?.focus();
    const fermer = (e: KeyboardEvent) => e.key === "Escape" && onAnnuler();
    window.addEventListener("keydown", fermer);
    return () => window.removeEventListener("keydown", fermer);
  }, [onAnnuler]);
  return (
    <div className="voile" onClick={onAnnuler}>
      <div className="dialogue" role="alertdialog" aria-modal="true" aria-labelledby="dc-titre" aria-describedby={texte ? "dc-texte" : undefined} onClick={(e) => e.stopPropagation()}>
        <h2 id="dc-titre">{titre}</h2>
        {texte && (
          <p id="dc-texte" className="torrent-nom">
            {texte}
          </p>
        )}
        {boutons.map((b) => (
          <button key={b.libelle} className={`bouton ${b.variante ?? "plein"}`} onClick={b.onClick}>
            {b.libelle}
          </button>
        ))}
        <button ref={annuler} className="bouton contour" onClick={onAnnuler}>
          Annuler
        </button>
      </div>
    </div>
  );
}

/** Bouton rond « retour » en tête d'une page (Réglages, Demandes…). */
export function BoutonRetour({ onClick }: { onClick: () => void }) {
  return (
    <button className="rond" aria-label="Retour" onClick={onClick}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </button>
  );
}

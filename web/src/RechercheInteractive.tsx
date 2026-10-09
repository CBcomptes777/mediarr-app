import { useMemo, useState } from "react";
import type { DetailMedia, ResumeMedia, SaisonEpisodes } from "./api";
import { normaliser } from "./format";
import { Releases, type CibleRecherche } from "./Releases";
import { Affiche, BadgeEtat, BoutonRetour, Message } from "./ui";
import { useApi } from "./useApi";

/**
 * Point d'entrée global de la recherche interactive : on tape un titre, on choisit un film ou une série (puis une saison
 * ou un épisode), et la même feuille « Recherche manuelle » s'ouvre. Hors bibliothèque : recherche chez les indexeurs.
 */
export function RechercheInteractive({ onRetour, onIndexeurs, onAjouter }: {
  onRetour: () => void;
  /** Cherche ce terme chez les indexeurs (Prowlarr) quand le titre n'est pas dans la bibliothèque. */
  onIndexeurs: (terme: string) => void;
  onAjouter: (requete: string) => void;
}) {
  const [saisie, setSaisie] = useState("");
  const [type, setType] = useState<"film" | "serie">("film");
  const [serie, setSerie] = useState<ResumeMedia | null>(null);
  const [cible, setCible] = useState<CibleRecherche | null>(null);
  const { data, erreur, chargement } = useApi<{ items: ResumeMedia[]; erreurs: string[] }>("/bibliotheque");

  const q = normaliser(saisie.trim());
  const trouves = useMemo(
    () => (q.length < 2 ? [] : (data?.items ?? []).filter((i) => i.type === type && normaliser(i.titre).includes(q)).slice(0, 30)),
    [data, type, q],
  );

  function choisir(m: ResumeMedia) {
    if (m.type === "film") setCible({ cible: "film", id: m.id, titre: m.titre, affiche: m.affiche });
    else setSerie(m);
  }

  return (
    <>
      <header className="top">
        <BoutonRetour onClick={serie ? () => setSerie(null) : onRetour} />
        <h1>Recherche interactive</h1>
        <span style={{ width: 44 }} />
      </header>

      {serie ? (
        <ChoixSerie serie={serie} onChoisir={setCible} />
      ) : (
        <>
          <div className="segments" role="tablist" aria-label="Type">
            <button role="tab" aria-selected={type === "film"} className={type === "film" ? "actif" : ""} onClick={() => setType("film")}>
              Film
            </button>
            <button role="tab" aria-selected={type === "serie"} className={type === "serie" ? "actif" : ""} onClick={() => setType("serie")}>
              Série
            </button>
          </div>
          <label className="recherche">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input aria-label="Titre à chercher" placeholder={type === "film" ? "Titre du film…" : "Titre de la série…"} value={saisie} onChange={(e) => setSaisie(e.target.value)} />
          </label>
          <p className="muted">
            Choisis un titre de ta bibliothèque pour voir ce que proposent les indexeurs
            {type === "serie" ? " (saison entière ou un épisode)" : ""}.
          </p>

          {erreur && <Message erreur>{erreur}</Message>}
          {chargement && !data && <Message>Chargement…</Message>}
          {q.length >= 2 && data && trouves.length === 0 && <Message>Aucun {type === "film" ? "film" : "série"} de ta bibliothèque ne correspond.</Message>}

          {trouves.map((m) => (
            <button key={m.id} className="media" onClick={() => choisir(m)}>
              <div className="media-g">
                <Affiche src={m.affiche} titre={m.titre} className="media-img" />
                <BadgeEtat etat={m.etat} pct={m.progression} />
              </div>
              <div className="media-d">
                <span className="media-titre">{m.titre}</span>
                {m.annee && <span className="media-meta">{m.annee}</span>}
              </div>
            </button>
          ))}

          {q.length >= 2 && (
            <div className="actions colonne">
              <button className="bouton violet" onClick={() => onIndexeurs(saisie.trim())}>
                Chercher « {saisie.trim()} » chez les indexeurs
              </button>
              <button className="bouton violet" onClick={() => onAjouter(saisie.trim())}>
                Ajouter « {saisie.trim()} » à la bibliothèque
              </button>
            </div>
          )}
        </>
      )}

      {cible && <Releases {...cible} onFermer={() => setCible(null)} />}
    </>
  );
}

/** Saisons (pack) et épisodes d'une série de la bibliothèque. */
function ChoixSerie({ serie, onChoisir }: { serie: ResumeMedia; onChoisir: (c: CibleRecherche) => void }) {
  const detail = useApi<DetailMedia>(`/detail/serie/${serie.id}`);
  const episodes = useApi<{ saisons: SaisonEpisodes[] }>(`/episodes/${serie.id}`);
  const [ouverte, setOuverte] = useState<number | null>(null);
  return (
    <>
      <h2 className="sous-titre">{serie.titre}</h2>
      {(detail.erreur || episodes.erreur) && <Message erreur>{detail.erreur ?? episodes.erreur}</Message>}
      {(detail.chargement || episodes.chargement) && !detail.data && <Message>Chargement…</Message>}
      <ul className="saisons">
        {(detail.data?.saisons ?? []).map((s) => {
          const liste = episodes.data?.saisons.find((x) => x.numero === s.numero)?.episodes ?? [];
          const estOuverte = ouverte === s.numero;
          return (
            <li key={s.numero}>
              <div className="saison-bouton">
                <span className="strong">{s.numero === 0 ? "Épisodes spéciaux" : `Saison ${s.numero}`}</span>
                <span className="muted">
                  {s.episodes}/{s.total} épisodes
                </span>
              </div>
              <div className="actions">
                <button className="bouton violet" onClick={() => onChoisir({ cible: "saison", id: serie.id, numero: s.numero, titre: serie.titre, affiche: serie.affiche })}>
                  Saison entière
                </button>
                <button className="bouton violet" aria-expanded={estOuverte} onClick={() => setOuverte(estOuverte ? null : s.numero)}>
                  Un épisode {estOuverte ? "▴" : "▾"}
                </button>
              </div>
              {estOuverte && (
                <div className="episodes">
                  {liste.map((e) => {
                    const code = `S${String(s.numero).padStart(2, "0")}E${String(e.numero).padStart(2, "0")}`;
                    return (
                      <div key={e.id} className="episode">
                        <div className="episode-texte">
                          <span className="strong">
                            {code} · {e.titre || "Sans titre"}
                          </span>
                          <span className="muted">{e.fichier ? "Téléchargé" : "Pas de fichier"}</span>
                        </div>
                        <button className="bouton-episode" onClick={() => onChoisir({ cible: "episode", id: e.id, titre: `${serie.titre} · ${code}`, affiche: serie.affiche })}>
                          Rechercher
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

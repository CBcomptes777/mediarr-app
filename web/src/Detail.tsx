import { useState } from "react";
import type { DetailMedia, Distribution, SaisonEpisodes, TypeMedia } from "./api";
import { usePrefs } from "./prefs";
import { duree, jourCourt, taille } from "./format";
import { Releases, type CibleRecherche } from "./Releases";
import { Affiche, BadgeEtat, Message, PastilleNote } from "./ui";
import { useApi } from "./useApi";

export function Detail({
  type,
  id,
  onRetour,
  onOuvrir,
}: {
  type: TypeMedia;
  id: number;
  onRetour: () => void;
  /** Ouvre la fiche d'un autre titre (films de la même saga). */
  onOuvrir?: (type: TypeMedia, id: number) => void;
}) {
  const { prefs } = usePrefs();
  const options = prefs.apparence.detail;
  const { data: m, erreur, chargement } = useApi<DetailMedia>(`/detail/${type}/${id}`);
  const episodes = useApi<{ saisons: SaisonEpisodes[] }>(type === "serie" ? `/episodes/${id}` : null);
  // La distribution n'est demandée que si elle est affichée (réglage) et seulement pour un film.
  const distribution = useApi<Distribution>(type === "film" && options.distribution ? `/detail/film/${id}/distribution` : null);
  const [ouverte, setOuverte] = useState<number | null>(null);
  const [recherche, setRecherche] = useState<CibleRecherche | null>(null);

  return (
    <>
      <div className={`fond-detail ${type}`} aria-hidden="true" />
      <header className="top">
        <button className="rond" aria-label="Retour" onClick={onRetour}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      </header>

      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && !m && <Message>Chargement…</Message>}

      {m && (
        <>
          <div className="entete">
            <Affiche src={m.affiche} titre={m.titre} className="entete-img" w={500} />
            <h1 className="entete-titre">{m.titre}</h1>
            <span className="entete-meta">
              {[m.annee, duree(m.dureeMin), m.genres.join(", ")].filter(Boolean).join(" · ")}
            </span>
            <div className="pastilles">
              <BadgeEtat etat={m.etat} pct={m.progression} />
              {m.qualite && <span className="badge sombre">{m.qualite}</span>}
              <PastilleNote note={m.note} />
            </div>
          </div>

          {m.synopsis && (
            <section className="card verre">
              <h2>Synopsis</h2>
              <p className="synopsis">{m.synopsis}</p>
            </section>
          )}

          <section className="card verre infos">
            <div>
              <div className="muted">Taille</div>
              <div className="strong">{taille(m.tailleOctets)}</div>
            </div>
            <div>
              <div className="muted">Surveillé</div>
              <div className="strong">{m.suivi ? "Oui" : "Non"}</div>
            </div>
            {options.studios && m.studio && (
              <div>
                <div className="muted">{m.type === "film" ? "Studio" : "Chaîne"}</div>
                <div className="strong">{m.studio}</div>
              </div>
            )}
            {m.chemin && (
              <div className="pleine">
                <div className="muted">Dossier</div>
                <div className="strong chemin">{m.chemin}</div>
              </div>
            )}
          </section>

          {m.type === "film" && (
            <button
              className="bouton violet plein large"
              onClick={() => setRecherche({ cible: "film", id: m.id, titre: m.titre, affiche: m.affiche })}
            >
              Recherche manuelle
            </button>
          )}

          {m.saisons.length > 0 && (
            <section className="card verre">
              <h2>Saisons</h2>
              <ul className="saisons">
                {m.saisons.map((s) => {
                  const liste = episodes.data?.saisons.find((x) => x.numero === s.numero)?.episodes ?? [];
                  const estOuverte = ouverte === s.numero;
                  return (
                    <li key={s.numero}>
                      <button
                        className="saison-bouton"
                        aria-expanded={estOuverte}
                        onClick={() => setOuverte(estOuverte ? null : s.numero)}
                      >
                        <span className="strong">Saison {s.numero}</span>
                        <span className="muted">
                          {s.episodes}/{s.total} épisodes{s.suivi ? "" : " · non surveillée"}
                        </span>
                        <span className="chevron" aria-hidden="true">
                          {estOuverte ? "▴" : "▾"}
                        </span>
                        <div className="jauge fine">
                          <div style={{ width: `${s.total ? Math.round((s.episodes / s.total) * 100) : 0}%` }} />
                        </div>
                      </button>
                      <button
                        className="bouton violet bouton-saison"
                        onClick={() => setRecherche({ cible: "saison", id: m.id, numero: s.numero, titre: m.titre, affiche: m.affiche })}
                      >
                        Recherche manuelle (saison {s.numero})
                      </button>
                      {estOuverte && (
                        <div className="episodes">
                          {episodes.chargement && !episodes.data && <span className="muted">Chargement des épisodes…</span>}
                          {episodes.erreur && <span className="error">{episodes.erreur}</span>}
                          {liste.map((e) => {
                            const futur = !e.fichier && e.diffusion !== null && new Date(e.diffusion) > new Date();
                            const etat = e.fichier ? "Téléchargé" : futur ? "À venir" : "Manquant";
                            const code = `S${String(s.numero).padStart(2, "0")}E${String(e.numero).padStart(2, "0")}`;
                            return (
                              <div key={e.id} className="episode">
                                <div className="episode-texte">
                                  <span className="strong">
                                    {code} · {e.titre || "Sans titre"}
                                  </span>
                                  <span className="muted">
                                    {e.diffusion ? jourCourt(e.diffusion.slice(0, 10)) : "Date inconnue"}
                                    {" · "}
                                    {etat}
                                  </span>
                                </div>
                                <button
                                  className="bouton-episode"
                                  aria-label={`Recherche manuelle ${code}`}
                                  onClick={() =>
                                    setRecherche({ cible: "episode", id: e.id, titre: `${m.titre} · ${code}`, affiche: m.affiche })
                                  }
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                    <circle cx="11" cy="11" r="7" />
                                    <path d="M20 20l-4-4" />
                                  </svg>
                                  Recherche manuelle
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
            </section>
          )}

          {options.collection && m.collection && m.collection.films.length > 1 && (
            <section className="card verre" aria-label="Collection">
              <h2>{m.collection.titre}</h2>
              <p className="muted marge-bas">Les films de cette saga dans ta bibliothèque :</p>
              <div className="saga">
                {m.collection.films.map((f) => {
                  const courant = f.id === m.id;
                  return (
                    <button key={f.id} className={courant ? "saga-film courant" : "saga-film"} disabled={courant || !onOuvrir} aria-current={courant ? "true" : undefined} onClick={() => onOuvrir?.("film", f.id)}>
                      <Affiche src={f.affiche} titre={f.titre} className="saga-img" />
                      <span className="saga-texte">
                        <strong>{f.titre}</strong>
                        <span className="muted">
                          {f.annee ?? "Année inconnue"} · {f.etat === "complet" ? "Disponible" : "Manquant"}
                          {courant ? " · fiche actuelle" : ""}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {type === "film" && options.distribution && (
            <section className="card verre" aria-label="Distribution">
              <h2>Distribution</h2>
              {distribution.chargement && !distribution.data && <span className="muted">Chargement…</span>}
              {distribution.erreur && <span className="error">{distribution.erreur}</span>}
              {distribution.data && distribution.data.acteurs.length === 0 && distribution.data.equipe.length === 0 && (
                <span className="muted">Aucune information de distribution.</span>
              )}
              {distribution.data && distribution.data.acteurs.length > 0 && (
                <div className="casting">
                  {distribution.data.acteurs.map((a) => (
                    <div key={a.nom} className="acteur">
                      <Affiche src={a.photo} titre={a.nom} className="acteur-photo" />
                      <span className="acteur-texte">
                        <strong>{a.nom}</strong>
                        {a.role && <span className="muted">{a.role}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {distribution.data && distribution.data.equipe.length > 0 && (
                <>
                  <h3 className="sous-titre">Équipe</h3>
                  <ul className="equipe">
                    {distribution.data.equipe.map((e) => (
                      <li key={`${e.nom}-${e.poste}`}>
                        <span className="muted">{e.poste}</span> · <strong>{e.nom}</strong>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {recherche && <Releases {...recherche} onFermer={() => setRecherche(null)} />}
        </>
      )}
    </>
  );
}

import type { Accueil } from "./api";
import { ErreurPlex } from "./ErreurPlex";
import { Affiche, BoutonRetour, Message } from "./ui";
import type { EtatApi } from "./useApi";

/** Écran « En lecture » : les flux Plex en cours, en plus grand que la carte de l'accueil. */
export function PagePlex({ accueil, onRetour }: { accueil: EtatApi<Accueil>; onRetour: () => void }) {
  const p = accueil.data?.plex;
  return (
    <>
      <header className="top">
        <BoutonRetour onClick={onRetour} />
        <h1>En lecture</h1>
        <span style={{ width: 44 }} />
      </header>
      {!p && !accueil.erreur && <Message>Plex n'est pas configuré.</Message>}
      {accueil.erreur && <Message erreur>{accueil.erreur}</Message>}
      {p && !p.ok && (
        <div className="card">
          <ErreurPlex echec={p} />
        </div>
      )}
      {p?.ok && p.lectures.length === 0 && <Message>Aucune lecture en cours.</Message>}
      {p?.ok &&
        p.lectures.map((l, i) => (
          <article key={i} className="card hist-corps">
            <Affiche src={l.affiche} titre={l.titre} className="demande-img" />
            <div className="hist-texte">
              <span className="media-titre">{l.titre}</span>
              <span className="muted">
                {l.utilisateur}
                {l.appareil ? ` · ${l.appareil}` : ""}
              </span>
              <span className="media-meta">
                {l.etat === "paused" ? "En pause" : l.etat === "buffering" ? "Mise en mémoire tampon" : "Lecture en cours"}
              </span>
              <span className="media-meta">
                {l.transcode ? "Transcodage" : "Lecture directe"}
                {l.resolution ? ` · ${l.resolution}p` : ""}
                {` · ${l.local ? "réseau local" : "à distance"}`}
              </span>
            </div>
          </article>
        ))}
    </>
  );
}

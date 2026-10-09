import { useState } from "react";
import type { Statistiques } from "./api";
import { entier, ilYa, pourcent, taille } from "./format";
import { Anneau, BarreStat, Courbe, moisCourt } from "./Graphiques";
import { usePrefs } from "./prefs";
import { COULEURS_SERVICES } from "./TiroirServices";
import { BoutonRetour, Feuille, ListeOrdonnable, Message, TitreCarte } from "./ui";
import { useApi } from "./useApi";

const TITRES: Record<string, string> = {
  apercu: "Vue d'ensemble",
  stockage: "Stockage",
  croissance: "Croissance de la collection",
  genres: "Genres",
  decennies: "Décennies",
  profils: "Profils de qualité",
};

/** Écran Stats : cartes affichées, masquées et ordonnées selon les préférences. */
export function Stats({ onRetour }: { onRetour: () => void }) {
  const { prefs, sauvegarder } = usePrefs();
  const { data, erreur, chargement } = useApi<Statistiques>("/stats", 300000);
  const [personnaliser, setPersonnaliser] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);
  const visibles = prefs.stats.cartes.filter((c) => c.visible);

  return (
    <>
      <header className="top">
        <BoutonRetour onClick={onRetour} />
        <h1>Stats</h1>
        <button className="rond" aria-label="Personnaliser les cartes" onClick={() => setPersonnaliser(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
        </button>
      </header>

      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && !data && <Message>Calcul des statistiques… cela peut prendre quelques secondes avec une grande bibliothèque.</Message>}
      {data?.erreurs.map((e) => (
        <Message key={e} erreur>
          {e}
        </Message>
      ))}
      {visibles.length === 0 && <Message>Toutes les cartes sont masquées. Touche le bouton en haut à droite pour en afficher.</Message>}

      {data && visibles.map((c) => <Carte key={c.id} id={c.id} stats={data} />)}

      {data && (
        <p className="muted centre" aria-live="polite">
          Calculé {ilYa(data.calculeA)}
        </p>
      )}

      {personnaliser && (
        <Feuille titre="Personnaliser les stats" sousTitre="Coche pour afficher, ▲ ▼ ou ≡ pour l'ordre" onFermer={() => setPersonnaliser(false)}>
          {echec && (
            <p className="card error" role="alert">
              {echec}
            </p>
          )}
          <ListeOrdonnable
            elements={prefs.stats.cartes.map((c) => ({ id: c.id, libelle: TITRES[c.id] ?? c.id, visible: c.visible }))}
            onChange={async (suite) => {
              setEchec(null);
              try {
                await sauvegarder((p) => ({ ...p, stats: { cartes: suite.map((s) => ({ id: s.id, visible: s.visible ?? true })) } }));
              } catch (e) {
                setEchec(e instanceof Error ? e.message : "Enregistrement impossible");
              }
            }}
          />
        </Feuille>
      )}
    </>
  );
}

function Carte({ id, stats }: { id: string; stats: Statistiques }) {
  switch (id) {
    case "apercu": return <CarteApercu stats={stats} />;
    case "stockage": return <CarteStockage stats={stats} />;
    case "croissance": return <CarteCroissance stats={stats} />;
    case "genres": return <CarteGenres stats={stats} />;
    case "decennies": return <CarteDecennies stats={stats} />;
    case "profils": return <CarteProfils stats={stats} />;
    default: return null;
  }
}

function CarteApercu({ stats }: { stats: Statistiques }) {
  const { films, series } = stats.apercu;
  if (!films && !series) return null;
  return (
    <section className="card" aria-label="Vue d'ensemble">
      <TitreCarte couleur="#4f9cf9">Vue d'ensemble</TitreCarte>
      <div className="compteurs interne">
        {films && (
          <div className="compteur">
            <span className="compteur-n" style={{ color: COULEURS_SERVICES.radarr }}>
              {entier(films.total)}
            </span>
            <span className="muted">Films</span>
            <span className="muted">{entier(films.disponibles)} téléchargé{films.disponibles > 1 ? "s" : ""}</span>
          </div>
        )}
        {series && (
          <div className="compteur">
            <span className="compteur-n" style={{ color: COULEURS_SERVICES.sonarr }}>
              {entier(series.total)}
            </span>
            <span className="muted">Séries</span>
            <span className="muted">{entier(series.episodes)} épisode{series.episodes > 1 ? "s" : ""}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function CarteStockage({ stats }: { stats: Statistiques }) {
  const { total, parts } = stats.stockage;
  if (total <= 0) return null;
  const couleur = (nom: string) => (nom === "Sonarr" ? COULEURS_SERVICES.sonarr : COULEURS_SERVICES.radarr);
  return (
    <section className="card" aria-label="Stockage">
      <TitreCarte couleur="#a78bfa">Stockage</TitreCarte>
      <div className="stock-total">{taille(total)}</div>
      <div className="muted">Occupé par la médiathèque</div>
      <div className="repartition" role="img" aria-label={`Répartition : ${parts.map((p) => `${p.nom} ${pourcent(p.octets / total)}`).join(", ")}`}>
        {parts.map((p) => (
          <div key={p.nom} style={{ flex: p.octets, background: couleur(p.nom) }} />
        ))}
      </div>
      <ul className="legende">
        {parts.map((p) => (
          <li key={p.nom}>
            <span className="stripe" style={{ background: couleur(p.nom) }} />
            <span className="strong">{p.nom}</span>
            <span className="muted">{pourcent(p.octets / total)}</span>
            <span className="strong">{taille(p.octets)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CarteCroissance({ stats }: { stats: Statistiques }) {
  const c = stats.croissance;
  if (c.points.length === 0) return null;
  return (
    <section className="card" aria-label="Croissance de la collection">
      <TitreCarte couleur="#4f9cf9" droite={<span className="muted strong">12 mois</span>}>
        Croissance de la collection
      </TitreCarte>
      <Courbe points={c.points} titre="Nombre de titres dans la collection" />
      <p className="muted marge-haut">
        {moisCourt(c.debut)} → {moisCourt(c.fin)} : <strong>{c.ajoutsPeriode >= 0 ? "+" : ""}{entier(c.ajoutsPeriode)}</strong> titre{c.ajoutsPeriode > 1 ? "s" : ""}
      </p>
    </section>
  );
}

function CarteGenres({ stats }: { stats: Statistiques }) {
  const top = stats.genres.slice(0, 5);
  if (top.length === 0) return null;
  return (
    <section className="card" aria-label="Genres">
      <TitreCarte couleur="#4caf8a">Genres</TitreCarte>
      <Anneau titre="Genres les plus présents" parts={top.map((g) => ({ nom: g.nom, valeur: g.total }))} />
    </section>
  );
}

function CarteDecennies({ stats }: { stats: Statistiques }) {
  if (stats.decennies.length === 0) return null;
  return (
    <section className="card" aria-label="Décennies">
      <TitreCarte couleur="#e8b04a">Décennies</TitreCarte>
      <div className="barres">
        {stats.decennies.map((d) => (
          <BarreStat key={d.decennie} nom={`Années ${d.decennie}`} ratio={d.pct} detail={`${entier(d.total)} titre${d.total > 1 ? "s" : ""}`} />
        ))}
      </div>
    </section>
  );
}

function CarteProfils({ stats }: { stats: Statistiques }) {
  if (stats.profils.length === 0) return null;
  return (
    <section className="card" aria-label="Profils de qualité">
      <TitreCarte couleur="#e56b8a">Profils de qualité</TitreCarte>
      <div className="barres">
        {stats.profils.map((p) => (
          <BarreStat key={p.nom} nom={p.nom} ratio={p.pct} detail={`${entier(p.total)} titre${p.total > 1 ? "s" : ""}`} />
        ))}
      </div>
    </section>
  );
}

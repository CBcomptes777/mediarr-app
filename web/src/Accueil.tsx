import { useState, type ReactNode } from "react";
import type { Accueil as DonneesAccueil, ItemCalendrier, ServiceHealth, Statistiques, Telechargement } from "./api";
import { ActionsRapides } from "./ActionsRapides";
import { EditeurAccueil } from "./EditeurAccueil";
import { ErreurPlex } from "./ErreurPlex";
import { cleJourItem, dateCourte, entier, heure, jourCourt, pourcent, reste, taille, vitesse } from "./format";
import { Anneau, BarreStat } from "./Graphiques";
import { usePrefs } from "./prefs";
import { COULEURS_SERVICES, ordonner } from "./TiroirServices";
import { Affiche, Message, TitreCarte } from "./ui";
import { useApi, type EtatApi } from "./useApi";

const COULEURS = COULEURS_SERVICES;

function detailService(s: ServiceHealth, d: DonneesAccueil | null): string {
  if (!s.ok) return s.error ?? "Hors ligne";
  if (s.id === "qbittorrent" && d?.qbit?.ok) return `${d.qbit.actifs} actif${d.qbit.actifs > 1 ? "s" : ""}`;
  if (s.id === "plex" && d?.plex?.ok) return `${d.plex.lectures.length} flux`;
  if (s.id === "overseerr" && d?.overseerr?.ok && d.overseerr.enAttente > 0) {
    return `${d.overseerr.enAttente} demande${d.overseerr.enAttente > 1 ? "s" : ""}`;
  }
  return "En ligne";
}

interface Contexte {
  accueil: EtatApi<DonneesAccueil>;
  sante: ServiceHealth[] | null;
  onOuvrir: (type: "film" | "serie", id: number) => void;
  onAjouter: (requete: string) => void;
  onService: (id: string) => void;
  onEcran: (ecran: string) => void;
}

export function Accueil({
  accueil,
  sante: etatSante,
  reseau,
  onOuvrir,
  onAjouter,
  onService,
  onReglages,
  onEcran,
}: {
  accueil: EtatApi<DonneesAccueil>;
  sante: EtatApi<{ services: ServiceHealth[] }>;
  /** Nom du réseau détecté (Maison, Tailscale, Distant). */
  reseau: string;
  onOuvrir: (type: "film" | "serie", id: number) => void;
  onAjouter: (requete: string) => void;
  /** Ouvre l'écran d'un service (Radarr → films, Overseerr → demandes…). */
  onService: (id: string) => void;
  onReglages: () => void;
  /** Ouvre un écran de l'app (actions rapides). */
  onEcran: (ecran: string) => void;
}) {
  const { prefs, sauvegarder } = usePrefs();
  const [edition, setEdition] = useState(false);
  const sante = etatSante.data ? ordonner(etatSante.data.services, prefs.reglages.ordreServices) : null;

  if (edition) {
    return (
      <EditeurAccueil
        widgets={prefs.accueil.widgets}
        onAnnuler={() => setEdition(false)}
        onEnregistrer={async (widgets) => {
          await sauvegarder((p) => ({ ...p, accueil: { widgets } }));
          setEdition(false);
        }}
      />
    );
  }

  const ctx: Contexte = { accueil, sante, onOuvrir, onAjouter, onService, onEcran };
  const visibles = prefs.accueil.widgets.filter((w) => w.visible);

  return (
    <>
      <header className="top">
        <button className="pilule bouton-pilule" onClick={onReglages} aria-label={`Réseau : ${reseau}. Ouvrir les réglages`}>
          <span className={reseau === "Distant" ? "pt attention" : "pt ok"} aria-hidden="true" />
          {reseau}
        </button>
        <div className="paire">
          <button className="rond" aria-label="Recherche interactive" onClick={() => onEcran("recherche")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
          </button>
          <button className="rond" aria-label="Stats" onClick={() => onEcran("stats")}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 20V11M12 20V4M19 20v-6" />
            </svg>
          </button>
          <button className="rond" aria-label="Modifier l'accueil" onClick={() => setEdition(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 20h4L19 9l-4-4L4 16z" />
              <path d="M13.5 6.5l4 4" />
            </svg>
          </button>
          <button className="rond" aria-label="Réglages" onClick={onReglages}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
            </svg>
          </button>
        </div>
      </header>

      {etatSante.erreur && !sante && <Message erreur>Serveur Mediarr injoignable. Le VPN est-il actif ?</Message>}
      {sante && sante.length === 0 && <Message>Aucun service configuré. Renseigne les URLs dans le fichier .env du serveur.</Message>}
      {visibles.length === 0 && (
        <Message>Ton accueil est vide. Touche le crayon en haut à droite pour ajouter des widgets.</Message>
      )}

      {visibles.map((w) => (
        <Widget key={w.id} id={w.id} ctx={ctx} />
      ))}
    </>
  );
}

function Widget({ id, ctx }: { id: string; ctx: Contexte }): ReactNode {
  switch (id) {
    case "alertes": return <WidgetAlertes ctx={ctx} />;
    case "services": return <WidgetServices ctx={ctx} />;
    case "ajout": return <WidgetAjout ctx={ctx} />;
    case "apercu": return <WidgetApercu ctx={ctx} />;
    case "telechargements": return <WidgetTelechargements ctx={ctx} />;
    case "completude": return <WidgetCompletude ctx={ctx} />;
    case "stockage": return <WidgetStockage ctx={ctx} />;
    case "qbit": return <WidgetQbit ctx={ctx} />;
    case "plex": return <WidgetPlex ctx={ctx} />;
    case "sorties": return <WidgetSorties ctx={ctx} />;
    case "genres": return <WidgetGenres />;
    case "actions": return <ActionsRapides onOuvrir={ctx.onOuvrir} onEcran={ctx.onEcran} />;
    default: return null;
  }
}

interface AlerteApp {
  source: string;
  niveau: "avertissement" | "erreur" | "critique";
  message: string;
}

/** Bloc « Alertes » : rien du tout quand tout va bien, pour ne pas encombrer l'accueil. */
function WidgetAlertes({ ctx }: { ctx: Contexte }) {
  const { data } = useApi<{ items: AlerteApp[] }>("/alertes", 120000);
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="card" aria-label="Alertes">
      <TitreCarte couleur="#f87171" droite={<span className="chip warn">{items.length}</span>}>
        Alertes
      </TitreCarte>
      <ul className="alertes-liste">
        {items.map((a, i) => {
          const id = a.source.toLowerCase();
          const ouvrable = ctx.sante?.some((s) => s.id === id) ?? false;
          return (
            <li key={i} className={`alerte ${a.niveau}`}>
              {ouvrable ? (
                <button className="alerte-bouton" onClick={() => ctx.onService(id)}>
                  <strong>{a.source}</strong> · {a.message}
                </button>
              ) : (
                <span className="alerte-bouton">
                  <strong>{a.source}</strong> · {a.message}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WidgetServices({ ctx }: { ctx: Contexte }) {
  const { sante, accueil, onService } = ctx;
  if (!sante || sante.length === 0) return null;
  const enLigne = sante.filter((s) => s.ok).length;
  return (
    <section className="card" aria-label="Services">
      <TitreCarte
        couleur="#a78bfa"
        droite={
          <span className={enLigne === sante.length ? "chip" : "chip warn"}>
            {enLigne}/{sante.length} en ligne
          </span>
        }
      >
        Services
      </TitreCarte>
      <div className="tuiles">
        {sante.map((s) => (
          <button
            key={s.id}
            className={s.ok ? "tuile" : "tuile down"}
            onClick={() => (s.lien ? window.open(s.lien, "_blank", "noopener,noreferrer") : onService(s.id))}
          >
            <span className="tuile-nom">
              <span className="pt" style={{ background: s.ok ? "#4ade80" : "#f87171" }} />
              {s.label}
            </span>
            <span className="tuile-sub">{detailService(s, accueil.data)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function WidgetAjout({ ctx }: { ctx: Contexte }) {
  const [saisie, setSaisie] = useState("");
  const d = ctx.accueil.data;
  if (!d?.films && !d?.series) return null;
  return (
    <form
      className="card"
      aria-label="Ajouter un média"
      onSubmit={(e) => {
        e.preventDefault();
        ctx.onAjouter(saisie.trim());
        setSaisie("");
      }}
    >
      <TitreCarte couleur="#4f9cf9">Ajouter un média</TitreCarte>
      <div className="ajout-ligne">
        <label className="recherche">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            aria-label="Rechercher un film ou une série à ajouter"
            placeholder="Film ou série à ajouter…"
            value={saisie}
            onChange={(e) => setSaisie(e.target.value)}
          />
        </label>
        <button type="submit" className="rond plein" aria-label="Chercher">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14m-5-5l5 5-5 5" />
          </svg>
        </button>
      </div>
      <span className="muted">Envoie vers Radarr ou Sonarr selon le type.</span>
    </form>
  );
}

function WidgetApercu({ ctx }: { ctx: Contexte }) {
  const d = ctx.accueil.data;
  if (!d?.films && !d?.series) return null;
  return (
    <section className="compteurs" aria-label="Vue d'ensemble">
      {d.films && (
        <div className="card compteur">
          <span className="compteur-n" style={{ color: COULEURS.radarr }}>
            {d.films.ok ? entier(d.films.total) : "—"}
          </span>
          <span className="muted">Films</span>
          <span className="muted">
            {d.films.ok ? `${entier(d.films.disponibles)} disponible${d.films.disponibles > 1 ? "s" : ""}` : "Radarr injoignable"}
          </span>
        </div>
      )}
      {d.series && (
        <div className="card compteur">
          <span className="compteur-n" style={{ color: COULEURS.sonarr }}>
            {d.series.ok ? entier(d.series.total) : "—"}
          </span>
          <span className="muted">Séries</span>
          <span className="muted">
            {d.series.ok ? `${entier(d.series.episodes)} épisode${d.series.episodes > 1 ? "s" : ""}` : "Sonarr injoignable"}
          </span>
        </div>
      )}
    </section>
  );
}

function WidgetTelechargements({ ctx }: { ctx: Contexte }) {
  const derniers = useApi<{ items: Telechargement[] }>("/telechargements", 120000);
  if ((derniers.data?.items.length ?? 0) === 0) return null;
  return (
    <section aria-label="Derniers téléchargements">
      <div className="carte-titre-libre">
        <TitreCarte couleur="#f59e42">Derniers téléchargements</TitreCarte>
      </div>
      <div className="carrousel">
        {derniers.data!.items.map((i) => (
          <button key={`${i.type}-${i.id}`} className="vignette" onClick={() => ctx.onOuvrir(i.type, i.id)}>
            <Affiche src={i.affiche} titre={i.titre} className="vignette-img" />
            <span className="strong">
              {i.titre}
              {i.sousTitre ? ` · ${i.sousTitre}` : ""}
            </span>
            <span className="muted">{dateCourte(i.date)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function WidgetCompletude({ ctx }: { ctx: Contexte }) {
  const d = ctx.accueil.data;
  const films = d?.films?.ok && d.films.total > 0 ? d.films : null;
  const series = d?.series?.ok && d.series.episodesTotal > 0 ? d.series : null;
  if (!films && !series) return null;
  return (
    <section className="card" aria-label="Complétude">
      <TitreCarte couleur="#4f9cf9">Complétude</TitreCarte>
      <div className="barres">
        {films && <BarreStat nom="Films" couleur={COULEURS.radarr} ratio={films.disponibles / films.total} detail={`${entier(films.disponibles)} / ${entier(films.total)}`} />}
        {series && <BarreStat nom="Séries" couleur={COULEURS.sonarr} ratio={series.episodes / series.episodesTotal} detail={`${entier(series.episodes)} / ${entier(series.episodesTotal)}`} />}
      </div>
    </section>
  );
}

function WidgetStockage({ ctx }: { ctx: Contexte }) {
  const d = ctx.accueil.data;
  const parts = [
    d?.series?.ok && { nom: "Sonarr", couleur: COULEURS.sonarr, octets: d.series.tailleOctets },
    d?.films?.ok && { nom: "Radarr", couleur: COULEURS.radarr, octets: d.films.tailleOctets },
  ].filter((p): p is { nom: string; couleur: string; octets: number } => Boolean(p) && (p as { octets: number }).octets > 0);
  const total = parts.reduce((n, p) => n + p.octets, 0);
  if (total <= 0) return null;
  return (
    <section className="card" aria-label="Stockage">
      <TitreCarte couleur="#a78bfa">Stockage</TitreCarte>
      <div className="stock-total">{taille(total)}</div>
      <div className="muted">Occupé par la médiathèque</div>
      <div className="repartition" role="img" aria-label="Répartition Sonarr et Radarr">
        {parts.map((p) => (
          <div key={p.nom} style={{ flex: p.octets, background: p.couleur }} />
        ))}
      </div>
      <ul className="legende">
        {parts.map((p) => (
          <li key={p.nom}>
            <span className="stripe" style={{ background: p.couleur }} />
            <span className="strong">{p.nom}</span>
            <span className="muted">{pourcent(p.octets / total)}</span>
            <span className="strong">{taille(p.octets)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WidgetQbit({ ctx }: { ctx: Contexte }) {
  const q = ctx.accueil.data?.qbit;
  if (!q) return null;
  return (
    <section className="card" aria-label="qBittorrent">
      <TitreCarte
        couleur="#60a5fa"
        droite={
          q.ok && (
            <span className="muted strong">
              {q.actifs} actif{q.actifs > 1 ? "s" : ""}
            </span>
          )
        }
      >
        qBittorrent
      </TitreCarte>
      {q.ok ? (
        <>
          <div className="vitesses">
            <span>↓ {vitesse(q.telechargement)}</span>
            <span className="muted">↑ {vitesse(q.envoi)}</span>
            {q.principal?.resteSec != null && <span className="muted">Reste {reste(q.principal.resteSec)}</span>}
          </div>
          {q.principal ? (
            <>
              <div className="muted ligne">
                {q.principal.nom} — {Math.round(q.principal.progression * 100)} %
              </div>
              <div className="jauge" role="progressbar" aria-valuenow={Math.round(q.principal.progression * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${Math.round(q.principal.progression * 100)}%` }} />
              </div>
            </>
          ) : (
            <div className="muted">Aucun téléchargement en cours.</div>
          )}
        </>
      ) : (
        <div className="muted">qBittorrent injoignable.</div>
      )}
    </section>
  );
}

function WidgetPlex({ ctx }: { ctx: Contexte }) {
  const p = ctx.accueil.data?.plex;
  if (!p) return null;
  return (
    <section className="card" aria-label="Plex">
      <TitreCarte couleur="#fbbf24">Plex — en lecture</TitreCarte>
      {!p.ok ? (
        <ErreurPlex echec={p} />
      ) : p.lectures.length === 0 ? (
        <div className="muted">Aucune lecture en cours.</div>
      ) : (
        <ul className="flux">
          {p.lectures.map((l, i) => (
            <li key={i}>
              <Affiche src={l.affiche} titre={l.titre} className="flux-img" />
              <div>
                <div className="strong">{l.titre}</div>
                <div className="muted">
                  {l.utilisateur}
                  {l.appareil ? ` · ${l.appareil}` : ""}
                  {l.etat === "paused" ? " · en pause" : ""}
                </div>
                <div className="muted">
                  {l.transcode ? "Transcodage" : "Lecture directe"}
                  {l.resolution ? ` · ${l.resolution}p` : ""}
                  {` · ${l.local ? "réseau local" : "à distance"}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WidgetSorties({ ctx }: { ctx: Contexte }) {
  const sorties = useApi<{ items: ItemCalendrier[] }>("/calendrier?jours=7", 300000);
  const prochaines = (sorties.data?.items ?? []).filter((i) => !i.disponible).slice(0, 8);
  if (prochaines.length === 0) return null;
  return (
    <section aria-label="Prochaines sorties">
      <div className="carte-titre-libre">
        <TitreCarte couleur="#4f9cf9">Prochaines sorties</TitreCarte>
      </div>
      <div className="carrousel">
        {prochaines.map((i) => (
          <button key={`${i.type}-${i.id}-${i.date}`} className="vignette" onClick={() => ctx.onOuvrir(i.type, i.id)}>
            <Affiche src={i.affiche} titre={i.titre} className="vignette-img" />
            <span className="strong">
              {i.titre}
              {i.type === "serie" ? ` · ${i.sousTitre}` : ""}
            </span>
            <span className="muted">
              {jourCourt(cleJourItem(i))}
              {i.heure ? ` · ${heure(i.date)}` : ""}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function WidgetGenres() {
  const stats = useApi<Statistiques>("/stats");
  const genres = (stats.data?.genres ?? []).slice(0, 5);
  return (
    <section className="card" aria-label="Genres">
      <TitreCarte couleur="#4caf8a">Genres</TitreCarte>
      {stats.erreur && <div className="muted">{stats.erreur}</div>}
      {stats.chargement && !stats.data && <div className="muted">Calcul en cours…</div>}
      {stats.data && genres.length === 0 && <div className="muted">Aucun genre connu.</div>}
      {genres.length > 0 && <Anneau titre="Genres les plus présents" parts={genres.map((g) => ({ nom: g.nom, valeur: g.total }))} />}
    </section>
  );
}

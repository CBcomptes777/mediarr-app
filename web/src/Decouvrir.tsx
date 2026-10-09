import { useCallback, useEffect, useMemo, useState } from "react";
import { action, api, ErreurApi } from "./api";
import {
  anneesProposees, cleCarte, dejaPris, ecrireReglageDecouvrir, fusionner, LIBELLE_STATUT, lireReglageDecouvrir, visibles,
  type CarteTitre, type ReglageDecouvrir, type StatutTitre, type TypeTitre,
} from "./decouvrirLogique";
import { Affiche, DialogueConfirmation, Feuille, Message } from "./ui";
import { useApi } from "./useApi";

interface Page {
  page: number;
  pages: number;
  items: CarteTitre[];
}
interface Genres {
  films: { id: number; nom: string }[];
  series: { id: number; nom: string }[];
}
interface Fiche extends CarteTitre {
  genres: string[];
  dureeMin: number | null;
  distribution: { nom: string; role: string | null; photo: string | null }[];
  bandeAnnonce: string | null;
  saisons: { numero: number; episodes: number; statut: StatutTitre }[];
}

type Surcharges = ReadonlyMap<string, StatutTitre>;

const RANGEES: { id: string; titre: string; type: "tout" | TypeTitre }[] = [
  { id: "tendances", titre: "Tendances", type: "tout" },
  { id: "films", titre: "Films populaires", type: "film" },
  { id: "series", titre: "Séries populaires", type: "serie" },
  { id: "films-avenir", titre: "Films à venir", type: "film" },
  { id: "series-avenir", titre: "Séries à venir", type: "serie" },
];

/** Charge une liste paginée d'Overseerr : la page 1 tout de suite, les suivantes à la demande (« Voir plus »). */
function usePages(base: string | null) {
  const [etat, setEtat] = useState<{ items: CarteTitre[]; page: number; pages: number }>({ items: [], page: 0, pages: 1 });
  const [chargement, setChargement] = useState(base !== null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(
    async (page: number, annule: () => boolean) => {
      if (base === null) return;
      setChargement(true);
      setErreur(null);
      try {
        const r = await api<Page>(`${base}${base.includes("?") ? "&" : "?"}page=${page}`);
        if (annule()) return;
        setEtat((e) => ({ items: page === 1 ? r.items : fusionner(e.items, r.items), page: r.page, pages: r.pages }));
      } catch (e) {
        if (!annule()) setErreur(e instanceof ErreurApi ? e.message : "Serveur Mediarr injoignable.");
      } finally {
        if (!annule()) setChargement(false);
      }
    },
    [base],
  );

  useEffect(() => {
    let fini = false;
    setEtat({ items: [], page: 0, pages: 1 });
    if (base !== null) charger(1, () => fini);
    return () => {
      fini = true;
    };
  }, [base, charger]);

  return { ...etat, chargement, erreur, encore: etat.page > 0 && etat.page < etat.pages, plus: () => charger(etat.page + 1, () => false) };
}

function Carte({ c, onOuvrir }: { c: CarteTitre; onOuvrir: (c: CarteTitre) => void }) {
  return (
    <button className="carte-decouvrir" onClick={() => onOuvrir(c)} aria-label={`${c.titre}${c.annee ? ` (${c.annee})` : ""}${c.statut ? `, ${LIBELLE_STATUT[c.statut]}` : ""}`}>
      <div className="carte-decouvrir-img">
        <Affiche src={c.affiche} titre={c.titre} className="media-img" />
        {c.statut && <span className={`badge-statut ${c.statut}`}>{LIBELLE_STATUT[c.statut]}</span>}
      </div>
      <span className="carte-decouvrir-titre">{c.titre}</span>
      <span className="muted">
        {[c.annee, c.note ? `★ ${String(c.note).replace(".", ",")}` : null].filter(Boolean).join(" · ")}
      </span>
    </button>
  );
}

function Rangee({ titre, base, reglage, surcharges, onOuvrir }: {
  titre: string;
  base: string;
  reglage: ReglageDecouvrir;
  surcharges: Surcharges;
  onOuvrir: (c: CarteTitre) => void;
}) {
  const { items, chargement, erreur, encore, plus } = usePages(base);
  const liste = visibles(items, reglage, surcharges);
  if (!chargement && !erreur && liste.length === 0 && !encore) return null;
  return (
    <section className="rangee" aria-label={titre}>
      <h2 className="sous-titre">{titre}</h2>
      {erreur && <Message erreur>{erreur}</Message>}
      <div className="rangee-defil">
        {liste.map((c) => (
          <Carte key={cleCarte(c)} c={c} onOuvrir={onOuvrir} />
        ))}
        {chargement && items.length === 0 && <span className="muted">Chargement…</span>}
        {encore && (
          <button className="carte-decouvrir plus" disabled={chargement} onClick={plus}>
            {chargement ? "…" : "Voir plus"}
          </button>
        )}
      </div>
    </section>
  );
}

function Grille({ base, reglage, surcharges, onOuvrir, vide }: {
  base: string;
  reglage: ReglageDecouvrir;
  surcharges: Surcharges;
  onOuvrir: (c: CarteTitre) => void;
  vide: string;
}) {
  const { items, chargement, erreur, encore, plus } = usePages(base);
  const liste = visibles(items, reglage, surcharges);
  return (
    <>
      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && items.length === 0 && <Message>Chargement…</Message>}
      {!chargement && !erreur && liste.length === 0 && <Message>{vide}</Message>}
      <div className="grille-decouvrir">
        {liste.map((c) => (
          <Carte key={cleCarte(c)} c={c} onOuvrir={onOuvrir} />
        ))}
      </div>
      {encore && (
        <button className="bouton violet" disabled={chargement} onClick={plus}>
          {chargement ? "Chargement…" : "Voir plus"}
        </button>
      )}
    </>
  );
}

export function Decouvrir({ onDemande }: { onDemande: () => void }) {
  const [reglage, setReglage] = useState(() => lireReglageDecouvrir(typeof localStorage === "undefined" ? undefined : localStorage));
  const [saisie, setSaisie] = useState("");
  const [terme, setTerme] = useState("");
  const [fiche, setFiche] = useState<CarteTitre | null>(null);
  const [surcharges, setSurcharges] = useState<Map<string, StatutTitre>>(new Map());
  const genres = useApi<Genres>("/decouvrir/genres");

  const maj = (r: Partial<ReglageDecouvrir>) => {
    const suite = { ...reglage, ...r };
    // Choisir un genre ou une année suppose de savoir si on parle de films ou de séries.
    if ((r.genre || r.annee) && suite.type === "tout") suite.type = "film";
    if (r.type && r.type !== reglage.type) suite.genre = null; // les genres des films et des séries diffèrent
    setReglage(suite);
    ecrireReglageDecouvrir(typeof localStorage === "undefined" ? undefined : localStorage, suite);
  };

  const listeGenres = reglage.type === "serie" ? genres.data?.series : genres.data?.films;
  const filtreActif = reglage.genre !== null || reglage.annee !== null;
  const base = useMemo(() => {
    if (!filtreActif || reglage.type === "tout") return null;
    const q = [`type=${reglage.type}`, reglage.genre ? `genre=${reglage.genre}` : "", reglage.annee ? `annee=${reglage.annee}` : ""].filter(Boolean);
    return `/decouvrir/liste?${q.join("&")}`;
  }, [filtreActif, reglage]);
  const nomGenre = listeGenres?.find((g) => g.id === reglage.genre)?.nom;

  return (
    <>
      <form
        className="ajout-ligne"
        onSubmit={(e) => {
          e.preventDefault();
          setTerme(saisie.trim());
        }}
      >
        <label className="recherche">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            aria-label="Rechercher un titre à demander"
            placeholder="Rechercher un titre à demander…"
            value={saisie}
            onChange={(e) => {
              setSaisie(e.target.value);
              if (e.target.value.trim() === "") setTerme("");
            }}
          />
        </label>
        <button type="submit" className="rond plein" aria-label="Chercher" disabled={saisie.trim().length < 2}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14m-5-5l5 5-5 5" />
          </svg>
        </button>
      </form>

      <div className="segments" role="tablist" aria-label="Type">
        {([["tout", "Tout"], ["film", "Films"], ["serie", "Séries"]] as const).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={reglage.type === t} className={reglage.type === t ? "actif" : ""} onClick={() => maj({ type: t })}>
            {l}
          </button>
        ))}
      </div>

      <div className="filtres-selects">
        <label className="champ-compact">
          <span>Genre</span>
          <select value={reglage.genre ?? ""} onChange={(e) => maj({ genre: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Tous</option>
            {(listeGenres ?? genres.data?.films ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.nom}
              </option>
            ))}
          </select>
        </label>
        <label className="champ-compact">
          <span>Année</span>
          <select value={reglage.annee ?? ""} onChange={(e) => maj({ annee: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Toutes</option>
            {anneesProposees(new Date().getFullYear()).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="case compact">
        <input type="checkbox" checked={reglage.masquerPossedes} onChange={(e) => maj({ masquerPossedes: e.target.checked })} />
        <span>Masquer ce que j'ai déjà</span>
      </label>
      {filtreActif && (
        <button className="lien" onClick={() => maj({ genre: null, annee: null })}>
          Effacer genre et année
        </button>
      )}

      {genres.erreur && <Message erreur>{genres.erreur}</Message>}

      {terme.length >= 2 ? (
        <>
          <h2 className="sous-titre">Résultats pour « {terme} »</h2>
          <Grille base={`/decouvrir/recherche?q=${encodeURIComponent(terme)}`} reglage={reglage} surcharges={surcharges} onOuvrir={setFiche} vide="Aucun résultat." />
        </>
      ) : base ? (
        <>
          <h2 className="sous-titre">
            {reglage.type === "film" ? "Films" : "Séries"}
            {nomGenre ? ` · ${nomGenre}` : ""}
            {reglage.annee ? ` · ${reglage.annee}` : ""}
          </h2>
          <Grille key={base} base={base} reglage={reglage} surcharges={surcharges} onOuvrir={setFiche} vide="Rien ne correspond à ces filtres." />
        </>
      ) : (
        <>
          {RANGEES.filter((r) => reglage.type === "tout" || r.type === "tout" || r.type === reglage.type).map((r) => (
            <Rangee key={r.id} titre={r.titre} base={`/decouvrir/liste?rangee=${r.id}`} reglage={reglage} surcharges={surcharges} onOuvrir={setFiche} />
          ))}
          {(listeGenres ?? genres.data?.films ?? []).length > 0 && (
            <section className="rangee" aria-label="Par genre">
              <h2 className="sous-titre">Par genre</h2>
              <div className="filtres enroule">
                {(listeGenres ?? genres.data?.films ?? []).map((g) => (
                  <button key={g.id} onClick={() => maj({ genre: g.id, type: reglage.type === "tout" ? "film" : reglage.type })}>
                    {g.nom}
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {fiche && (
        <FicheTitre
          carte={fiche}
          onFermer={() => setFiche(null)}
          onDemande={(c) => {
            setSurcharges((m) => new Map(m).set(cleCarte(c), "demande"));
            onDemande();
          }}
        />
      )}
    </>
  );
}

function FicheTitre({ carte, onFermer, onDemande }: { carte: CarteTitre; onFermer: () => void; onDemande: (c: CarteTitre) => void }) {
  const { data: f, erreur, chargement, recharger } = useApi<Fiche>(`/decouvrir/fiche/${carte.type}/${carte.tmdbId}`);
  const [choix, setChoix] = useState<Set<number> | null>(null);
  const [confirmer, setConfirmer] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [resultat, setResultat] = useState<{ ok: boolean; texte: string } | null>(null);

  // Série : toutes les saisons encore libres sont cochées au départ.
  const libres = (f?.saisons ?? []).filter((s) => s.statut === null).map((s) => s.numero);
  const selection = choix ?? new Set(libres);
  const film = carte.type === "film";
  const statut = f?.statut ?? carte.statut;
  const demandable = film ? !dejaPris(statut) : [...selection].some((n) => libres.includes(n));

  async function demander() {
    setConfirmer(false);
    setOccupe(true);
    setResultat(null);
    try {
      await action("POST", "/decouvrir/demander", { type: carte.type, tmdbId: carte.tmdbId, ...(film ? {} : { saisons: [...selection].filter((n) => libres.includes(n)) }) });
      setResultat({ ok: true, texte: "Demande envoyée à Overseerr." });
      onDemande(carte);
      setChoix(null);
      recharger();
    } catch (e) {
      setResultat({ ok: false, texte: e instanceof Error ? e.message : "Demande impossible" });
    } finally {
      setOccupe(false);
    }
  }

  return (
    <Feuille titre={carte.titre} sousTitre={[carte.annee, film ? "Film" : "Série"].filter(Boolean).join(" · ")} onFermer={onFermer}>
      {chargement && !f && <Message>Chargement…</Message>}
      {erreur && <Message erreur>{erreur}</Message>}
      <div className="fiche-decouvrir">
        <Affiche src={f?.affiche ?? carte.affiche} titre={carte.titre} className="demande-img" w={500} />
        <div className="fiche-decouvrir-texte">
          {statut && <span className={`badge-statut ${statut} en-ligne`}>{LIBELLE_STATUT[statut]}</span>}
          <span className="muted">
            {[(f?.note ?? carte.note) ? `★ ${String(f?.note ?? carte.note).replace(".", ",")}` : null, f?.dureeMin ? `${f.dureeMin} min` : null, f?.genres.join(", ")].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      {(f?.synopsis || carte.synopsis) && <p className="synopsis">{f?.synopsis || carte.synopsis}</p>}
      {f?.bandeAnnonce && (
        <a className="bouton violet" href={f.bandeAnnonce} target="_blank" rel="noopener noreferrer">
          Voir la bande-annonce ↗
        </a>
      )}

      {f && f.distribution.length > 0 && (
        <>
          <h3 className="sous-titre">Distribution</h3>
          <div className="rangee-defil">
            {f.distribution.map((a, i) => (
              <div key={`${a.nom}-${i}`} className="acteur">
                <Affiche src={a.photo} titre={a.nom} className="acteur-img" />
                <span className="strong">{a.nom}</span>
                {a.role && <span className="muted">{a.role}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {f && !film && f.saisons.length > 0 && (
        <fieldset className="groupe-filtre">
          <legend>Saisons à demander</legend>
          {f.saisons.map((s) => {
            const pris = s.statut !== null;
            return (
              <label key={s.numero} className="case compact">
                <input
                  type="checkbox"
                  disabled={pris}
                  checked={!pris && selection.has(s.numero)}
                  onChange={(e) => {
                    const n = new Set(selection);
                    if (e.target.checked) n.add(s.numero);
                    else n.delete(s.numero);
                    setChoix(n);
                  }}
                />
                <span>
                  Saison {s.numero} · {s.episodes} épisodes
                  {s.statut ? ` — ${LIBELLE_STATUT[s.statut]}` : ""}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {resultat && (
        <p className={resultat.ok ? "card" : "card error"} role={resultat.ok ? "status" : "alert"}>
          {resultat.texte}
        </p>
      )}
      <button className="bouton plein" disabled={!f || !demandable || occupe} onClick={() => setConfirmer(true)}>
        {occupe ? "Envoi…" : film && dejaPris(statut) ? (statut === "demande" ? "Déjà demandé" : "Déjà disponible") : !film && !demandable && f ? "Rien à demander" : "Demander"}
      </button>

      {confirmer && (
        <DialogueConfirmation
          titre="Envoyer cette demande ?"
          texte={`${carte.titre}${film ? "" : ` — saison${selection.size > 1 ? "s" : ""} ${[...selection].filter((n) => libres.includes(n)).sort((a, b) => a - b).join(", ")}`} sera demandé à Overseerr.`}
          boutons={[{ libelle: "Demander", variante: "plein", onClick: demander }]}
          onAnnuler={() => setConfirmer(false)}
        />
      )}
    </Feuille>
  );
}

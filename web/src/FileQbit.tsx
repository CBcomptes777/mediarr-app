import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { action, api, ErreurApi, UnauthorizedError } from "./api";
import { entier, reste, taille, vitesse } from "./format";
import { usePrefs } from "./prefs";
import {
  compterGroupes, ecrireReglageQbit, FILTRES_QBIT_VIDES, filtrerTorrents, GROUPES, koVersOctets, lireReglageQbit, nbFiltresQbit, octetsVersKo,
  SANS_CATEGORIE, trierTorrents, TRIS_QBIT, type EtatQbitApp, type FiltresQbit, type Groupe, type ReglageQbit, type TorrentApp, type TriQbit,
} from "./qbitLogique";
import { TorrentFeuille } from "./TorrentFeuille";
import { DialogueConfirmation, Feuille, Message } from "./ui";

/** Lit l'état de qBittorrent toutes les 3 s tant que l'écran est ouvert ET visible (par différences : `v` évite de renvoyer la liste inchangée). */
function useQbit(signal: number) {
  const [etat, setEtat] = useState<EtatQbitApp | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const version = useRef(0);

  const charger = useCallback(async () => {
    try {
      const r = await api<EtatQbitApp | { inchange: true; v: number }>(`/qbit/etat?v=${version.current}`);
      if (!("inchange" in r)) {
        version.current = r.v;
        setEtat(r);
      }
      setErreur(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) return;
      setErreur(e instanceof ErreurApi ? e.message : "Serveur Mediarr injoignable. Le VPN est-il actif ?");
    }
  }, []);

  useEffect(() => {
    let arrete = false;
    let generation = 0;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    const boucle = async (g: number) => {
      if (!document.hidden) await charger();
      if (arrete || g !== generation) return;
      minuteur = setTimeout(() => boucle(g), 3000);
    };
    boucle(generation);
    const visibilite = () => {
      if (document.hidden) return;
      generation++;
      clearTimeout(minuteur);
      boucle(generation);
    };
    document.addEventListener("visibilitychange", visibilite);
    return () => {
      arrete = true;
      clearTimeout(minuteur);
      document.removeEventListener("visibilitychange", visibilite);
    };
  }, [charger]);

  // Relecture immédiate quand l'écran parent le demande (après un ajout).
  useEffect(() => {
    if (signal > 0) charger();
  }, [signal, charger]);

  return { etat, erreur, rafraichir: charger };
}

const pct = (x: number) => `${Math.floor(x * 100)} %`;

/** File d'attente qBittorrent : liste filtrable et triable, sélection multiple (appui long), actions, détails. */
export function FileQbit({ signal }: { signal: number }) {
  const { etat, erreur, rafraichir } = useQbit(signal);
  const { prefs } = usePrefs();
  const [reglage, setReglage] = useState<ReglageQbit>(() => lireReglageQbit(typeof localStorage === "undefined" ? undefined : localStorage));
  const { filtres, tri } = reglage;
  const maj = (f: FiltresQbit, t: TriQbit = tri) => {
    const r = { filtres: f, tri: t };
    setReglage(r);
    ecrireReglageQbit(typeof localStorage === "undefined" ? undefined : localStorage, r);
  };

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [menuFiltres, setMenuFiltres] = useState(false);
  const [menuVitesse, setMenuVitesse] = useState(false);
  const [categorieDe, setCategorieDe] = useState<string[] | null>(null);
  const [etiquettesDe, setEtiquettesDe] = useState<string[] | null>(null);
  const [asupprimer, setAsupprimer] = useState<{ torrents: TorrentApp[]; fichiers?: boolean } | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const tous = etat?.torrents ?? [];
  const compteurs = useMemo(() => compterGroupes(tous), [tous]);
  const items = useMemo(() => trierTorrents(filtrerTorrents(tous, filtres), tri), [tous, filtres, tri]);
  const nbFiltres = nbFiltresQbit(filtres);
  const parHash = useMemo(() => new Map(tous.map((t) => [t.hash, t])), [tous]);
  const enSelection = selection.size > 0;
  const masquerSuppression = prefs.reglages.masquerSuppression;

  // Un torrent disparu (supprimé ailleurs) quitte la sélection et ferme sa feuille.
  useEffect(() => {
    if (!etat) return;
    setSelection((s) => {
      const reste = new Set([...s].filter((h) => parHash.has(h)));
      return reste.size === s.size ? s : reste;
    });
    if (detail && !parHash.has(detail)) setDetail(null);
  }, [etat, parHash, detail]);

  async function lot(verbe: string, hashes: string[], extra: object = {}): Promise<boolean> {
    setOccupe(true);
    setEchec(null);
    try {
      await action("POST", `/qbit/lot/${verbe}`, { hashes, ...extra });
      await rafraichir();
      return true;
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Action impossible");
      return false;
    } finally {
      setOccupe(false);
    }
  }

  async function supprimer(torrents: TorrentApp[], fichiers: boolean) {
    setAsupprimer(null);
    // La confirmation répète le nombre : le serveur refuse si ce nombre ne correspond pas.
    if (await lot("supprimer", torrents.map((t) => t.hash), { fichiers, confirme: true, compteur: torrents.length })) {
      setSelection(new Set());
      setDetail(null);
    }
  }

  const basculer = (hash: string) =>
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(hash)) n.delete(hash);
      else n.add(hash);
      return n;
    });

  const g = etat?.global;
  const choisis = [...selection].map((h) => parHash.get(h)).filter((t): t is TorrentApp => Boolean(t));

  return (
    <>
      <label className="recherche ambre">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <input aria-label="Chercher dans la file" placeholder="Chercher dans la file…" value={filtres.recherche} onChange={(e) => maj({ ...filtres, recherche: e.target.value })} />
      </label>

      {erreur && <Message erreur>{erreur}</Message>}
      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {!etat && !erreur && <Message>Chargement…</Message>}

      {g && (
        <section className="card ambre infos" aria-label="Vitesses">
          <div>
            <div className="muted">Vitesse</div>
            <div className="strong">
              ↓ {vitesse(g.vitesseDl)} · ↑ {vitesse(g.vitesseUp)}
            </div>
            <div className="muted">
              Limites : ↓ {g.limiteDl ? vitesse(g.limiteDl) : "illimité"} · ↑ {g.limiteUp ? vitesse(g.limiteUp) : "illimité"}
            </div>
          </div>
          <div className="paire">
            <button className={g.alternatif ? "rond actif-tortue" : "rond"} aria-pressed={g.alternatif} aria-label={g.alternatif ? "Vitesse alternative active : désactiver" : "Activer la vitesse alternative"} title="Vitesse alternative (tortue)" disabled={occupe}
              onClick={async () => {
                setOccupe(true);
                setEchec(null);
                try {
                  await action("POST", "/qbit/vitesse-alternative", { actif: !g.alternatif });
                  await rafraichir();
                } catch (e) {
                  setEchec(e instanceof Error ? e.message : "Action impossible");
                } finally {
                  setOccupe(false);
                }
              }}>
              <span aria-hidden="true">🐢</span>
            </button>
            <button className="rond" aria-label="Limites de vitesse" onClick={() => setMenuVitesse(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 14a8 8 0 1 1 16 0M12 14l4-4" />
              </svg>
            </button>
          </div>
        </section>
      )}

      {etat && (
        <>
          <div className="filtres defile" role="group" aria-label="Filtrer par état">
            <button className={filtres.groupes.length === 0 ? "actif" : ""} aria-pressed={filtres.groupes.length === 0} onClick={() => maj({ ...filtres, groupes: [] })}>
              Tous · {compteurs.tous}
            </button>
            {GROUPES.map((x) => (
              <button
                key={x.id}
                className={filtres.groupes.includes(x.id) ? "actif" : ""}
                aria-pressed={filtres.groupes.includes(x.id)}
                onClick={() => maj({ ...filtres, groupes: filtres.groupes.includes(x.id) ? filtres.groupes.filter((y) => y !== x.id) : [...filtres.groupes, x.id] })}
              >
                {x.libelle} · {compteurs[x.id]}
              </button>
            ))}
          </div>
          <div className="ligne-tri">
            <label className="champ-compact">
              <span>Trier par</span>
              <select value={tri.cle} onChange={(e) => maj(filtres, { ...tri, cle: e.target.value as TriQbit["cle"] })}>
                {TRIS_QBIT.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.libelle}
                  </option>
                ))}
              </select>
            </label>
            <button className="rond" aria-label={tri.desc ? "Ordre décroissant, passer en croissant" : "Ordre croissant, passer en décroissant"} onClick={() => maj(filtres, { ...tri, desc: !tri.desc })}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: tri.desc ? "none" : "scaleY(-1)" }}>
                <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
              </svg>
            </button>
            <button className="rond bouton-filtre" aria-label={nbFiltres ? `Filtres, ${nbFiltres} actif${nbFiltres > 1 ? "s" : ""}` : "Filtres"} onClick={() => setMenuFiltres(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5h16l-6 8v5l-4 2v-7z" />
              </svg>
              {nbFiltres > 0 && <span className="pastille-nb">{nbFiltres}</span>}
            </button>
          </div>
          <div className="ligne-compteur" role="status">
            <span>
              {entier(items.length)} torrent{items.length > 1 ? "s" : ""}
            </span>
            {(nbFiltres > 0 || filtres.recherche) && (
              <button className="lien" onClick={() => maj(FILTRES_QBIT_VIDES)}>
                Tout effacer
              </button>
            )}
          </div>
        </>
      )}

      {etat && items.length === 0 && <Message>{tous.length === 0 ? "Aucun torrent dans qBittorrent." : "Aucun torrent avec ces filtres."}</Message>}
      {items.map((t) => (
        <LigneTorrent
          key={t.hash}
          t={t}
          enSelection={enSelection}
          choisi={selection.has(t.hash)}
          onBasculer={() => basculer(t.hash)}
          onOuvrir={() => setDetail(t.hash)}
        />
      ))}

      {enSelection && (
        <div className="barre-lot" role="toolbar" aria-label="Actions sur la sélection">
          <span className="strong">
            {selection.size} sélectionné{selection.size > 1 ? "s" : ""}
          </span>
          <button className="bouton violet" disabled={occupe} onClick={() => lot("pause", [...selection])}>
            Pause
          </button>
          <button className="bouton violet" disabled={occupe} onClick={() => lot("reprise", [...selection])}>
            Reprise
          </button>
          <button className="bouton violet" disabled={occupe} onClick={() => setCategorieDe([...selection])}>
            Catégorie
          </button>
          <button className="bouton violet" disabled={occupe} onClick={() => setEtiquettesDe([...selection])}>
            Étiquettes
          </button>
          {!masquerSuppression && (
            <button className="bouton violet danger" disabled={occupe} onClick={() => setAsupprimer({ torrents: choisis })}>
              Supprimer
            </button>
          )}
          <button className="bouton violet" onClick={() => setSelection(new Set(items.map((t) => t.hash)))}>
            Tout
          </button>
          <button className="bouton violet" onClick={() => setSelection(new Set())}>
            Annuler
          </button>
        </div>
      )}

      {detail && parHash.get(detail) && etat && (
        <TorrentFeuille
          torrent={parHash.get(detail)!}
          catalogue={etat}
          onFermer={() => setDetail(null)}
          onChange={rafraichir}
          onCategorie={() => setCategorieDe([detail])}
          onEtiquettes={() => setEtiquettesDe([detail])}
          onSupprimer={(avecFichiers) => setAsupprimer({ torrents: [parHash.get(detail)!], fichiers: avecFichiers })}
        />
      )}

      {menuFiltres && etat && <FeuilleFiltres etat={etat} filtres={filtres} onChange={(f) => maj(f)} onFermer={() => setMenuFiltres(false)} nbResultats={items.length} />}
      {menuVitesse && g && <FeuilleVitesse global={g} onFermer={() => setMenuVitesse(false)} onChange={rafraichir} />}
      {categorieDe && etat && <FeuilleCategorie hashes={categorieDe} etat={etat} onFermer={() => setCategorieDe(null)} onChange={rafraichir} />}
      {etiquettesDe && etat && <FeuilleEtiquettes hashes={etiquettesDe} etat={etat} onFermer={() => setEtiquettesDe(null)} onChange={rafraichir} />}
      {asupprimer && <ConfirmerSuppression torrents={asupprimer.torrents} fichiersDemandes={asupprimer.fichiers} onConfirmer={(f) => supprimer(asupprimer.torrents, f)} onAnnuler={() => setAsupprimer(null)} />}
    </>
  );
}

/** Une ligne : tap = détails (ou sélection si on est déjà en sélection) ; appui long = commence la sélection. */
function LigneTorrent({ t, enSelection, choisi, onBasculer, onOuvrir }: {
  t: TorrentApp;
  enSelection: boolean;
  choisi: boolean;
  onBasculer: () => void;
  onOuvrir: () => void;
}) {
  const minuteur = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const depart = useRef<{ x: number; y: number } | null>(null);
  const long = useRef(false);
  const annuler = () => clearTimeout(minuteur.current);
  const pc = Math.round(t.progression * 100);
  return (
    <article
      className={`card ambre torrent torrent-ligne${choisi ? " choisi" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={enSelection ? choisi : undefined}
      onPointerDown={(e) => {
        long.current = false;
        depart.current = { x: e.clientX, y: e.clientY };
        minuteur.current = setTimeout(() => {
          long.current = true;
          navigator.vibrate?.(15);
          onBasculer();
        }, 500);
      }}
      onPointerMove={(e) => {
        if (depart.current && Math.hypot(e.clientX - depart.current.x, e.clientY - depart.current.y) > 10) annuler(); // c'est un défilement
      }}
      onPointerUp={annuler}
      onPointerCancel={annuler}
      onPointerLeave={annuler}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (long.current) return void (long.current = false); // le relâchement de l'appui long n'est pas un tap
        if (enSelection) onBasculer();
        else onOuvrir();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (enSelection) onBasculer();
          else onOuvrir();
        }
      }}
    >
      <div className="torrent-tete">
        {enSelection && <span className={choisi ? "coche-selection on" : "coche-selection"} aria-hidden="true">{choisi ? "✓" : ""}</span>}
        <span className={t.etat.attention ? "etat-pilule attention" : "etat-pilule"}>{t.etat.libelle}</span>
        <span className="muted">{[t.categorie, ...t.etiquettes].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="torrent-nom">{t.nom}</div>
      <div className={t.etat.attention ? "jauge ambre attention" : "jauge ambre"} role="progressbar" aria-valuenow={pc} aria-valuemin={0} aria-valuemax={100} aria-label={t.nom}>
        <div style={{ width: `${pc}%` }} />
      </div>
      <div className="torrent-pied">
        <span>{pct(t.progression)}</span>
        <span>
          {taille(t.telechargesOctets)} / {taille(t.tailleOctets)}
          {t.vitesse > 0 ? ` · ↓ ${vitesse(t.vitesse)}` : ""}
          {t.vitesseEnvoi > 0 ? ` · ↑ ${vitesse(t.vitesseEnvoi)}` : ""}
          {t.resteSec != null && t.progression < 1 ? ` · ETA ${reste(t.resteSec)}` : ""}
          {t.ratio > 0 ? ` · ratio ${String(t.ratio).replace(".", ",")}` : ""}
        </span>
      </div>
    </article>
  );
}

// ---------- feuilles ----------

function Groupe_({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <fieldset className="groupe-filtre">
      <legend>{titre}</legend>
      <div className="filtres enroule" role="group" aria-label={titre}>
        {children}
      </div>
    </fieldset>
  );
}

function FeuilleFiltres({ etat, filtres, nbResultats, onChange, onFermer }: {
  etat: EtatQbitApp;
  filtres: FiltresQbit;
  nbResultats: number;
  onChange: (f: FiltresQbit) => void;
  onFermer: () => void;
}) {
  const bascule = <T extends string>(liste: T[], v: T) => (liste.includes(v) ? liste.filter((x) => x !== v) : [...liste, v]);
  const puce = (actif: boolean, texte: string, onClick: () => void) => (
    <button key={texte} className={actif ? "actif" : ""} aria-pressed={actif} onClick={onClick}>
      {texte}
    </button>
  );
  const c = compterGroupes(etat.torrents);
  return (
    <Feuille titre="Filtres" sousTitre={`${entier(nbResultats)} torrent${nbResultats > 1 ? "s" : ""}`} onFermer={onFermer}>
      <Groupe_ titre="État">{GROUPES.map((g) => puce(filtres.groupes.includes(g.id), `${g.libelle} · ${c[g.id as Groupe]}`, () => onChange({ ...filtres, groupes: bascule(filtres.groupes, g.id) })))}</Groupe_>
      <Groupe_ titre="Catégorie">
        {puce(filtres.categories.includes(SANS_CATEGORIE), "Sans catégorie", () => onChange({ ...filtres, categories: bascule(filtres.categories, SANS_CATEGORIE) }))}
        {etat.categories.map((x) => puce(filtres.categories.includes(x.nom), x.nom, () => onChange({ ...filtres, categories: bascule(filtres.categories, x.nom) })))}
      </Groupe_>
      {etat.etiquettes.length > 0 && <Groupe_ titre="Étiquette">{etat.etiquettes.map((x) => puce(filtres.etiquettes.includes(x), x, () => onChange({ ...filtres, etiquettes: bascule(filtres.etiquettes, x) })))}</Groupe_>}
      {etat.trackers.length > 0 && <Groupe_ titre="Tracker">{etat.trackers.map((x) => puce(filtres.trackers.includes(x), x, () => onChange({ ...filtres, trackers: bascule(filtres.trackers, x) })))}</Groupe_>}
      <div className="actions colonne">
        <button className="bouton violet" disabled={nbFiltresQbit(filtres) === 0} onClick={() => onChange({ ...FILTRES_QBIT_VIDES, recherche: filtres.recherche })}>
          Tout effacer
        </button>
        <button className="bouton plein" onClick={onFermer}>
          Voir {entier(nbResultats)} torrent{nbResultats > 1 ? "s" : ""}
        </button>
      </div>
    </Feuille>
  );
}

function FeuilleVitesse({ global: g, onFermer, onChange }: { global: EtatQbitApp["global"]; onFermer: () => void; onChange: () => void }) {
  const [dl, setDl] = useState(octetsVersKo(g.limiteDl));
  const [up, setUp] = useState(octetsVersKo(g.limiteUp));
  const [echec, setEchec] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const ok = koVersOctets(dl) !== null && koVersOctets(up) !== null;
  async function appliquer() {
    setOccupe(true);
    setEchec(null);
    try {
      await action("POST", "/qbit/vitesse", { dl: koVersOctets(dl), up: koVersOctets(up) });
      onChange();
      onFermer();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Limites non appliquées");
    } finally {
      setOccupe(false);
    }
  }
  return (
    <Feuille titre="Limites de vitesse" sousTitre="Globales, pour tout qBittorrent" onFermer={onFermer}>
      <p className="muted">En Ko/s ; vide ou 0 = illimité. Le mode « vitesse alternative » (tortue) a ses propres limites, réglées dans qBittorrent.</p>
      <div className="filtres-selects">
        <label className="champ-compact">
          <span>↓ Réception (Ko/s)</span>
          <input inputMode="decimal" value={dl} onChange={(e) => setDl(e.target.value)} placeholder="Illimité" />
        </label>
        <label className="champ-compact">
          <span>↑ Envoi (Ko/s)</span>
          <input inputMode="decimal" value={up} onChange={(e) => setUp(e.target.value)} placeholder="Illimité" />
        </label>
      </div>
      {!ok && <p className="card error">Un nombre positif, ou rien.</p>}
      {echec && <p className="card error" role="alert">{echec}</p>}
      <button className="bouton plein" disabled={occupe || !ok} onClick={appliquer}>
        Appliquer
      </button>
    </Feuille>
  );
}

function FeuilleCategorie({ hashes, etat, onFermer, onChange }: { hashes: string[]; etat: EtatQbitApp; onFermer: () => void; onChange: () => void }) {
  const [choix, setChoix] = useState("");
  const [nouvelle, setNouvelle] = useState("");
  const [chemin, setChemin] = useState("");
  const [echec, setEchec] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const creer = choix === "__nouvelle";
  async function appliquer() {
    setOccupe(true);
    setEchec(null);
    try {
      await action("POST", "/qbit/lot/categorie", { hashes, categorie: creer ? nouvelle.trim() : choix, ...(creer ? { creer: true, ...(chemin.trim() ? { chemin: chemin.trim() } : {}) } : {}) });
      onChange();
      onFermer();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Catégorie non appliquée");
    } finally {
      setOccupe(false);
    }
  }
  return (
    <Feuille titre="Catégorie" sousTitre={`${hashes.length} torrent${hashes.length > 1 ? "s" : ""}`} onFermer={onFermer}>
      <label className="champ-compact">
        <span>Catégorie</span>
        <select value={choix} onChange={(e) => setChoix(e.target.value)}>
          <option value="">Aucune catégorie</option>
          {etat.categories.map((c) => (
            <option key={c.nom} value={c.nom}>
              {c.nom}
            </option>
          ))}
          <option value="__nouvelle">Nouvelle catégorie…</option>
        </select>
      </label>
      {creer && (
        <>
          <label className="champ-compact">
            <span>Nom</span>
            <input value={nouvelle} maxLength={100} onChange={(e) => setNouvelle(e.target.value)} />
          </label>
          <label className="champ-compact">
            <span>Dossier (facultatif)</span>
            <input value={chemin} onChange={(e) => setChemin(e.target.value)} placeholder="/downloads/docus" autoCapitalize="off" autoCorrect="off" />
          </label>
        </>
      )}
      {echec && <p className="card error" role="alert">{echec}</p>}
      <button className="bouton plein" disabled={occupe || (creer && !nouvelle.trim())} onClick={appliquer}>
        Appliquer
      </button>
    </Feuille>
  );
}

function FeuilleEtiquettes({ hashes, etat, onFermer, onChange }: { hashes: string[]; etat: EtatQbitApp; onFermer: () => void; onChange: () => void }) {
  const [ajouter, setAjouter] = useState<Set<string>>(new Set());
  const [retirer, setRetirer] = useState<Set<string>>(new Set());
  const [nouvelle, setNouvelle] = useState("");
  const [echec, setEchec] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const bascule = (s: Set<string>, v: string) => {
    const n = new Set(s);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };
  const nouvelles = nouvelle.split(",").map((t) => t.trim()).filter(Boolean);
  const total = new Set([...etat.etiquettes, ...ajouter]);
  async function appliquer() {
    setOccupe(true);
    setEchec(null);
    try {
      await action("POST", "/qbit/lot/etiquettes", { hashes, ajouter: [...ajouter, ...nouvelles], retirer: [...retirer] });
      onChange();
      onFermer();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Étiquettes non appliquées");
    } finally {
      setOccupe(false);
    }
  }
  return (
    <Feuille titre="Étiquettes" sousTitre={`${hashes.length} torrent${hashes.length > 1 ? "s" : ""}`} onFermer={onFermer}>
      <fieldset className="groupe-filtre">
        <legend>Ajouter</legend>
        <div className="filtres enroule">
          {[...total].map((e) => (
            <button key={e} className={ajouter.has(e) ? "actif" : ""} aria-pressed={ajouter.has(e)} onClick={() => setAjouter((s) => bascule(s, e))}>
              {e}
            </button>
          ))}
        </div>
        <input value={nouvelle} onChange={(e) => setNouvelle(e.target.value)} placeholder="Nouvelles étiquettes, séparées par des virgules" aria-label="Nouvelles étiquettes" />
      </fieldset>
      {etat.etiquettes.length > 0 && (
        <fieldset className="groupe-filtre">
          <legend>Retirer</legend>
          <div className="filtres enroule">
            {etat.etiquettes.map((e) => (
              <button key={e} className={retirer.has(e) ? "actif" : ""} aria-pressed={retirer.has(e)} onClick={() => setRetirer((s) => bascule(s, e))}>
                {e}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {echec && <p className="card error" role="alert">{echec}</p>}
      <button className="bouton plein" disabled={occupe || (ajouter.size + retirer.size + nouvelles.length === 0)} onClick={appliquer}>
        Appliquer
      </button>
    </Feuille>
  );
}

/** Confirmation OBLIGATOIRE : répète le nom et la taille (ou le nombre de torrents) ; deux boutons distincts pour les fichiers. */
function ConfirmerSuppression({ torrents, fichiersDemandes, onConfirmer, onAnnuler }: {
  torrents: TorrentApp[];
  /** Quand on vient de « Supprimer avec les fichiers » dans la feuille : seul ce choix est proposé. */
  fichiersDemandes?: boolean;
  onConfirmer: (fichiers: boolean) => void;
  onAnnuler: () => void;
}) {
  const n = torrents.length;
  const total = torrents.reduce((s, t) => s + t.tailleOctets, 0);
  const texte =
    n === 1
      ? `${torrents[0].nom} — ${taille(torrents[0].tailleOctets)}`
      : `${n} torrents (${taille(total)} au total) : ${torrents.slice(0, 3).map((t) => t.nom).join(" ; ")}${n > 3 ? ` et ${n - 3} autre${n - 3 > 1 ? "s" : ""}` : ""}`;
  return (
    <DialogueConfirmation
      titre={n === 1 ? "Supprimer ce torrent ?" : `Supprimer ces ${n} torrents ?`}
      texte={texte}
      boutons={[
        ...(fichiersDemandes === true ? [] : [{ libelle: n === 1 ? "Supprimer (garder les fichiers)" : `Supprimer ${n} torrents (garder les fichiers)`, variante: "plein" as const, onClick: () => onConfirmer(false) }]),
        ...(fichiersDemandes === false ? [] : [{ libelle: n === 1 ? "Supprimer avec les fichiers" : `Supprimer ${n} torrents avec les fichiers`, variante: "danger" as const, onClick: () => onConfirmer(true) }]),
      ]}
      onAnnuler={onAnnuler}
    />
  );
}

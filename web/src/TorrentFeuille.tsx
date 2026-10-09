import { useState } from "react";
import { action } from "./api";
import { dateCourte, entier, ilYa, reste, taille, vitesse } from "./format";
import { usePrefs } from "./prefs";
import {
  construireArbre, groupeDe, koVersOctets, octetsVersKo, type EtatQbitApp, type FichierTorrent, type NoeudFichier, type TorrentApp,
} from "./qbitLogique";
import { Feuille, Interrupteur, Message } from "./ui";
import { useApi } from "./useApi";

type Onglet = "general" | "actions" | "fichiers" | "trackers" | "pairs";
const ONGLETS: { id: Onglet; libelle: string }[] = [
  { id: "general", libelle: "Général" },
  { id: "actions", libelle: "Actions" },
  { id: "fichiers", libelle: "Fichiers" },
  { id: "trackers", libelle: "Trackers" },
  { id: "pairs", libelle: "Pairs" },
];

const pct = (x: number) => `${Math.floor(x * 1000) / 10} %`.replace(".", ",");
const duree = (sec: number) => (sec >= 86400 ? `${Math.floor(sec / 86400)} j ${Math.floor((sec % 86400) / 3600)} h` : reste(sec));

/** Feuille d'un torrent : informations, actions, fichiers, trackers, pairs. */
export function TorrentFeuille({ torrent, catalogue, onFermer, onChange, onCategorie, onEtiquettes, onSupprimer }: {
  torrent: TorrentApp;
  catalogue: EtatQbitApp;
  onFermer: () => void;
  /** À appeler après une action : la liste est relue tout de suite. */
  onChange: () => void;
  onCategorie: () => void;
  onEtiquettes: () => void;
  onSupprimer: (avecFichiers: boolean) => void;
}) {
  const [onglet, setOnglet] = useState<Onglet>("general");
  return (
    <Feuille titre={torrent.nom} sousTitre={`${torrent.etat.libelle} · ${pct(torrent.progression)}`} onFermer={onFermer}>
      <div className="filtres defile" role="tablist" aria-label="Détails du torrent">
        {ONGLETS.map((o) => (
          <button key={o.id} role="tab" aria-selected={onglet === o.id} className={onglet === o.id ? "actif" : ""} onClick={() => setOnglet(o.id)}>
            {o.libelle}
          </button>
        ))}
      </div>
      {onglet === "general" && <General t={torrent} />}
      {onglet === "actions" && <Actions t={torrent} catalogue={catalogue} onChange={onChange} onCategorie={onCategorie} onEtiquettes={onEtiquettes} onSupprimer={onSupprimer} />}
      {onglet === "fichiers" && <Fichiers hash={torrent.hash} />}
      {onglet === "trackers" && <Trackers hash={torrent.hash} />}
      {onglet === "pairs" && <Pairs hash={torrent.hash} />}
    </Feuille>
  );
}

interface Proprietes {
  ajouteLe: string | null;
  termineLe: string | null;
  chemin: string;
  tailleOctets: number;
  telechargesOctets: number;
  partagesOctets: number;
  ratio: number;
  resteSec: number | null;
  tempsActifSec: number;
  tempsPartageSec: number;
  connexions: number;
  seeds: number;
  seedsTotal: number;
  pairs: number;
  pairsTotal: number;
  piecesTotal: number;
  piecesPresentes: number;
  taillePieceOctets: number;
  creePar: string | null;
  commentaire: string | null;
  hash: string;
}

function General({ t }: { t: TorrentApp }) {
  const { data: p, erreur } = useApi<Proprietes>(`/qbit/torrent/${t.hash}/general`, 5000);
  return (
    <>
      <div className="jauge ambre" role="progressbar" aria-valuenow={Math.round(t.progression * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t.nom}>
        <div style={{ width: `${Math.round(t.progression * 100)}%` }} />
      </div>
      {erreur && <Message erreur>{erreur}</Message>}
      <dl className="fichier-actuel">
        <div><dt>Progression</dt><dd>{pct(t.progression)}</dd></div>
        <div><dt>État</dt><dd>{t.etat.libelle}</dd></div>
        <div><dt>Taille</dt><dd>{taille(t.tailleOctets)}</dd></div>
        <div><dt>Ratio</dt><dd>{String(t.ratio).replace(".", ",")}</dd></div>
        <div><dt>Vitesse</dt><dd>↓ {vitesse(t.vitesse)} · ↑ {vitesse(t.vitesseEnvoi)}</dd></div>
        <div><dt>Temps restant</dt><dd>{t.resteSec != null ? reste(t.resteSec) : "—"}</dd></div>
        <div><dt>Seeds</dt><dd>{t.seeds} ({t.seedsTotal})</dd></div>
        <div><dt>Pairs</dt><dd>{t.pairs} ({t.pairsTotal})</dd></div>
        <div><dt>Catégorie</dt><dd>{t.categorie || "—"}</dd></div>
        <div><dt>Étiquettes</dt><dd>{t.etiquettes.join(", ") || "—"}</dd></div>
        <div><dt>Ajouté le</dt><dd>{t.ajouteLe ? `${dateCourte(t.ajouteLe)} (${ilYa(t.ajouteLe)})` : "—"}</dd></div>
        <div><dt>Terminé le</dt><dd>{t.termineLe ? dateCourte(t.termineLe) : "—"}</dd></div>
        <div><dt>Téléchargé</dt><dd>{taille(t.telechargesOctets)}</dd></div>
        <div><dt>Partagé</dt><dd>{taille(p?.partagesOctets ?? t.televersesOctets)}</dd></div>
        {p && (
          <>
            <div><dt>Temps actif</dt><dd>{duree(p.tempsActifSec)}</dd></div>
            <div><dt>Temps de partage</dt><dd>{duree(p.tempsPartageSec)}</dd></div>
            <div><dt>Pièces</dt><dd>{entier(p.piecesPresentes)} / {entier(p.piecesTotal)}</dd></div>
            <div><dt>Connexions</dt><dd>{p.connexions}</dd></div>
          </>
        )}
      </dl>
      <div className="champ">
        <span className="muted">Dossier</span>
        <code className="empreinte">{t.chemin}</code>
        <span className="muted">Empreinte (hash)</span>
        <code className="empreinte">{t.hash}</code>
        {p?.commentaire && <span className="muted">Commentaire : {p.commentaire}</span>}
        {p?.creePar && <span className="muted">Créé par {p.creePar}</span>}
      </div>
    </>
  );
}

function Actions({ t, catalogue, onChange, onCategorie, onEtiquettes, onSupprimer }: {
  t: TorrentApp;
  catalogue: EtatQbitApp;
  onChange: () => void;
  onCategorie: () => void;
  onEtiquettes: () => void;
  onSupprimer: (avecFichiers: boolean) => void;
}) {
  const { prefs } = usePrefs();
  const [retour, setRetour] = useState<{ ok: boolean; texte: string } | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [nom, setNom] = useState(t.nom);
  const [chemin, setChemin] = useState(t.chemin);
  const [dl, setDl] = useState(octetsVersKo(t.limiteDl));
  const [up, setUp] = useState(octetsVersKo(t.limiteUp));
  const dossiers = useApi<{ racines: string[] }>("/qbit/dossiers");
  const enPause = groupeDe(t) === "pause";

  async function faire(chemin: string, corps: unknown, ok = "Fait ✓") {
    setOccupe(true);
    setRetour(null);
    try {
      await action("POST", chemin, corps);
      setRetour({ ok: true, texte: ok });
      onChange();
    } catch (e) {
      setRetour({ ok: false, texte: e instanceof Error ? e.message : "Action impossible" });
    } finally {
      setOccupe(false);
    }
  }
  const lot = (verbe: string, extra: object = {}, ok?: string) => faire(`/qbit/lot/${verbe}`, { hashes: [t.hash], ...extra }, ok);
  const limitesOk = koVersOctets(dl) !== null && koVersOctets(up) !== null;

  return (
    <>
      {retour && (
        <p className={retour.ok ? "card" : "card error"} role={retour.ok ? "status" : "alert"}>
          {retour.texte}
        </p>
      )}
      <div className="actions colonne">
        <button className="bouton plein" disabled={occupe} onClick={() => lot(enPause ? "reprise" : "pause", {}, enPause ? "Reprise demandée ✓" : "Mis en pause ✓")}>
          {enPause ? "Reprendre" : "Mettre en pause"}
        </button>
        <button className="bouton violet" disabled={occupe} onClick={() => lot("forcer", {}, "Démarrage forcé ✓")}>
          Forcer le démarrage
        </button>
        <button className="bouton violet" disabled={occupe} onClick={() => lot("reverifier", {}, "Vérification lancée ✓")}>
          Revérifier les fichiers
        </button>
        <button className="bouton violet" disabled={occupe} onClick={() => lot("reannoncer", {}, "Réannoncé aux trackers ✓")}>
          Réannoncer aux trackers
        </button>
      </div>

      <fieldset className="groupe-filtre">
        <legend>Priorité dans la file</legend>
        <div className="filtres enroule">
          {([["max", "Maximale"], ["haut", "Plus haute"], ["bas", "Plus basse"], ["min", "Minimale"]] as const).map(([niveau, libelle]) => (
            <button key={niveau} disabled={occupe} onClick={() => lot("priorite", { niveau }, `Priorité ${libelle.toLowerCase()} ✓`)}>
              {libelle}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="actions colonne">
        <button className="bouton violet" onClick={onCategorie}>
          Catégorie : {t.categorie || "aucune"} …
        </button>
        <button className="bouton violet" onClick={onEtiquettes}>
          Étiquettes : {t.etiquettes.join(", ") || "aucune"} …
        </button>
      </div>

      <Interrupteur libelle="Téléchargement séquentiel" valeur={t.sequentiel} desactive={occupe} onChange={(actif) => lot("sequentiel", { actif })} />
      <Interrupteur libelle="Premier et dernier morceau en priorité" valeur={t.premierDernier} desactive={occupe} onChange={(actif) => lot("premier-dernier", { actif })} />

      <fieldset className="groupe-filtre">
        <legend>Limites de vitesse du torrent (Ko/s, vide = illimité)</legend>
        <div className="filtres-selects">
          <label className="champ-compact">
            <span>↓ Réception</span>
            <input inputMode="decimal" value={dl} onChange={(e) => setDl(e.target.value)} placeholder="Illimité" />
          </label>
          <label className="champ-compact">
            <span>↑ Envoi</span>
            <input inputMode="decimal" value={up} onChange={(e) => setUp(e.target.value)} placeholder="Illimité" />
          </label>
        </div>
        <button className="bouton violet" disabled={occupe || !limitesOk} onClick={() => lot("limites", { dl: koVersOctets(dl), up: koVersOctets(up) }, "Limites appliquées ✓")}>
          Appliquer les limites
        </button>
      </fieldset>

      <fieldset className="groupe-filtre">
        <legend>Renommer</legend>
        <input value={nom} maxLength={200} onChange={(e) => setNom(e.target.value)} aria-label="Nouveau nom" />
        <button className="bouton violet" disabled={occupe || !nom.trim() || nom.trim() === t.nom} onClick={() => faire(`/qbit/torrent/${t.hash}/renommer`, { nom: nom.trim() }, "Renommé ✓")}>
          Renommer
        </button>
      </fieldset>

      <fieldset className="groupe-filtre">
        <legend>Déplacer vers un autre dossier</legend>
        <input list="dossiers-deplacer" value={chemin} onChange={(e) => setChemin(e.target.value)} aria-label="Nouveau dossier" autoCapitalize="off" autoCorrect="off" />
        <datalist id="dossiers-deplacer">
          {(dossiers.data?.racines ?? []).map((r) => (
            <option key={r} value={r} />
          ))}
          {catalogue.categories.filter((c) => c.chemin).map((c) => (
            <option key={c.nom} value={c.chemin} />
          ))}
        </datalist>
        <span className="muted">Le dossier doit être dans une des racines autorisées.</span>
        <button className="bouton violet" disabled={occupe || !chemin.trim() || chemin.trim() === t.chemin} onClick={() => lot("deplacer", { chemin: chemin.trim() }, "Déplacement demandé ✓")}>
          Déplacer
        </button>
      </fieldset>

      {!prefs.reglages.masquerSuppression && (
        <div className="actions colonne">
          <button className="bouton violet danger" onClick={() => onSupprimer(false)}>
            Supprimer (garder les fichiers)
          </button>
          <button className="bouton violet danger" onClick={() => onSupprimer(true)}>
            Supprimer avec les fichiers
          </button>
        </div>
      )}
    </>
  );
}

// ---------- fichiers ----------

const PRIORITES: { valeur: number; libelle: string }[] = [
  { valeur: 0, libelle: "Ne pas télécharger" },
  { valeur: 1, libelle: "Normale" },
  { valeur: 6, libelle: "Haute" },
];

function Fichiers({ hash }: { hash: string }) {
  const { data, erreur, chargement, recharger } = useApi<{ items: FichierTorrent[] }>(`/qbit/torrent/${hash}/fichiers`, 8000);
  const [ouverts, setOuverts] = useState<Set<string>>(new Set());
  const [echec, setEchec] = useState<string | null>(null);

  async function changer(indices: number[], priorite: number) {
    setEchec(null);
    try {
      await action("POST", `/qbit/torrent/${hash}/fichiers/priorite`, { ids: indices, priorite });
      recharger();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Changement impossible");
    }
  }
  const arbre = construireArbre(data?.items ?? []);

  const ligne = (n: NoeudFichier, niveau: number): React.ReactNode => {
    const ouvert = ouverts.has(n.chemin);
    const coche = n.priorite === null ? true : n.priorite !== 0;
    return (
      <div key={n.chemin}>
        <div className="fichier-ligne" style={{ paddingLeft: niveau * 14 }}>
          <input
            type="checkbox"
            aria-label={`Télécharger ${n.nom}`}
            checked={coche}
            ref={(el) => {
              if (el) el.indeterminate = n.dossier && n.priorite === null;
            }}
            onChange={(e) => changer(n.indices, e.target.checked ? 1 : 0)}
          />
          {n.dossier ? (
            <button className="lien fichier-nom" aria-expanded={ouvert} onClick={() => setOuverts((s) => { const x = new Set(s); if (x.has(n.chemin)) x.delete(n.chemin); else x.add(n.chemin); return x; })}>
              {ouvert ? "▾" : "▸"} {n.nom}
            </button>
          ) : (
            <span className="fichier-nom">{n.nom}</span>
          )}
          <span className="muted fichier-taille">
            {taille(n.tailleOctets)} · {pct(n.progression)}
          </span>
          <select aria-label={`Priorité de ${n.nom}`} value={n.priorite ?? ""} onChange={(e) => changer(n.indices, Number(e.target.value))}>
            {n.priorite === null && <option value="">Mixte</option>}
            {PRIORITES.map((p) => (
              <option key={p.valeur} value={p.valeur}>
                {p.libelle}
              </option>
            ))}
            {n.priorite === 7 && <option value={7}>Maximale</option>}
          </select>
        </div>
        {n.dossier && ouvert && n.enfants.map((e) => ligne(e, niveau + 1))}
      </div>
    );
  };

  return (
    <>
      {chargement && !data && <Message>Chargement…</Message>}
      {erreur && <Message erreur>{erreur}</Message>}
      {echec && <p className="card error" role="alert">{echec}</p>}
      {data && data.items.length === 0 && <Message>Aucun fichier (métadonnées pas encore reçues ?).</Message>}
      <div className="arbre-fichiers">{arbre.map((n) => ligne(n, 0))}</div>
    </>
  );
}

// ---------- trackers et pairs ----------

interface LigneTracker {
  hote: string;
  statut: string;
  fonctionne: boolean;
  seeds: number;
  pairs: number;
  telechargements: number;
  message: string;
}
function Trackers({ hash }: { hash: string }) {
  const { data, erreur, chargement } = useApi<{ items: LigneTracker[] }>(`/qbit/torrent/${hash}/trackers`, 8000);
  return (
    <>
      {chargement && !data && <Message>Chargement…</Message>}
      {erreur && <Message erreur>{erreur}</Message>}
      {data?.items.map((x, i) => (
        <article key={`${x.hote}-${i}`} className="card">
          <strong className="torrent-nom">{x.hote}</strong>
          <span className={x.fonctionne ? "etat-pilule" : "etat-pilule attention"}>{x.statut}</span>
          <div className="muted">
            Seeds {x.seeds} · Pairs {x.pairs} · Téléchargés {x.telechargements}
          </div>
          {x.message && <div className="muted">Message : {x.message}</div>}
        </article>
      ))}
    </>
  );
}

interface LignePair {
  adresse: string;
  client: string;
  progression: number;
  vitesseDl: number;
  vitesseUp: number;
  pays: string | null;
}
function Pairs({ hash }: { hash: string }) {
  const { data, erreur, chargement } = useApi<{ items: LignePair[] }>(`/qbit/torrent/${hash}/pairs`, 5000);
  return (
    <>
      {chargement && !data && <Message>Chargement…</Message>}
      {erreur && <Message erreur>{erreur}</Message>}
      {data && data.items.length === 0 && <Message>Aucun pair connecté.</Message>}
      {data?.items.map((p) => (
        <article key={p.adresse} className="card">
          <strong>{p.adresse}</strong> {p.pays && <span className="muted">· {p.pays}</span>}
          <div className="muted">
            {p.client || "Client inconnu"} · {pct(p.progression)} · ↓ {vitesse(p.vitesseDl)} · ↑ {vitesse(p.vitesseUp)}
          </div>
        </article>
      ))}
    </>
  );
}

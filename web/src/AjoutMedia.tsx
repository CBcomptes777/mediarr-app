import { useEffect, useMemo, useState } from "react";
import { action, type OptionsAjout, type ResultatRecherche, type TypeMedia } from "./api";
import { taille } from "./format";
import { Affiche, Feuille, Message, PastilleNote } from "./ui";
import { useApi } from "./useApi";

type Filtre = "tout" | TypeMedia;
type Tri = "pertinence" | "sortie" | "note" | "titre";
const TRIS: { code: Tri; libelle: string }[] = [
  { code: "pertinence", libelle: "Pertinence" },
  { code: "sortie", libelle: "Date de sortie" },
  { code: "note", libelle: "Note" },
  { code: "titre", libelle: "Titre" },
];
const SERVICE: Record<TypeMedia, string> = { film: "Radarr", serie: "Sonarr" };
const CLE_MEMO = "mediarr_ajout";

/** Derniers choix de dossier et de profil, par type (confort ; sans effet s'il n'y a pas de stockage). */
function memoire(type: TypeMedia): { racine?: string; profil?: number } {
  try {
    return JSON.parse(localStorage.getItem(`${CLE_MEMO}_${type}`) ?? "{}");
  } catch {
    return {};
  }
}
function retenir(type: TypeMedia, valeur: { racine: string; profil: number }) {
  try {
    localStorage.setItem(`${CLE_MEMO}_${type}`, JSON.stringify(valeur));
  } catch {
    /* facultatif */
  }
}

export function AjoutMedia({
  requeteInitiale,
  onFermer,
  onAjoute,
  onOuvrir,
}: {
  requeteInitiale: string;
  onFermer: () => void;
  /** Appelé dès qu'un ajout réussit : l'app recharge ses listes. */
  onAjoute: () => void;
  onOuvrir: (type: TypeMedia, id: number) => void;
}) {
  const [saisie, setSaisie] = useState(requeteInitiale);
  const [terme, setTerme] = useState(requeteInitiale.trim());
  const [filtre, setFiltre] = useState<Filtre>("tout");
  const [tri, setTri] = useState<Tri>("pertinence");
  const [croissant, setCroissant] = useState(false); // « décroissant » = meilleur / plus récent d'abord
  const [sansNote, setSansNote] = useState(false); // masquer les résultats sans note
  const [choix, setChoix] = useState<ResultatRecherche | null>(null);
  const [ajoute, setAjoute] = useState<{ titre: string; type: TypeMedia; id: number | null } | null>(null);

  // On attend une pause dans la frappe avant d'interroger Radarr et Sonarr.
  useEffect(() => {
    const t = setTimeout(() => setTerme(saisie.trim()), 400);
    return () => clearTimeout(t);
  }, [saisie]);

  const recherche = useApi<{ items: ResultatRecherche[]; erreurs: string[] }>(
    terme.length >= 2 ? `/recherche?q=${encodeURIComponent(terme)}&type=${filtre}` : null,
  );

  const items = useMemo(() => {
    const liste = (recherche.data?.items ?? []).filter((r) => !(sansNote && !r.note));
    const copie = [...liste]; // ordre du serveur = pertinence, meilleur résultat d'abord
    if (tri === "sortie") copie.sort((a, b) => (b.sortie ?? "").localeCompare(a.sortie ?? ""));
    if (tri === "note") copie.sort((a, b) => (b.note?.valeur ?? 0) - (a.note?.valeur ?? 0));
    if (tri === "titre") copie.sort((a, b) => a.titre.localeCompare(b.titre, "fr"));
    // Sens naturel : décroissant (récent / mieux noté / plus pertinent d'abord), sauf le titre (A → Z).
    return croissant === (tri === "titre") ? copie : copie.reverse();
  }, [recherche.data, tri, croissant, sansNote]);
  const masques = (recherche.data?.items.length ?? 0) - items.length;

  if (ajoute) {
    return (
      <Feuille titre="Ajouter un média" onFermer={onFermer}>
        <div className="succes" role="status">
          <span className="succes-pastille" aria-hidden="true">
            ✓
          </span>
          <strong>{ajoute.titre}</strong>
          <span className="muted">a été ajouté à {SERVICE[ajoute.type]}.</span>
        </div>
        {ajoute.id !== null && (
          <button
            className="bouton violet plein"
            onClick={() => {
              onOuvrir(ajoute.type, ajoute.id!);
              onFermer();
            }}
          >
            Voir la fiche
          </button>
        )}
        <button
          className="bouton violet"
          onClick={() => {
            setAjoute(null);
            setChoix(null);
          }}
        >
          Ajouter un autre média
        </button>
        <button className="bouton violet" onClick={onFermer}>
          Fermer
        </button>
      </Feuille>
    );
  }

  if (choix) {
    return (
      <Feuille titre="Ajouter un média" sousTitre={`vers ${SERVICE[choix.type]}`} onFermer={onFermer}>
        <FormulaireAjout
          cible={choix}
          onRetour={() => setChoix(null)}
          onReussi={(r) => {
            setAjoute({ titre: r.titre, type: choix.type, id: r.id });
            onAjoute();
          }}
        />
      </Feuille>
    );
  }

  return (
    <Feuille titre="Ajouter un média" onFermer={onFermer}>
      <label className="recherche">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <input
          aria-label="Rechercher un film ou une série"
          placeholder="Film ou série à ajouter…"
          value={saisie}
          autoFocus
          onChange={(e) => setSaisie(e.target.value)}
        />
      </label>

      <div className="filtres" role="group" aria-label="Chercher dans">
        {(["tout", "film", "serie"] as Filtre[]).map((f) => (
          <button key={f} className={f === filtre ? "actif" : ""} aria-pressed={f === filtre} onClick={() => setFiltre(f)}>
            {f === "tout" ? "Tout" : f === "film" ? "Films (Radarr)" : "Séries (Sonarr)"}
          </button>
        ))}
      </div>

      <div className="tri-ligne">
        <label className="champ-compact">
          <span>Trier par</span>
          <select
            value={tri}
            onChange={(e) => {
              const t = e.target.value as Tri;
              setTri(t);
              setCroissant(t === "titre"); // A→Z par défaut ; les autres : meilleur / plus récent d'abord
            }}
          >
            {TRIS.map((t) => (
              <option key={t.code} value={t.code}>
                {t.libelle}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rond petit"
          aria-label={croissant ? "Ordre croissant (cliquer pour décroissant)" : "Ordre décroissant (cliquer pour croissant)"}
          title={croissant ? "Croissant" : "Décroissant"}
          onClick={() => setCroissant((c) => !c)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={croissant ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
          </svg>
        </button>
      </div>
      <label className="case compact">
        <input type="checkbox" checked={sansNote} onChange={(e) => setSansNote(e.target.checked)} />
        <span>Masquer les résultats sans note</span>
      </label>

      {terme.length < 2 && <Message>Tape au moins 2 lettres du titre pour chercher.</Message>}
      {recherche.erreur && <Message erreur>{recherche.erreur}</Message>}
      {recherche.data?.erreurs.map((e) => (
        <Message key={e} erreur>
          {e}
        </Message>
      ))}
      {terme.length >= 2 && recherche.chargement && <Message>Recherche en cours…</Message>}
      {terme.length >= 2 && !recherche.chargement && recherche.data && items.length === 0 && (
        <Message>Aucun résultat pour « {terme} ».</Message>
      )}

      {terme.length >= 2 && masques > 0 && (
        <span className="muted" aria-live="polite">
          {masques} résultat{masques > 1 ? "s" : ""} sans note masqué{masques > 1 ? "s" : ""}.
        </span>
      )}

      {terme.length >= 2 &&
        items.map((r) => {
          const corps = (
            <>
              <Affiche src={r.affiche} titre={r.titre} className="resultat-img" />
              <div className="resultat-texte">
                <div className="resultat-tete">
                  <span className="media-titre">{r.titre}</span>
                  {r.dansBibliotheque && (
                    <span className="coche-grande" role="img" aria-label="Dans la bibliothèque">
                      ✓
                    </span>
                  )}
                </div>
                <span className="media-meta">
                  {[r.type === "film" ? "Film" : "Série", r.annee, r.detail].filter(Boolean).join(" · ")}
                </span>
                <div className="pastilles gauche">
                  <PastilleNote note={r.note} />
                  {r.genres.slice(0, 3).map((g) => (
                    <span key={g} className="genre">
                      {g}
                    </span>
                  ))}
                </div>
                {r.synopsis && <span className="media-synopsis">{r.synopsis}</span>}
                {r.dansBibliotheque ? (
                  <span className="dans-biblio">Dans la bibliothèque · voir la fiche</span>
                ) : (
                  <button className="bouton violet plein" onClick={() => setChoix(r)}>
                    Ajouter
                  </button>
                )}
              </div>
            </>
          );
          // Un titre déjà présent ouvre sa fiche au lieu de proposer l'ajout.
          return r.dansBibliotheque && r.mediaId !== null ? (
            <button
              key={`${r.type}-${r.externeId}`}
              className="resultat resultat-present"
              onClick={() => {
                onOuvrir(r.type, r.mediaId!);
                onFermer();
              }}
            >
              {corps}
            </button>
          ) : (
            <article key={`${r.type}-${r.externeId}`} className="resultat">
              {corps}
            </article>
          );
        })}
    </Feuille>
  );
}

function FormulaireAjout({
  cible,
  onRetour,
  onReussi,
}: {
  cible: ResultatRecherche;
  onRetour: () => void;
  onReussi: (r: { titre: string; id: number | null }) => void;
}) {
  const options = useApi<OptionsAjout>(`/ajout/options/${cible.type}`);
  const [racine, setRacine] = useState("");
  const [profil, setProfil] = useState<number | null>(null);
  const [suivi, setSuivi] = useState(true);
  const [recherche, setRecherche] = useState(true);
  const [envoi, setEnvoi] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);

  // Valeurs par défaut : le dernier choix s'il existe encore, sinon le premier de la liste.
  useEffect(() => {
    const o = options.data;
    if (!o) return;
    const m = memoire(cible.type);
    setRacine(o.racines.find((r) => r.chemin === m.racine)?.chemin ?? o.racines[0]?.chemin ?? "");
    setProfil(o.profils.find((p) => p.id === m.profil)?.id ?? o.profils[0]?.id ?? null);
  }, [options.data, cible.type]);

  async function ajouter() {
    if (!racine || profil === null) return;
    setEnvoi(true);
    setEchec(null);
    try {
      const r = await action<{ ok: true; id: number | null; titre: string }>("POST", "/ajout", {
        type: cible.type,
        externeId: cible.externeId,
        racine,
        profil,
        suivi,
        recherche,
      });
      retenir(cible.type, { racine, profil });
      onReussi({ titre: r.titre || cible.titre, id: r.id });
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Ajout impossible");
      setEnvoi(false);
    }
  }

  return (
    <>
      <div className="resultat apercu">
        <Affiche src={cible.affiche} titre={cible.titre} className="resultat-img" />
        <div className="resultat-texte">
          <span className="media-titre">{cible.titre}</span>
          <span className="media-meta">{[cible.type === "film" ? "Film" : "Série", cible.annee].filter(Boolean).join(" · ")}</span>
        </div>
      </div>

      {options.erreur && <Message erreur>{options.erreur}</Message>}
      {options.chargement && !options.data && <Message>Chargement des options…</Message>}

      {options.data && options.data.racines.length === 0 && (
        <Message erreur>Aucun dossier racine disponible chez {SERVICE[cible.type]}.</Message>
      )}

      {options.data && options.data.racines.length > 0 && (
        <form
          className="formulaire"
          onSubmit={(e) => {
            e.preventDefault();
            ajouter();
          }}
        >
          <label className="champ">
            <span>Dossier racine</span>
            <select value={racine} onChange={(e) => setRacine(e.target.value)}>
              {options.data.racines.map((r) => (
                <option key={r.chemin} value={r.chemin}>
                  {r.chemin}
                  {r.libreOctets > 0 ? ` · ${taille(r.libreOctets)} libres` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="champ">
            <span>Profil de qualité</span>
            <select value={profil ?? ""} onChange={(e) => setProfil(Number(e.target.value))}>
              {options.data.profils.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nom}
                </option>
              ))}
            </select>
          </label>

          <label className="case">
            <input type="checkbox" checked={suivi} onChange={(e) => setSuivi(e.target.checked)} />
            <span>
              <strong>Surveiller</strong>
              <span className="muted">
                {cible.type === "film" ? "Télécharger le film dès qu'il est disponible." : "Télécharger tous les épisodes, y compris les futurs."}
              </span>
            </span>
          </label>

          <label className="case">
            <input type="checkbox" checked={recherche} onChange={(e) => setRecherche(e.target.checked)} />
            <span>
              <strong>Lancer la recherche tout de suite</strong>
              <span className="muted">
                {cible.type === "film" ? "Chercher le film dès l'ajout." : "Chercher les épisodes manquants dès l'ajout."}
              </span>
            </span>
          </label>

          {echec && (
            <p className="card error" role="alert">
              {echec}
            </p>
          )}

          <button type="submit" className="bouton violet plein" disabled={envoi || profil === null || !racine}>
            {envoi ? "Ajout en cours…" : `Ajouter à ${SERVICE[cible.type]}`}
          </button>
        </form>
      )}

      <button className="bouton violet" onClick={onRetour} disabled={envoi}>
        Retour aux résultats
      </button>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { usePrefs } from "./prefs";
import { action, type EtatTitre, type Release } from "./api";
import { taille } from "./format";
import { CarteRelease, ConfirmerTelechargement, FiltresRecherche, type EtatEnvoiCarte } from "./ReleaseUI";
import {
  ecrireMasquerRejetees, FILTRES_REL_VIDES, filtrerReleases, lireMasquerRejetees, messageToutRejete, trier, type FiltresReleases, type Tri,
} from "./releasesLogique";
import { Affiche, Feuille, Message, PastilleNote } from "./ui";
import { useApi } from "./useApi";

/** Ce qu'on cherche : un film, un épisode, ou une saison entière (packs). Pour une saison, `id` est celui de la série. */
export type CibleRecherche = { cible: "film" | "episode" | "saison"; id: number; numero?: number; titre: string; affiche?: string | null };

const chemin = (c: CibleRecherche) => (c.cible === "saison" ? `${c.id}/${c.numero}` : String(c.id));

export function Releases({ cible, id, numero, titre, affiche, onFermer }: CibleRecherche & { onFermer: () => void }) {
  const { data, erreur, chargement, recharger } = useApi<{ titre: EtatTitre; items: Release[] }>(`/releases/${cible}/${chemin({ cible, id, numero, titre })}`);
  const { prefs } = usePrefs();
  // Compteur de secondes pendant la recherche ; si le serveur ne répond plus du tout, on cesse d'attendre (jamais de spinner infini).
  const [secondes, setSecondes] = useState(0);
  const limite = Math.round(prefs.reglages.delaiRechercheMs / 1000) + 15;
  useEffect(() => {
    if (!chargement) return;
    setSecondes(0);
    const t = setInterval(() => setSecondes((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [chargement]);
  const sansReponse = chargement && !data && secondes >= limite;
  // Tri par défaut : acceptées d'abord, puis seeders décroissants.
  const [tri, setTri] = useState<Tri>("seeders");
  const [filtres, setFiltres] = useState<FiltresReleases>(FILTRES_REL_VIDES);
  // Coché par défaut ; le choix est mémorisé d'une recherche à l'autre.
  const [masquerRejetees, setMasquerRejetees] = useState(() =>
    lireMasquerRejetees(typeof localStorage === "undefined" ? undefined : localStorage),
  );
  // « Afficher quand même » : vaut pour cette recherche seulement, sans toucher à la préférence mémorisée.
  const [forcer, setForcer] = useState(false);
  const [etats, setEtats] = useState<Record<string, EtatEnvoiCarte>>({});
  const [aConfirmer, setAConfirmer] = useState<Release | null>(null);

  const tous = data?.items ?? [];
  const masquer = masquerRejetees && !forcer;
  const toutRejete = messageToutRejete(tous);
  // Les choix du menu (et le nombre de résultats par indexeur) portent sur ce qui est affichable.
  const pool = useMemo(() => tous.filter((r) => !(masquer && r.rejete)), [tous, masquer]);
  const items = useMemo(() => trier(filtrerReleases(pool, filtres), tri), [pool, filtres, tri]);

  const rejeteesMasquees = masquer ? tous.filter((r) => r.rejete).length : 0;
  const etat = data?.titre;
  const fichier = etat?.statut === "present" ? (etat.fichier ?? null) : null;
  const fichierQualite = fichier?.qualite ?? null;

  const note = (guid: string, e: EtatEnvoiCarte) => setEtats((s) => ({ ...s, [guid]: e }));

  async function telecharger(r: Release) {
    setAConfirmer(null);
    note(r.guid, { occupe: true });
    try {
      const res = await action<{ ok: true; client: string | null }>("POST", `/releases/${cible}`, { guid: r.guid, indexerId: r.indexerId, protocole: r.protocole });
      note(r.guid, { succes: res.client ? `Envoyé à ${res.client}` : "Envoyé au client de téléchargement" });
    } catch (e) {
      note(r.guid, { echec: e instanceof Error ? e.message : "Téléchargement impossible" });
    }
  }

  const sousTitre = cible === "saison" ? `${titre} · saison ${numero}` : titre;

  return (
    <Feuille titre={cible === "saison" ? "Recherche manuelle (saison)" : "Recherche manuelle"} sousTitre={sousTitre} onFermer={onFermer}>
      {chargement && !data && !sansReponse && (
        <Message>
          Recherche en cours chez les indexeurs… {secondes} s
          <br />
          <span className="muted">Cela peut prendre plus d'une minute ({Math.round(prefs.reglages.delaiRechercheMs / 1000)} s au maximum).</span>
        </Message>
      )}
      {(erreur || sansReponse) && !data && (
        <div className="card error" role="alert">
          <strong>{sansReponse ? "Mediarr ne répond plus : la recherche n'a pas abouti." : erreur}</strong>
          <button className="bouton violet" onClick={recharger}>
            Réessayer
          </button>
        </div>
      )}

      {etat && etat.statut !== "inconnu" && (
        <section className="etat-titre" aria-label="État du titre">
          {affiche && <Affiche src={affiche} titre={titre} className="etat-titre-img" />}
          <div className="etat-titre-texte">
            <div className="etat-titre-ligne">
              {etat.statut === "present" && <span className="coche-petite" aria-hidden="true">✓</span>}
              <strong>
                {etat.statut === "present"
                  ? "Dans la bibliothèque"
                  : etat.statut === "sans_fichier"
                    ? "Pas de fichier"
                    : "Pas dans la bibliothèque"}
              </strong>
              <PastilleNote note={etat.note} />
            </div>
            {etat.statut === "present" && fichier && (
              <dl className="fichier-actuel">
                <div><dt>Qualité</dt><dd>{fichier.qualite ?? "—"}</dd></div>
                <div><dt>Taille</dt><dd>{taille(fichier.tailleOctets)}</dd></div>
                <div><dt>Langue</dt><dd>{fichier.langues.join(", ") || "—"}</dd></div>
                <div><dt>Groupe de release</dt><dd>{fichier.groupe ?? "—"}</dd></div>
              </dl>
            )}
            {etat.statut === "present" && !fichier && (
              <span className="muted">Détails du fichier indisponibles.</span>
            )}
          </div>
        </section>
      )}

      {data && (
        <>
          <FiltresRecherche pool={pool} filtres={filtres} onChange={setFiltres} tri={tri} onTri={setTri} />
          <label className="case compact">
            <input
              type="checkbox"
              checked={masquer}
              onChange={(e) => {
                setMasquerRejetees(e.target.checked);
                setForcer(false);
                ecrireMasquerRejetees(typeof localStorage === "undefined" ? undefined : localStorage, e.target.checked);
              }}
            />
            <span>Masquer les résultats rejetés</span>
          </label>
          <span className="muted" aria-live="polite">
            {items.length} résultat{items.length > 1 ? "s" : ""}
            {rejeteesMasquees > 0 ? ` · ${rejeteesMasquees} rejeté${rejeteesMasquees > 1 ? "s" : ""} masqué${rejeteesMasquees > 1 ? "s" : ""}` : ""}
          </span>
        </>
      )}

      {data && masquer && toutRejete && (
        <div className="card tout-rejete" role="status">
          <strong>{toutRejete}</strong>
          <button className="lien-discret aligne-gauche" onClick={() => setForcer(true)}>
            Afficher quand même les {tous.length} résultat{tous.length > 1 ? "s" : ""}
          </button>
        </div>
      )}

      {data && items.length === 0 && !(masquer && toutRejete) && (
        <Message>
          {tous.length === 0 ? "Aucun résultat trouvé par les indexeurs." : "Aucun résultat avec ces filtres."}
        </Message>
      )}

      {items.map((r) => (
        <CarteRelease key={r.guid} r={r} fichierQualite={fichierQualite} etat={etats[r.guid] ?? {}} onTelecharger={setAConfirmer} />
      ))}

      {aConfirmer && (
        <ConfirmerTelechargement
          r={aConfirmer}
          fichierQualite={fichierQualite}
          occupe={false}
          onConfirmer={() => telecharger(aConfirmer)}
          onAnnuler={() => setAConfirmer(null)}
        />
      )}
    </Feuille>
  );
}

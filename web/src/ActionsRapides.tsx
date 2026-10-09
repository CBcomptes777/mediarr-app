import { useMemo, useState } from "react";
import type { ResumeMedia, TypeMedia } from "./api";
import { normaliser } from "./format";
import { usePrefs, type ActionRapide } from "./prefs";
import { ECRANS_ACTIONS } from "./widgets";
import { Feuille, ListeOrdonnable, Message, TitreCarte } from "./ui";
import { useApi } from "./useApi";

const nouvelId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function description(a: ActionRapide): string {
  if (a.type === "media") return a.mediaType === "film" ? "Fiche d'un film" : "Fiche d'une série";
  if (a.type === "ecran") return `Écran : ${ECRANS_ACTIONS.find((e) => e.id === a.ecran)?.libelle ?? a.ecran}`;
  return a.url ?? "";
}

/** Widget « Actions rapides » : des raccourcis vers un média, un écran de l'app ou une adresse web. */
export function ActionsRapides({
  onOuvrir,
  onEcran,
}: {
  onOuvrir: (type: TypeMedia, id: number) => void;
  onEcran: (ecran: string) => void;
}) {
  const { prefs } = usePrefs();
  const [editeur, setEditeur] = useState(false);
  const actions = prefs.actionsRapides;

  return (
    <section className="card" aria-label="Actions rapides">
      <TitreCarte
        couleur="#a78bfa"
        droite={
          <button className="lien-discret" onClick={() => setEditeur(true)}>
            {actions.length ? "Configurer" : "Ajouter"}
          </button>
        }
      >
        Actions rapides
      </TitreCarte>
      {actions.length === 0 ? (
        <p className="muted marge-bas">Aucune action rapide. Ajoute un raccourci vers un film, un écran ou un lien.</p>
      ) : (
        <div className="actions-rapides">
          {actions.map((a) =>
            a.type === "url" ? (
              <a key={a.id} className="action-rapide" href={a.url} target="_blank" rel="noopener noreferrer">
                {a.libelle}
                <span className="muted">↗ Lien</span>
              </a>
            ) : (
              <button
                key={a.id}
                className="action-rapide"
                onClick={() => (a.type === "media" ? onOuvrir(a.mediaType!, a.mediaId!) : onEcran(a.ecran!))}
              >
                {a.libelle}
                <span className="muted">{a.type === "media" ? (a.mediaType === "film" ? "Film" : "Série") : "Écran"}</span>
              </button>
            ),
          )}
        </div>
      )}
      {editeur && <EditeurActions onFermer={() => setEditeur(false)} />}
    </section>
  );
}

type TypeAction = ActionRapide["type"];

function EditeurActions({ onFermer }: { onFermer: () => void }) {
  const { prefs, sauvegarder } = usePrefs();
  const [type, setType] = useState<TypeAction>("media");
  const [libelle, setLibelle] = useState("");
  const [recherche, setRecherche] = useState("");
  const [media, setMedia] = useState<ResumeMedia | null>(null);
  const [ecran, setEcran] = useState(ECRANS_ACTIONS[0].id);
  const [url, setUrl] = useState("");
  const [echec, setEchec] = useState<string | null>(null);
  const biblio = useApi<{ items: ResumeMedia[] }>(type === "media" ? "/bibliotheque" : null);

  const propositions = useMemo(() => {
    const q = normaliser(recherche.trim());
    if (q.length < 2) return [];
    return (biblio.data?.items ?? []).filter((i) => normaliser(i.titre).includes(q)).slice(0, 6);
  }, [biblio.data, recherche]);

  const urlValide = /^https?:\/\/[^\s]+$/i.test(url.trim());
  const pret =
    type === "media" ? media !== null : type === "ecran" ? true : urlValide;

  const enregistrer = async (suite: ActionRapide[]) => {
    setEchec(null);
    try {
      await sauvegarder((p) => ({ ...p, actionsRapides: suite }));
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Enregistrement impossible");
    }
  };

  async function ajouter() {
    const titreParDefaut = type === "media" ? media!.titre : type === "ecran" ? ECRANS_ACTIONS.find((e) => e.id === ecran)!.libelle : url.trim().replace(/^https?:\/\//i, "").split("/")[0];
    const nom = (libelle.trim() || titreParDefaut).slice(0, 40);
    const action: ActionRapide =
      type === "media"
        ? { id: nouvelId(), libelle: nom, type, mediaType: media!.type, mediaId: media!.id }
        : type === "ecran"
          ? { id: nouvelId(), libelle: nom, type, ecran }
          : { id: nouvelId(), libelle: nom, type, url: url.trim() };
    await enregistrer([...prefs.actionsRapides, action]);
    setLibelle("");
    setMedia(null);
    setRecherche("");
    setUrl("");
  }

  return (
    <Feuille titre="Actions rapides" sousTitre="Raccourcis de l'accueil" onFermer={onFermer}>
      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {prefs.actionsRapides.length > 0 && (
        <ListeOrdonnable
          elements={prefs.actionsRapides.map((a) => ({ id: a.id, libelle: a.libelle, detail: description(a) }))}
          onChange={(suite) => enregistrer(suite.map((s) => prefs.actionsRapides.find((a) => a.id === s.id)!))}
          onRetirer={(id) => enregistrer(prefs.actionsRapides.filter((a) => a.id !== id))}
        />
      )}

      <form
        className="formulaire"
        onSubmit={(e) => {
          e.preventDefault();
          if (pret) ajouter();
        }}
      >
        <h3 className="sous-titre">Nouvelle action</h3>
        <div className="segments" role="tablist" aria-label="Type d'action">
          {([["media", "Média"], ["ecran", "Écran"], ["url", "Adresse web"]] as const).map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={type === v} className={type === v ? "actif" : ""} onClick={() => setType(v)}>
              {l}
            </button>
          ))}
        </div>

        {type === "media" && (
          <>
            <label className="champ">
              <span>Chercher dans la bibliothèque</span>
              <input value={recherche} placeholder="Titre d'un film ou d'une série…" onChange={(e) => { setRecherche(e.target.value); setMedia(null); }} />
            </label>
            {biblio.erreur && <Message erreur>{biblio.erreur}</Message>}
            {media && (
              <p className="muted" role="status">
                Choisi : <strong>{media.titre}</strong> ({media.type === "film" ? "film" : "série"})
              </p>
            )}
            {!media &&
              propositions.map((p) => (
                <button key={`${p.type}-${p.id}`} type="button" className="proposition" onClick={() => { setMedia(p); setRecherche(p.titre); }}>
                  <span className="strong">{p.titre}</span>
                  <span className="muted">
                    {p.type === "film" ? "Film" : "Série"}
                    {p.annee ? ` · ${p.annee}` : ""}
                  </span>
                </button>
              ))}
          </>
        )}

        {type === "ecran" && (
          <label className="champ">
            <span>Écran à ouvrir</span>
            <select value={ecran} onChange={(e) => setEcran(e.target.value)}>
              {ECRANS_ACTIONS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.libelle}
                </option>
              ))}
            </select>
          </label>
        )}

        {type === "url" && (
          <label className="champ">
            <span>Adresse (http ou https)</span>
            <input type="url" inputMode="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
            {url.trim() && !urlValide && <span className="error">Adresse invalide : elle doit commencer par http:// ou https://</span>}
          </label>
        )}

        <label className="champ">
          <span>Nom du raccourci (facultatif)</span>
          <input value={libelle} maxLength={40} onChange={(e) => setLibelle(e.target.value)} />
        </label>
        <button type="submit" className="bouton violet plein" disabled={!pret}>
          Ajouter l'action
        </button>
      </form>
    </Feuille>
  );
}

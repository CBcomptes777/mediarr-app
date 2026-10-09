import { useMemo, useState } from "react";
import { normaliser } from "./format";
import { Feuille, ListeOrdonnable } from "./ui";
import { WIDGETS_INFO } from "./widgets";

/**
 * Mode édition de l'accueil : retirer un widget (−), réordonner (glisser ou ▲▼), en ajouter (recherche + coches),
 * puis Enregistrer ou Annuler. Rien n'est écrit sur le serveur avant « Enregistrer ».
 */
export function EditeurAccueil({
  widgets,
  onEnregistrer,
  onAnnuler,
}: {
  widgets: { id: string; visible: boolean }[];
  onEnregistrer: (suite: { id: string; visible: boolean }[]) => Promise<void>;
  onAnnuler: () => void;
}) {
  const [visibles, setVisibles] = useState(() => widgets.filter((w) => w.visible).map((w) => w.id));
  const [masques, setMasques] = useState(() => widgets.filter((w) => !w.visible).map((w) => w.id));
  const [ajout, setAjout] = useState(false);
  const [q, setQ] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);

  const retirer = (id: string) => {
    setVisibles((v) => v.filter((x) => x !== id));
    setMasques((m) => [...m, id]);
  };
  const ajouter = (id: string) => {
    setMasques((m) => m.filter((x) => x !== id));
    setVisibles((v) => [...v, id]);
  };

  const catalogue = useMemo(() => {
    const n = normaliser(q.trim());
    return widgets
      .map((w) => w.id)
      .filter((id) => !n || normaliser(`${WIDGETS_INFO[id]?.titre} ${WIDGETS_INFO[id]?.description}`).includes(n));
  }, [widgets, q]);

  async function enregistrer() {
    setEnvoi(true);
    setEchec(null);
    try {
      await onEnregistrer([...visibles.map((id) => ({ id, visible: true })), ...masques.map((id) => ({ id, visible: false }))]);
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Enregistrement impossible");
      setEnvoi(false);
    }
  }

  return (
    <>
      <header className="top">
        <h1>Modifier l'accueil</h1>
      </header>
      <p className="muted">Glisse la poignée ≡ (ou utilise ▲ ▼) pour changer l'ordre. − retire un widget.</p>

      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}

      {visibles.length === 0 ? (
        <p className="card muted">Aucun widget. Ajoutes-en un ci-dessous.</p>
      ) : (
        <ListeOrdonnable
          elements={visibles.map((id) => ({ id, libelle: WIDGETS_INFO[id]?.titre ?? id, detail: WIDGETS_INFO[id]?.description }))}
          onChange={(suite) => setVisibles(suite.map((s) => s.id))}
          onRetirer={retirer}
        />
      )}

      <button className="bouton violet large" onClick={() => setAjout(true)}>
        + Ajouter un widget
      </button>

      <div className="barre-edition">
        <button className="bouton violet plein" disabled={envoi} onClick={enregistrer}>
          {envoi ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button className="bouton violet" disabled={envoi} onClick={onAnnuler}>
          Annuler
        </button>
      </div>

      {ajout && (
        <Feuille titre="Ajouter un widget" onFermer={() => setAjout(false)}>
          <label className="recherche">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input aria-label="Rechercher un widget" placeholder="Rechercher un widget…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {catalogue.length === 0 && <span className="muted">Aucun widget ne correspond.</span>}
          {catalogue.map((id) => {
            const present = visibles.includes(id);
            return (
              <button
                key={id}
                className={present ? "widget-choix present" : "widget-choix"}
                role="checkbox"
                aria-checked={present}
                onClick={() => (present ? retirer(id) : ajouter(id))}
              >
                <span className="widget-choix-texte">
                  <strong>{WIDGETS_INFO[id]?.titre ?? id}</strong>
                  <span className="muted">{WIDGETS_INFO[id]?.description}</span>
                </span>
                <span className={present ? "coche-ronde on" : "coche-ronde"} aria-hidden="true">
                  {present ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </Feuille>
      )}
    </>
  );
}

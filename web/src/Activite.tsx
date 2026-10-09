import { useState } from "react";
import { AjoutTorrent } from "./AjoutTorrent";
import type { TypeMedia } from "./api";
import { FileQbit } from "./FileQbit";
import { Historique } from "./Historique";

type Vue = "file" | "historique";

export function Activite({ onOuvrir }: { onOuvrir: (type: TypeMedia, id: number) => void }) {
  const [vue, setVue] = useState<Vue>("file");
  const [ajout, setAjout] = useState(false);
  // Change après chaque ajout : la file est relue tout de suite.
  const [signal, setSignal] = useState(0);
  return (
    <>
      <div className="fond-detail activite" aria-hidden="true" />
      <header className="top">
        <h1>Activité</h1>
        {vue === "file" && (
          <button className="pilule bouton-pilule" onClick={() => setAjout(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Ajouter
          </button>
        )}
      </header>
      <div className="segments ambre" role="tablist" aria-label="Activité">
        <button role="tab" aria-selected={vue === "file"} className={vue === "file" ? "actif" : ""} onClick={() => setVue("file")}>
          File d'attente
        </button>
        <button role="tab" aria-selected={vue === "historique"} className={vue === "historique" ? "actif" : ""} onClick={() => setVue("historique")}>
          Historique
        </button>
      </div>
      {vue === "file" ? <FileQbit signal={signal} /> : <Historique onOuvrir={onOuvrir} />}
      {ajout && <AjoutTorrent onFermer={() => setAjout(false)} onAjoute={() => setSignal((s) => s + 1)} />}
    </>
  );
}

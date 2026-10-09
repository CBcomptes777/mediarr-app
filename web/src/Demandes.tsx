import { useState } from "react";
import { action } from "./api";
import { ilYa } from "./format";
import { Decouvrir } from "./Decouvrir";
import { Affiche, BoutonRetour, DialogueConfirmation, Message } from "./ui";
import { useApi } from "./useApi";

export interface Demande {
  id: number;
  statut: "en_attente" | "approuvee" | "refusee" | "echec" | "terminee" | "inconnu";
  type: "film" | "serie";
  titre: string;
  annee: number | null;
  affiche: string | null;
  demandeur: string;
  date: string;
  saisons: number[];
  quatreK: boolean;
}

type Filtre = "attente" | "approuvees" | "refusees" | "toutes";
const FILTRES: { code: Filtre; libelle: string }[] = [
  { code: "attente", libelle: "En attente" },
  { code: "approuvees", libelle: "Approuvées" },
  { code: "refusees", libelle: "Refusées" },
  { code: "toutes", libelle: "Toutes" },
];
const LIBELLE: Record<Demande["statut"], string> = {
  en_attente: "En attente",
  approuvee: "Approuvée",
  refusee: "Refusée",
  echec: "Échec",
  terminee: "Disponible",
  inconnu: "Inconnu",
};

export function Demandes({ onRetour, onChange }: { onRetour?: () => void; onChange: () => void }) {
  const [onglet, setOnglet] = useState<"demandes" | "decouvrir">("demandes");
  const [filtre, setFiltre] = useState<Filtre>("attente");
  const { data, erreur, chargement, recharger } = useApi<{ items: Demande[] }>(`/demandes?filtre=${filtre}`, 60000);
  const [occupe, setOccupe] = useState<number | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const [aRefuser, setARefuser] = useState<Demande | null>(null);

  async function agir(d: Demande, quoi: "approuver" | "refuser") {
    setOccupe(d.id);
    setEchec(null);
    try {
      await action("POST", `/demandes/${d.id}/${quoi}`);
      recharger();
      onChange(); // met à jour la pastille du nombre de demandes
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Action impossible");
    } finally {
      setOccupe(null);
    }
  }

  return (
    <>
      <header className="top">
        {onRetour ? <BoutonRetour onClick={onRetour} /> : null}
        <h1>Demandes</h1>
        {onRetour ? <span style={{ width: 44 }} /> : null}
      </header>

      <div className="segments" role="tablist" aria-label="Demandes">
        <button role="tab" aria-selected={onglet === "demandes"} className={onglet === "demandes" ? "actif" : ""} onClick={() => setOnglet("demandes")}>
          Demandes
        </button>
        <button role="tab" aria-selected={onglet === "decouvrir"} className={onglet === "decouvrir" ? "actif" : ""} onClick={() => setOnglet("decouvrir")}>
          Découvrir
        </button>
      </div>

      {onglet === "decouvrir" ? (
        <Decouvrir onDemande={() => { recharger(); onChange(); }} />
      ) : (
        <>
      <div className="filtres defile" role="group" aria-label="Filtrer les demandes">
        {FILTRES.map((f) => (
          <button key={f.code} className={f.code === filtre ? "actif" : ""} aria-pressed={f.code === filtre} onClick={() => setFiltre(f.code)}>
            {f.libelle}
          </button>
        ))}
      </div>

      {erreur && <Message erreur>{erreur}</Message>}
      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {chargement && !data && <Message>Chargement…</Message>}
      {data && data.items.length === 0 && <Message>Aucune demande {filtre === "attente" ? "en attente" : "dans cette liste"}.</Message>}

      {data?.items.map((d) => (
        <article key={d.id} className="card demande">
          <div className="hist-corps">
            <Affiche src={d.affiche} titre={d.titre} className="demande-img" />
            <div className="hist-texte">
              <span className="media-titre">
                {d.titre}
                {d.annee ? ` (${d.annee})` : ""}
              </span>
              <span className="media-meta">
                {[d.type === "film" ? "Film" : "Série", d.quatreK ? "4K" : null, d.saisons.length ? `Saison${d.saisons.length > 1 ? "s" : ""} ${d.saisons.join(", ")}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="muted">
                Demandé par {d.demandeur} · {ilYa(d.date)}
              </span>
              <span className={`badge etat-demande ${d.statut}`}>{LIBELLE[d.statut]}</span>
            </div>
          </div>
          {d.statut === "en_attente" && (
            <div className="actions">
              <button className="bouton violet plein" disabled={occupe === d.id} onClick={() => agir(d, "approuver")}>
                {occupe === d.id ? "…" : "Approuver"}
              </button>
              <button className="bouton violet danger" disabled={occupe === d.id} onClick={() => setARefuser(d)}>
                Refuser
              </button>
            </div>
          )}
        </article>
      ))}

      {aRefuser && (
        <DialogueConfirmation
          titre="Refuser cette demande ?"
          texte={`${aRefuser.titre} — demandé par ${aRefuser.demandeur}`}
          boutons={[
            {
              libelle: "Refuser la demande",
              variante: "danger",
              onClick: () => {
                const d = aRefuser;
                setARefuser(null);
                agir(d, "refuser");
              },
            },
          ]}
          onAnnuler={() => setARefuser(null)}
        />
      )}
        </>
      )}
    </>
  );
}

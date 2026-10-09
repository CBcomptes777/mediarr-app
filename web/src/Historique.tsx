import { useMemo, useState } from "react";
import type { EvenementHistorique, TypeMedia } from "./api";
import { ilYa, normaliser } from "./format";
import { Affiche, Message } from "./ui";
import { useApi } from "./useApi";

type Etat = EvenementHistorique["etat"]["code"];
const ETATS: { code: Etat | "tout"; libelle: string }[] = [
  { code: "tout", libelle: "Tout" },
  { code: "importe", libelle: "Importé" },
  { code: "recupere", libelle: "Récupéré" },
  { code: "supprime", libelle: "Supprimé" },
  { code: "echec", libelle: "Échec" },
];
const SERVICES = [
  { code: "tout", libelle: "Tout" },
  { code: "film", libelle: "Films" },
  { code: "serie", libelle: "Séries" },
] as const;

export function Historique({ onOuvrir }: { onOuvrir: (type: TypeMedia, id: number) => void }) {
  const { data, erreur, chargement } = useApi<{ items: EvenementHistorique[]; erreurs: string[] }>("/historique", 60000);
  const [recherche, setRecherche] = useState("");
  const [etat, setEtat] = useState<Etat | "tout">("tout");
  const [type, setType] = useState<"tout" | TypeMedia>("tout");
  const [recents, setRecents] = useState(true);

  const items = useMemo(() => {
    const q = normaliser(recherche.trim());
    const liste = (data?.items ?? []).filter(
      (i) =>
        (etat === "tout" || i.etat.code === etat) &&
        (type === "tout" || i.type === type) &&
        (!q || normaliser(`${i.titre} ${i.release}`).includes(q)),
    );
    // Le serveur trie du plus récent au plus ancien.
    return recents ? liste : [...liste].reverse();
  }, [data, recherche, etat, type, recents]);

  return (
    <>
      <div className="ligne-outils">
        <label className="recherche ambre">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            aria-label="Chercher dans l'historique"
            placeholder="Chercher dans l'historique…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
          />
        </label>
        <button
          className="rond ambre"
          aria-label={recents ? "Trier : plus récents d'abord" : "Trier : plus anciens d'abord"}
          title={recents ? "Plus récents d'abord" : "Plus anciens d'abord"}
          onClick={() => setRecents((r) => !r)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={recents ? "M12 5v14M6 13l6 6 6-6" : "M12 19V5M6 11l6-6 6 6"} />
          </svg>
        </button>
      </div>

      <div className="filtres" role="group" aria-label="Filtrer par type">
        {SERVICES.map((s) => (
          <button key={s.code} className={s.code === type ? "actif" : ""} aria-pressed={s.code === type} onClick={() => setType(s.code)}>
            {s.libelle}
          </button>
        ))}
      </div>
      <div className="filtres defile" role="group" aria-label="Filtrer par état">
        {ETATS.map((e) => (
          <button key={e.code} className={e.code === etat ? "actif" : ""} aria-pressed={e.code === etat} onClick={() => setEtat(e.code)}>
            {e.libelle}
          </button>
        ))}
      </div>

      {erreur && <Message erreur>{erreur}</Message>}
      {data?.erreurs.map((e) => (
        <Message key={e} erreur>
          {e}
        </Message>
      ))}
      {chargement && !data && <Message>Chargement…</Message>}
      {data && items.length === 0 && <Message>Aucun évènement.</Message>}

      {items.map((i) => {
        const lignes: [string, string][] = [
          ["Qualité", i.qualite ?? ""],
          ["Score", i.score == null ? "" : `${i.score > 0 ? "+" : ""}${i.score}`],
          ["Langue", i.langue ?? ""],
          ["Groupe de release", i.groupe ?? ""],
          ["Client", i.client ?? ""],
        ];
        return (
          <button key={i.id} className="card ambre hist" onClick={() => onOuvrir(i.type, i.mediaId)}>
            <div className="torrent-tete">
              <span className={`badge hist-${i.etat.code}`}>{i.etat.libelle}</span>
              <span className={`badge service ${i.service}`}>{i.service === "radarr" ? "Radarr" : "Sonarr"}</span>
            </div>
            <div className="hist-corps">
              <Affiche src={i.affiche} titre={i.titre} className="hist-img" />
              <div className="hist-texte">
                <span className="media-titre">
                  {i.titre}
                  {i.sousTitre ? ` · ${i.sousTitre}` : ""}
                </span>
                {i.release && <span className="hist-release">{i.release}</span>}
              </div>
            </div>
            <dl className="hist-infos">
              {lignes
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              <div>
                <dt>Quand</dt>
                <dd title={new Date(i.date).toLocaleString("fr-FR")}>{ilYa(i.date)}</dd>
              </div>
            </dl>
          </button>
        );
      })}
    </>
  );
}

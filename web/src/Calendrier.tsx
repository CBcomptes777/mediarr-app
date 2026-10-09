import { useMemo, useState } from "react";
import type { ItemCalendrier, TypeMedia } from "./api";
import {
  ecrireReglageCal, FILTRES_CAL_VIDES, filtrerCal, joursDeVue, jourDe, lireReglageCal, moisDeVue, regrouperParJour, service, STATUTS_CAL,
  statutDe, trierCal, TRIS_CAL, cle as cleDate, type ReglageCal, type StatutCal, type TriCal, type Vue,
} from "./calendrierLogique";
import { entier, heure, jourLong, majuscule } from "./format";
import { Releases, type CibleRecherche } from "./Releases";
import { Affiche, Feuille, Message } from "./ui";
import { useApi } from "./useApi";

const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
/** Couleur du point d'un jour, par service. */
const COULEUR: Record<TypeMedia, string> = { film: "#f59e42", serie: "#4f9cf9" };
const LIBELLE_STATUT: Record<StatutCal, string> = { disponible: "Disponible", telechargement: "Téléchargement en cours", manquant: "Manquant", avenir: "À venir" };
const CLASSE_STATUT: Record<StatutCal, string> = { disponible: "ok", telechargement: "dl", manquant: "manque", avenir: "" };
const VUES: { id: Vue; libelle: string }[] = [
  { id: "mois", libelle: "Mois" },
  { id: "semaine", libelle: "Semaine" },
  { id: "liste", libelle: "Liste" },
];

const Chevron = ({ sens }: { sens: "g" | "d" }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={sens === "g" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);

/** Cible de la recherche manuelle d'une entrée : le film, ou l'épisode (seulement si Sonarr a donné son identifiant). */
const cibleDe = (i: ItemCalendrier): CibleRecherche | null =>
  i.type === "film"
    ? { cible: "film", id: i.id, titre: i.titre, affiche: i.affiche }
    : i.episodeId
      ? { cible: "episode", id: i.episodeId, titre: `${i.titre} · ${i.sousTitre}`, affiche: i.affiche }
      : null;

export function Calendrier({ onOuvrir }: { onOuvrir: (type: TypeMedia, id: number) => void }) {
  const [recherche, setRecherche] = useState<CibleRecherche | null>(null);
  const [reglage, setReglage] = useState<ReglageCal>(() => lireReglageCal(typeof localStorage === "undefined" ? undefined : localStorage));
  const { vue, filtres, tri } = reglage;
  const [decalage, setDecalage] = useState(0);
  const [jourOuvert, setJourOuvert] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const maj = (r: Partial<ReglageCal>) => {
    const suite = { ...reglage, ...r };
    setReglage(suite);
    ecrireReglageCal(typeof localStorage === "undefined" ? undefined : localStorage, suite);
  };

  const maintenant = new Date();
  const aujourdhui = cleDate(maintenant);
  const jours = useMemo(() => joursDeVue(vue, decalage, aujourdhui), [vue, decalage, aujourdhui]);
  // Un jour de marge avant et après : un épisode tard le soir (UTC) peut tomber le jour voisin en local.
  const { data, erreur, chargement } = useApi<{ items: ItemCalendrier[]; erreurs: string[] }>(
    `/calendrier?debut=${jours[0] ? shift(jours[0], -1) : aujourdhui}&jours=${jours.length + 2}`,
  );

  const dansPlage = useMemo(() => (data?.items ?? []).filter((i) => jours.includes(jourDe(i))), [data, jours]);
  const filtres_ = useMemo(() => filtrerCal(dansPlage, filtres, maintenant), [dansPlage, filtres]); // eslint-disable-line react-hooks/exhaustive-deps
  const parJourTous = useMemo(() => regrouperParJour(dansPlage), [dansPlage]);
  const parJour = useMemo(() => regrouperParJour(trierCal(filtres_, tri)), [filtres_, tri]);
  const nbFiltres = (filtres.types.length ? 1 : 0) + (filtres.statuts.length ? 1 : 0) + (filtres.suivi !== "tous" ? 1 : 0);

  const mois = moisDeVue(decalage, aujourdhui);
  const titre =
    vue === "mois"
      ? majuscule(mois.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }))
      : `${jourCourt(jours[0])} – ${jourCourt(jours[jours.length - 1])}`;
  const unite = vue === "mois" ? "mois" : vue === "semaine" ? "semaine" : "30 jours";

  const points = (j: string) => {
    const types = new Set((parJour.get(j) ?? []).map((x) => x.type));
    return [...types];
  };

  const cellule = (j: string, i?: number) => {
    const t = points(j);
    const horsMois = vue === "mois" && Number(j.slice(5, 7)) !== mois.getMonth() + 1;
    const classes = ["jour", j === aujourdhui ? "auj" : "", horsMois ? "hors" : "", t.length ? "avec" : ""].filter(Boolean).join(" ");
    return (
      <button key={j} className={classes} onClick={() => setJourOuvert(j)} aria-label={`${jourLong(j)}${t.length ? `, ${parJour.get(j)!.length} sortie${parJour.get(j)!.length > 1 ? "s" : ""}` : ""}`}>
        {i !== undefined && <span>{JOURS[i]}</span>}
        <span className="num">{Number(j.slice(8))}</span>
        <span className="pts">
          {t.length === 0 && <span className="vide" />}
          {t.map((x) => (
            <span key={x} className="pt" style={{ background: j === aujourdhui ? "#1b1238" : COULEUR[x] }} />
          ))}
        </span>
      </button>
    );
  };

  const jourAvecItems = jours.filter((j) => (parJour.get(j) ?? []).length > 0);

  return (
    <>
      <header className="top">
        <span className="pilule">{titre}</span>
        <div className="paire">
          <button className="rond" aria-label={`Précédent (${unite})`} onClick={() => setDecalage((d) => d - 1)}>
            <Chevron sens="g" />
          </button>
          <button className="rond" aria-label={`Suivant (${unite})`} onClick={() => setDecalage((d) => d + 1)}>
            <Chevron sens="d" />
          </button>
        </div>
      </header>

      <div className="segments" role="tablist" aria-label="Affichage">
        {VUES.map((v) => (
          <button key={v.id} role="tab" aria-selected={vue === v.id} className={vue === v.id ? "actif" : ""} onClick={() => { maj({ vue: v.id }); setDecalage(0); }}>
            {v.libelle}
          </button>
        ))}
      </div>

      <div className="ligne-cal">
        <button className="bouton violet" disabled={decalage === 0} onClick={() => setDecalage(0)}>
          Aujourd'hui
        </button>
        <button className="bouton violet bouton-filtre-cal" onClick={() => setMenu(true)}>
          Filtres{nbFiltres > 0 && <span className="pastille-nb en-ligne">{nbFiltres}</span>}
        </button>
      </div>

      {vue === "semaine" && <div className="semaine">{jours.map((j, i) => cellule(j, i))}</div>}
      {vue === "mois" && (
        <div className="mois" role="grid" aria-label={titre}>
          {JOURS.map((j) => (
            <span key={j} className="mois-entete" role="columnheader">
              {j}
            </span>
          ))}
          {jours.map((j) => cellule(j))}
        </div>
      )}

      {data && (
        <div className="ligne-compteur" role="status">
          <span>
            {entier(filtres_.length)} résultat{filtres_.length > 1 ? "s" : ""}
          </span>
          {(nbFiltres > 0) && (
            <button className="lien" onClick={() => maj({ filtres: FILTRES_CAL_VIDES })}>
              Tout effacer
            </button>
          )}
        </div>
      )}

      {erreur && <Message erreur>{erreur}</Message>}
      {data?.erreurs.map((e) => (
        <Message key={e} erreur>
          {e}
        </Message>
      ))}
      {chargement && !data && <Message>Chargement…</Message>}
      {data && vue !== "mois" && jourAvecItems.length === 0 && (
        <Message>{nbFiltres > 0 && dansPlage.length > 0 ? "Rien ne correspond à ces filtres." : vue === "semaine" ? "Rien de prévu cette semaine." : "Rien de prévu sur cette période."}</Message>
      )}

      {vue === "liste" && (
        <div className="filtres defile" role="group" aria-label="Trier par">
          {TRIS_CAL.map((t) => (
            <button key={t.id} className={tri === t.id ? "actif" : ""} aria-pressed={tri === t.id} onClick={() => maj({ tri: t.id as TriCal })}>
              Trier : {t.libelle}
            </button>
          ))}
        </div>
      )}

      {vue !== "mois" &&
        (vue === "liste" && tri !== "date" ? (
          <section className="groupe">
            {trierCal(filtres_, tri).map((i) => (
              <LigneItem key={cleItem(i)} i={i} afficherJour onOuvrir={onOuvrir} maintenant={maintenant} />
            ))}
          </section>
        ) : (
          jourAvecItems.map((j) => (
            <section key={j} className="groupe">
              <h2 className="jour-titre">{jourLong(j)}</h2>
              {(parJour.get(j) ?? []).map((i) => (
                <LigneItem key={cleItem(i)} i={i} onOuvrir={onOuvrir} maintenant={maintenant} />
              ))}
            </section>
          ))
        ))}

      {vue === "mois" && data && dansPlage.length === 0 && <Message>Rien de prévu ce mois-ci.</Message>}

      {jourOuvert && (
        <Feuille titre={jourLong(jourOuvert)} sousTitre={sousTitreJour(parJourTous.get(jourOuvert) ?? [])} onFermer={() => setJourOuvert(null)}>
          {(parJourTous.get(jourOuvert) ?? []).length === 0 && <Message>Rien de prévu ce jour-là.</Message>}
          {trierCal(parJourTous.get(jourOuvert) ?? [], "date").map((i) => (
            <div key={cleItem(i)} className="entree-jour">
              <LigneItem i={i} onOuvrir={(t, id) => { setJourOuvert(null); onOuvrir(t, id); }} maintenant={maintenant} />
              {cibleDe(i) && (
                <button className="bouton violet" onClick={() => setRecherche(cibleDe(i))}>
                  Recherche manuelle
                </button>
              )}
            </div>
          ))}
        </Feuille>
      )}

      {recherche && <Releases {...recherche} onFermer={() => setRecherche(null)} />}

      {menu && (
        <Feuille titre="Filtres du calendrier" sousTitre={`${entier(filtres_.length)} résultat${filtres_.length > 1 ? "s" : ""}`} onFermer={() => setMenu(false)}>
          <fieldset className="groupe-filtre">
            <legend>Service</legend>
            <div className="filtres" role="group" aria-label="Service">
              {(["film", "serie"] as TypeMedia[]).map((t) => {
                const actif = filtres.types.includes(t);
                return (
                  <button key={t} className={actif ? "actif" : ""} aria-pressed={actif} onClick={() => maj({ filtres: { ...filtres, types: actif ? filtres.types.filter((x) => x !== t) : [...filtres.types, t] } })}>
                    {t === "film" ? "Films (Radarr)" : "Séries (Sonarr)"}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="groupe-filtre">
            <legend>Statut</legend>
            <div className="filtres enroule" role="group" aria-label="Statut">
              {STATUTS_CAL.map((s) => {
                const actif = filtres.statuts.includes(s.id);
                return (
                  <button key={s.id} className={actif ? "actif" : ""} aria-pressed={actif} onClick={() => maj({ filtres: { ...filtres, statuts: actif ? filtres.statuts.filter((x) => x !== s.id) : [...filtres.statuts, s.id] } })}>
                    {s.libelle}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="groupe-filtre">
            <legend>Surveillé</legend>
            <div className="filtres" role="group" aria-label="Surveillé">
              {(["tous", "oui", "non"] as const).map((v) => (
                <button key={v} className={filtres.suivi === v ? "actif" : ""} aria-pressed={filtres.suivi === v} onClick={() => maj({ filtres: { ...filtres, suivi: v } })}>
                  {v === "tous" ? "Tous" : v === "oui" ? "Surveillés" : "Non surveillés"}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="actions colonne">
            <button className="bouton violet" disabled={nbFiltres === 0} onClick={() => maj({ filtres: FILTRES_CAL_VIDES })}>
              Tout effacer
            </button>
            <button className="bouton plein" onClick={() => setMenu(false)}>
              Voir {entier(filtres_.length)} résultat{filtres_.length > 1 ? "s" : ""}
            </button>
          </div>
        </Feuille>
      )}
    </>
  );
}

const cleItem = (i: ItemCalendrier) => `${i.type}-${i.id}-${i.episodeId ?? i.sousTitre}`;
const shift = (k: string, n: number) => {
  const [y, m, d] = k.split("-").map(Number);
  const x = new Date(y, m - 1, d + n, 12);
  return cleDate(x);
};
const jourCourt = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};
const sousTitreJour = (items: ItemCalendrier[]) =>
  items.length === 0 ? "Aucune sortie" : `${items.length} sortie${items.length > 1 ? "s" : ""} · ${items.filter((i) => i.type === "film").length} film${items.filter((i) => i.type === "film").length > 1 ? "s" : ""}, ${items.filter((i) => i.type === "serie").length} épisode${items.filter((i) => i.type === "serie").length > 1 ? "s" : ""}`;

function LigneItem({ i, onOuvrir, maintenant, afficherJour }: {
  i: ItemCalendrier;
  onOuvrir: (type: TypeMedia, id: number) => void;
  maintenant: Date;
  afficherJour?: boolean;
}) {
  const statut = statutDe(i, maintenant);
  return (
    <button className="carte-cal" onClick={() => onOuvrir(i.type, i.id)}>
      <Affiche src={i.affiche} titre={i.titre} className="cal-img" />
      <div className="cal-texte">
        <span className="cal-titre">{i.titre}</span>
        <span className="cal-sous">
          {afficherJour ? `${jourCourt(jourDe(i))} · ` : ""}
          {i.sousTitre}
          {i.heure ? ` · ${heure(i.date)}` : ""}
        </span>
        <span className="cal-src" style={{ color: i.type === "film" ? "#fdba74" : "#93c5fd" }}>
          {service(i)}
          {i.suivi ? " · surveillé" : ""}
        </span>
      </div>
      <span className={`badge statut ${CLASSE_STATUT[statut]}`}>{LIBELLE_STATUT[statut]}</span>
    </button>
  );
}

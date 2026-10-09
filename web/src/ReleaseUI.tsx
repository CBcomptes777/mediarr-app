// Morceaux communs aux deux recherches interactives (Radarr / Sonarr dans Releases.tsx, Prowlarr dans Indexeurs.tsx) :
// carte d'un résultat, filtres, feuille de confirmation. Même rendu partout.
import { useState } from "react";
import type { Release } from "./api";
import { age, entier, taille } from "./format";
import {
  classeSeeders, comptesIndexeurs, FILTRES_REL_VIDES, languesPresentes, libelleResolution, nbFiltresReleases, resolutionsPresentes, texteSeeders,
  TRIS, type FiltresReleases, type Tri,
} from "./releasesLogique";
import { Feuille } from "./ui";

/** Pourquoi télécharger cette release demande une attention particulière (liste vide = rien à signaler). */
export function avertissements(r: Release, fichierQualite: string | null): string[] {
  const a: string[] = [];
  if (r.rejete) a.push(`Release rejetée : ${r.raisons.length ? r.raisons.join(" ; ") : "refusée par le service"}.`);
  if (r.inferieure) a.push(`Qualité inférieure au fichier actuel${fichierQualite ? ` (${fichierQualite})` : ""}.`);
  if (r.dejaTelecharge) a.push("C'est la même release que le fichier actuel.");
  return a;
}

const CODES_LANGUE: Record<string, string> = {
  français: "FR", french: "FR", "français (sous-titres)": "VOSTFR", anglais: "EN", english: "EN", multi: "MULTI", allemand: "DE", german: "DE",
  espagnol: "ES", spanish: "ES", italien: "IT", italian: "IT", japonais: "JA", japanese: "JA", coréen: "KO", korean: "KO", original: "VO",
  unknown: "?", inconnue: "?",
};
export const codeLangue = (nom: string) => CODES_LANGUE[nom.toLowerCase()] ?? nom.slice(0, 3).toUpperCase();

export interface EtatEnvoiCarte {
  /** Texte de succès (« Envoyé à qBittorrent »). */
  succes?: string;
  /** Cause de l'échec. */
  echec?: string;
  occupe?: boolean;
}

export function CarteRelease({ r, fichierQualite, etat, onTelecharger, envoiImpossible }: {
  r: Release;
  fichierQualite: string | null;
  etat: EtatEnvoiCarte;
  onTelecharger: (r: Release) => void;
  /** Texte à la place du bouton quand l'envoi n'est pas possible (pas de guid…). */
  envoiImpossible?: string;
}) {
  const avert = avertissements(r, fichierQualite);
  return (
    <article className={r.rejete ? "release rejetee" : r.meilleurChoix ? "release meilleure" : "release"}>
      <div className="badges">
        {r.meilleurChoix && <span className="badge-r vert">Meilleur choix</span>}
        {r.dejaTelecharge && <span className="badge-r bleu">Déjà téléchargé</span>}
        {r.miseANiveau && <span className="badge-r violet">Mise à niveau</span>}
        {r.pack && <span className="badge-r bleu">Pack de saison</span>}
        {r.rejete && <span className="badge-r rouge">Rejeté</span>}
        {r.qualite && <span className="badge-r qualite">{r.qualite}</span>}
        {r.langues.map((l) => (
          <span key={l} className="badge-r langue" title={l}>
            {codeLangue(l)}
          </span>
        ))}
      </div>
      <div className="release-titre">{r.titre}</div>
      <div className="release-ligne">
        {r.seeders !== null && (
          <span className="seeds">
            <span className={`seed-badge ${classeSeeders(r.seeders)}`} aria-label={r.seeders > 0 ? `${r.seeders} seeders` : "Aucun seeder"} title={r.seeders > 0 ? `${r.seeders} seeders` : "Aucun seeder"}>
              {texteSeeders(r.seeders)}
            </span>
            {r.leechers !== null && (
              <span className="leech-badge" aria-label={`${r.leechers} leechers`} title={`${r.leechers} leechers`}>
                ▼ {r.leechers}
              </span>
            )}
          </span>
        )}
        <span className="release-infos-texte">
          {[r.indexeur, r.protocole === "torrent" ? "Torrent" : "Usenet", taille(r.tailleOctets), age(r.ageMinutes)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="release-infos">
        {r.score !== null && r.score !== 0 && (
          <span>
            Score {r.score > 0 ? "+" : ""}
            {r.score}
          </span>
        )}
        {r.groupe && <span>Groupe {r.groupe}</span>}
      </div>
      {r.rejete && (
        <ul className="raisons">
          {r.raisons.slice(0, 3).map((x) => (
            <li key={x}>{x}</li>
          ))}
          {r.raisons.length === 0 && <li>Rejetée par le service</li>}
        </ul>
      )}

      {etat.succes ? (
        <span className="envoye" role="status">
          ✓ {etat.succes}
        </span>
      ) : envoiImpossible ? (
        <span className="muted">{envoiImpossible}</span>
      ) : (
        <>
          {etat.echec && (
            <p className="card error" role="alert">
              {etat.echec}
            </p>
          )}
          <button className="bouton violet plein" disabled={etat.occupe || !r.telechargeable} onClick={() => onTelecharger(r)}>
            {etat.occupe ? "Envoi…" : avert.length > 0 ? "Télécharger quand même…" : "Télécharger"}
          </button>
        </>
      )}
    </article>
  );
}

/** Feuille de confirmation : rappelle ce qui va être téléchargé avant d'envoyer au client. */
export function ConfirmerTelechargement({ r, fichierQualite, occupe, onConfirmer, onAnnuler }: {
  r: Release;
  fichierQualite: string | null;
  occupe: boolean;
  onConfirmer: () => void;
  onAnnuler: () => void;
}) {
  const avert = avertissements(r, fichierQualite);
  return (
    <Feuille titre={avert.length ? "Télécharger quand même ?" : "Télécharger cette release ?"} sousTitre="Elle sera envoyée au client de téléchargement" onFermer={onAnnuler}>
      <p className="torrent-nom">{r.titre}</p>
      <dl className="fichier-actuel confirmation-infos">
        <div><dt>Indexeur</dt><dd>{r.indexeur || "—"}</dd></div>
        <div><dt>Langue</dt><dd>{r.langues.length ? r.langues.join(", ") : "—"}</dd></div>
        <div><dt>Taille</dt><dd>{taille(r.tailleOctets)}</dd></div>
        <div><dt>Seeders</dt><dd>{r.seeders === null ? "— (Usenet)" : `${entier(r.seeders)}${r.leechers !== null ? ` · ▼ ${entier(r.leechers)}` : ""}`}</dd></div>
        <div><dt>Qualité</dt><dd>{r.qualite ?? "—"}</dd></div>
        <div><dt>Âge</dt><dd>{age(r.ageMinutes)}</dd></div>
      </dl>
      {avert.map((x) => (
        <p key={x} className="card avertissement" role="alert">
          {x}
        </p>
      ))}
      <div className="actions colonne">
        <button className={avert.length ? "bouton violet danger" : "bouton plein"} disabled={occupe} onClick={onConfirmer}>
          {occupe ? "Envoi…" : avert.length ? "Oui, télécharger quand même" : "Télécharger"}
        </button>
        <button className="bouton violet" onClick={onAnnuler}>
          Annuler
        </button>
      </div>
    </Feuille>
  );
}

function Groupe<T extends string | number>({ titre, options, choisis, onChange, libelle }: {
  titre: string;
  options: { valeur: T; texte: string }[];
  choisis: T[];
  onChange: (v: T[]) => void;
  libelle?: never;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="groupe-filtre">
      <legend>{titre}</legend>
      <div className="filtres enroule" role="group" aria-label={titre}>
        {options.map((o) => {
          const actif = choisis.includes(o.valeur);
          return (
            <button key={String(o.valeur)} className={actif ? "actif" : ""} aria-pressed={actif} onClick={() => onChange(actif ? choisis.filter((x) => x !== o.valeur) : [...choisis, o.valeur])}>
              {o.texte}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Tri + panneau de filtres (Langue, Indexeur avec compteurs, Résolution, Protocole, Seeders minimum). */
export function FiltresRecherche({ pool, filtres, onChange, tri, onTri }: {
  /** Résultats avant filtrage (sert à lister les choix et à compter par indexeur). */
  pool: Release[];
  filtres: FiltresReleases;
  onChange: (f: FiltresReleases) => void;
  tri: Tri;
  onTri: (t: Tri) => void;
}) {
  const [ouvert, setOuvert] = useState(false);
  const nb = nbFiltresReleases(filtres);
  const set = <K extends keyof FiltresReleases>(k: K, v: FiltresReleases[K]) => onChange({ ...filtres, [k]: v });
  const aDesTorrents = pool.some((r) => r.seeders !== null);
  return (
    <>
      <div className="filtres defile" role="group" aria-label="Trier par">
        {TRIS.map((t) => (
          <button key={t.code} className={t.code === tri ? "actif" : ""} aria-pressed={t.code === tri} onClick={() => onTri(t.code)}>
            {t.libelle}
          </button>
        ))}
      </div>
      <button className="bouton violet" aria-expanded={ouvert} onClick={() => setOuvert(!ouvert)}>
        Filtres{nb > 0 ? ` (${nb})` : ""} {ouvert ? "▴" : "▾"}
      </button>
      {ouvert && (
        <div className="panneau-filtres">
          <Groupe titre="Langue" options={languesPresentes(pool).map((l) => ({ valeur: l, texte: l }))} choisis={filtres.langues} onChange={(v) => set("langues", v)} />
          <Groupe titre="Indexeur" options={comptesIndexeurs(pool).map((i) => ({ valeur: i.nom, texte: `${i.nom} (${i.n})` }))} choisis={filtres.indexeurs} onChange={(v) => set("indexeurs", v)} />
          <Groupe titre="Résolution" options={resolutionsPresentes(pool).map((r) => ({ valeur: r, texte: libelleResolution(r) }))} choisis={filtres.resolutions} onChange={(v) => set("resolutions", v)} />
          <Groupe
            titre="Protocole"
            options={(["torrent", "usenet"] as const).filter((p) => pool.some((r) => r.protocole === p)).map((p) => ({ valeur: p, texte: p === "torrent" ? "Torrent" : "Usenet" }))}
            choisis={filtres.protocoles}
            onChange={(v) => set("protocoles", v)}
          />
          {aDesTorrents && (
            <label className="champ-compact">
              <span>Seeders minimum</span>
              <select value={filtres.seedersMin} onChange={(e) => set("seedersMin", Number(e.target.value))}>
                {[0, 1, 5, 10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Aucun minimum" : `${n} ou plus`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="bouton violet" disabled={nb === 0} onClick={() => onChange(FILTRES_REL_VIDES)}>
            Effacer les filtres
          </button>
        </div>
      )}
    </>
  );
}

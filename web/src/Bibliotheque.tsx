import { useEffect, useMemo, useRef, useState } from "react";
import type { ResumeMedia, TypeMedia } from "./api";
import {
  decennie, ecrireReglage, FILTRES_VIDES, filtrer, lireReglage, nbFiltresActifs, nettoyerReglage, optionsDe, STATUTS, trier, TRIS_BIBLIO,
  type Filtres, type Tri,
} from "./bibliothequeLogique";
import { duree, entier, normaliser } from "./format";
import { usePrefs } from "./prefs";
import { Affiche, BadgeEtat, Feuille, Message } from "./ui";
import { useApi } from "./useApi";

/** Nombre de titres dessinés d'un coup : avec 800+ titres, on en ajoute 40 de plus en descendant. */
const PAGE = 40;

type TypeAffiche = TypeMedia | "tout";

export function Bibliotheque({
  onOuvrir,
  onAjouter,
  typeInitial = "film",
  typeFixe,
}: {
  onOuvrir: (type: TypeMedia, id: number) => void;
  onAjouter: () => void;
  typeInitial?: TypeMedia;
  /** Si défini (bibliothèque scindée en onglets), un seul type est affiché et les onglets Films / Séries disparaissent. */
  typeFixe?: TypeMedia;
}) {
  const { data, erreur, chargement } = useApi<{ items: ResumeMedia[]; erreurs: string[] }>("/bibliotheque");
  const [type, setType] = useState<TypeAffiche>(typeInitial);
  // Filtres et tri : mémorisés entre les visites (localStorage), la recherche texte aussi.
  const [reglage, setReglage] = useState(() => lireReglage(typeof localStorage === "undefined" ? undefined : localStorage));
  const { filtres, tri } = reglage;
  const [feuille, setFeuille] = useState(false);
  const [visibles, setVisibles] = useState(PAGE);

  const maj = (f: Filtres, t: Tri = tri) => {
    const r = { filtres: f, tri: t };
    setReglage(r);
    ecrireReglage(typeof localStorage === "undefined" ? undefined : localStorage, r);
  };

  const tous = data?.items ?? [];
  const nbFilms = tous.filter((i) => i.type === "film").length;
  const typeCourant: TypeAffiche = typeFixe ?? type;
  const dansType = useMemo(() => (typeCourant === "tout" ? tous : tous.filter((i) => i.type === typeCourant)), [tous, typeCourant]);
  const resultats = useMemo(() => trier(filtrer(dansType, filtres), tri), [dansType, filtres, tri]);
  const nbActifs = nbFiltresActifs(filtres);

  // Retour en haut de liste quand le résultat change.
  useEffect(() => setVisibles(PAGE), [resultats]);
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cible = fin.current;
    if (!cible || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver((e) => e[0].isIntersecting && setVisibles((n) => n + PAGE), { rootMargin: "600px" });
    obs.observe(cible);
    return () => obs.disconnect();
  }, [resultats, visibles]);

  return (
    <>
      <header className="top">
        <h1>{typeFixe === "film" ? "Films" : typeFixe === "serie" ? "Séries" : "Bibliothèque"}</h1>
        <button className="pilule bouton-pilule" onClick={onAjouter}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Ajouter
        </button>
      </header>

      {!typeFixe && (
        <div className="segments" role="tablist" aria-label="Type de média">
          <button role="tab" aria-selected={type === "film"} className={type === "film" ? "actif" : ""} onClick={() => setType("film")}>
            Films · {nbFilms}
          </button>
          <button role="tab" aria-selected={type === "serie"} className={type === "serie" ? "actif" : ""} onClick={() => setType("serie")}>
            Séries · {tous.length - nbFilms}
          </button>
          <button role="tab" aria-selected={type === "tout"} className={type === "tout" ? "actif" : ""} onClick={() => setType("tout")}>
            Tout
          </button>
        </div>
      )}

      <div className="ajout-ligne">
        <label className="recherche">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            aria-label="Rechercher dans la bibliothèque"
            placeholder="Rechercher dans la bibliothèque…"
            value={filtres.recherche}
            onChange={(e) => maj({ ...filtres, recherche: e.target.value })}
          />
        </label>
        <button className="rond bouton-filtre" aria-label={nbActifs ? `Filtres, ${nbActifs} actif${nbActifs > 1 ? "s" : ""}` : "Filtres"} onClick={() => setFeuille(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16l-6 8v5l-4 2v-7z" />
          </svg>
          {nbActifs > 0 && <span className="pastille-nb">{nbActifs}</span>}
        </button>
      </div>

      <div className="ligne-tri">
        <label className="champ-compact">
          <span>Trier par</span>
          <select value={tri.cle} onChange={(e) => maj(filtres, { ...tri, cle: e.target.value as Tri["cle"] })}>
            {TRIS_BIBLIO.map((t) => (
              <option key={t.id} value={t.id}>
                {t.libelle}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rond"
          aria-label={tri.desc ? "Ordre décroissant, passer en croissant" : "Ordre croissant, passer en décroissant"}
          onClick={() => maj(filtres, { ...tri, desc: !tri.desc })}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: tri.desc ? "none" : "scaleY(-1)" }}>
            <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
          </svg>
        </button>
      </div>

      {data && (
        <div className="ligne-compteur" role="status">
          <span>
            {entier(resultats.length)} résultat{resultats.length > 1 ? "s" : ""}
          </span>
          {(nbActifs > 0 || filtres.recherche) && (
            <button className="lien" onClick={() => maj(FILTRES_VIDES)}>
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
      {data && resultats.length === 0 && (
        <Message>
          {nbActifs > 0 || filtres.recherche ? "Aucun résultat avec ces filtres." : typeCourant === "serie" ? "Aucune série." : typeCourant === "film" ? "Aucun film." : "Aucun titre."}
        </Message>
      )}

      {resultats.slice(0, visibles).map((m) => {
        const meta = [m.annee, duree(m.dureeMin), m.qualite].filter(Boolean).join(" · ");
        return (
          <button key={`${m.type}-${m.id}`} className="media" onClick={() => onOuvrir(m.type, m.id)}>
            <div className="media-g">
              <Affiche src={m.affiche} titre={m.titre} className="media-img" />
              <BadgeEtat etat={m.etat} pct={m.progression} />
            </div>
            <div className="media-d">
              <span className="media-titre">{m.titre}</span>
              {meta && <span className="media-meta">{meta}</span>}
              {m.synopsis && <span className="media-synopsis">{m.synopsis}</span>}
              {m.genres.length > 0 && <span className="media-genres">{m.genres.join(", ")}</span>}
            </div>
          </button>
        );
      })}
      {visibles < resultats.length && (
        <div ref={fin}>
          <button className="bouton violet" onClick={() => setVisibles((n) => n + PAGE)}>
            Afficher plus ({entier(resultats.length - visibles)} restants)
          </button>
        </div>
      )}

      {feuille && (
        <MenuFiltres
          dansType={dansType}
          typeFixe={typeFixe}
          filtres={filtres}
          tri={tri}
          nbResultats={resultats.length}
          onChange={maj}
          onFermer={() => setFeuille(false)}
        />
      )}
    </>
  );
}

function Choix<T extends string | number>({ titre, options, choisis, onChange, libelle }: {
  titre: string;
  options: T[];
  choisis: T[];
  onChange: (v: T[]) => void;
  libelle?: (v: T) => string;
}) {
  const [tout, setTout] = useState(false);
  if (options.length === 0) return null;
  // Longues listes (genres, studios) : on en montre 12 puis « Voir tout ».
  const montres = tout ? options : options.filter((o, i) => i < 12 || choisis.includes(o));
  return (
    <fieldset className="groupe-filtre">
      <legend>{titre}</legend>
      <div className="filtres enroule" role="group" aria-label={titre}>
        {montres.map((o) => {
          const actif = choisis.includes(o);
          return (
            <button key={String(o)} className={actif ? "actif" : ""} aria-pressed={actif} onClick={() => onChange(actif ? choisis.filter((x) => x !== o) : [...choisis, o])}>
              {libelle ? libelle(o) : String(o)}
            </button>
          );
        })}
        {montres.length < options.length && (
          <button className="lien" onClick={() => setTout(true)}>
            Voir tout ({options.length})
          </button>
        )}
      </div>
    </fieldset>
  );
}

function MenuFiltres({ dansType, typeFixe, filtres, tri, nbResultats, onChange, onFermer }: {
  dansType: ResumeMedia[];
  typeFixe?: TypeMedia;
  filtres: Filtres;
  tri: Tri;
  nbResultats: number;
  onChange: (f: Filtres, t?: Tri) => void;
  onFermer: () => void;
}) {
  const { prefs, sauvegarder } = usePrefs();
  const [nom, setNom] = useState("");
  const [echec, setEchec] = useState<string | null>(null);
  const opts = useMemo(() => optionsDe(dansType), [dansType]);
  const set = <K extends keyof Filtres>(cle: K, valeur: Filtres[K]) => onChange({ ...filtres, [cle]: valeur });
  const nbActifs = nbFiltresActifs(filtres);

  async function enregistrer() {
    const n = nom.trim();
    if (!n) return;
    setEchec(null);
    try {
      await sauvegarder((p) => ({
        ...p,
        filtresBiblio: [...p.filtresBiblio.filter((x) => normaliser(x.nom) !== normaliser(n)), { id: `f${Date.now().toString(36)}`, nom: n, filtres, tri }].slice(-30),
      }));
      setNom("");
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Enregistrement impossible");
    }
  }
  const supprimer = (id: string) =>
    sauvegarder((p) => ({ ...p, filtresBiblio: p.filtresBiblio.filter((x) => x.id !== id) })).catch((e) =>
      setEchec(e instanceof Error ? e.message : "Suppression impossible"),
    );

  return (
    <Feuille titre="Filtres" sousTitre={`${entier(nbResultats)} résultat${nbResultats > 1 ? "s" : ""}`} onFermer={onFermer}>
      {prefs.filtresBiblio.length > 0 && (
        <fieldset className="groupe-filtre">
          <legend>Filtres enregistrés</legend>
          <ul className="filtres-enregistres">
            {prefs.filtresBiblio.map((f) => (
              <li key={f.id}>
                <button className="bouton violet" onClick={() => { const r = nettoyerReglage(f); onChange(r.filtres, r.tri); }}>
                  {f.nom}
                </button>
                <button className="rond" aria-label={`Supprimer le filtre ${f.nom}`} onClick={() => supprimer(f.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {!typeFixe && (
        <Choix titre="Type de média" options={["film", "serie"] as TypeMedia[]} choisis={filtres.types} onChange={(v) => set("types", v)} libelle={(v) => (v === "film" ? "Films" : "Séries")} />
      )}
      <Choix titre="Statut" options={STATUTS.map((s) => s.id)} choisis={filtres.statuts} onChange={(v) => set("statuts", v)} libelle={(v) => STATUTS.find((s) => s.id === v)!.libelle} />
      <fieldset className="groupe-filtre">
        <legend>Surveillé</legend>
        <div className="filtres" role="group" aria-label="Surveillé">
          {(["tous", "oui", "non"] as const).map((v) => (
            <button key={v} className={filtres.suivi === v ? "actif" : ""} aria-pressed={filtres.suivi === v} onClick={() => set("suivi", v)}>
              {v === "tous" ? "Tous" : v === "oui" ? "Surveillés" : "Non surveillés"}
            </button>
          ))}
        </div>
      </fieldset>
      {!typeFixe && <Choix titre="Service" options={["Radarr", "Sonarr"]} choisis={filtres.services} onChange={(v) => set("services", v)} />}
      <Choix titre="Genre" options={opts.genres} choisis={filtres.genres} onChange={(v) => set("genres", v)} />
      <Choix titre="Décennie" options={opts.decennies} choisis={filtres.decennies} onChange={(v) => set("decennies", v)} libelle={(d) => `${d}-${String(decennie(d) + 9).slice(2)}`} />
      <Choix titre="Qualité (profil)" options={opts.profils} choisis={filtres.profils} onChange={(v) => set("profils", v)} />
      <Choix titre="Langue d'origine" options={opts.langues} choisis={filtres.langues} onChange={(v) => set("langues", v)} />
      <Choix titre="Studio / chaîne" options={opts.studios} choisis={filtres.studios} onChange={(v) => set("studios", v)} />

      <fieldset className="groupe-filtre">
        <legend>Enregistrer ce filtre</legend>
        <form
          className="ajout-ligne"
          onSubmit={(e) => {
            e.preventDefault();
            enregistrer();
          }}
        >
          <label className="recherche">
            <input aria-label="Nom du filtre" placeholder="Nom (ex. Films 4K manquants)" maxLength={40} value={nom} onChange={(e) => setNom(e.target.value)} />
          </label>
          <button type="submit" className="bouton violet" disabled={!nom.trim() || nbActifs === 0}>
            Enregistrer
          </button>
        </form>
        {echec && <p className="card error" role="alert">{echec}</p>}
      </fieldset>

      <div className="actions colonne">
        <button className="bouton violet" disabled={nbActifs === 0} onClick={() => onChange({ ...FILTRES_VIDES, recherche: filtres.recherche })}>
          Tout effacer
        </button>
        <button className="bouton plein" onClick={onFermer}>
          Voir {entier(nbResultats)} résultat{nbResultats > 1 ? "s" : ""}
        </button>
      </div>
    </Feuille>
  );
}

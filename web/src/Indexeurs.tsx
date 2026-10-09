import { useMemo, useState } from "react";
import { action, type Release } from "./api";
import { dateCourte, entier, ilYa } from "./format";
import { CarteRelease, ConfirmerTelechargement, FiltresRecherche, type EtatEnvoiCarte } from "./ReleaseUI";
import { FILTRES_REL_VIDES, filtrerReleases, trier, type FiltresReleases, type Tri } from "./releasesLogique";
import { BoutonRetour, DialogueConfirmation, Message } from "./ui";
import { useApi } from "./useApi";

interface Test {
  date: string;
  ok: boolean;
  cause: string | null;
}
interface Indexeur {
  id: number;
  nom: string;
  protocole: "torrent" | "usenet";
  priorite: number;
  actif: boolean;
  statut: "actif" | "desactive" | "echec";
  dernierEchec: string | null;
  premierEchec: string | null;
  reessaiApres: string | null;
  cause: string | null;
  causeSource: "test" | "prowlarr" | null;
  test: Test | null;
}
interface AlerteSante {
  niveau: "avertissement" | "erreur";
  message: string;
}
interface StatIndexeur {
  id: number;
  nom: string;
  requetes: number;
  echecs: number;
  grabs: number;
  tempsMoyenMs: number | null;
}
interface ResultatRecherche {
  /** null : envoi impossible (le guid pourrait contenir un secret). */
  guid: string | null;
  indexerId: number | null;
  langues: string[];
  resolution: number | null;
  titre: string;
  indexeur: string;
  protocole: "torrent" | "usenet";
  tailleOctets: number;
  seeders: number | null;
  leechers: number | null;
  ageMinutes: number;
  categorie: string | null;
}

/** Un résultat Prowlarr sous la forme d'une release, pour réutiliser la carte, les filtres et la confirmation de la recherche manuelle. */
const enRelease = (r: ResultatRecherche, i: number): Release => ({
  guid: r.guid ?? `sans-guid-${i}`,
  indexerId: r.indexerId ?? 0,
  titre: r.titre,
  indexeur: r.indexeur,
  protocole: r.protocole,
  qualite: r.resolution ? (r.resolution >= 2160 ? "4K" : `${r.resolution}p`) : null,
  rang: r.resolution ?? 0,
  resolution: r.resolution,
  groupe: null,
  dejaTelecharge: false,
  miseANiveau: false,
  inferieure: false,
  meilleurChoix: false,
  tailleOctets: r.tailleOctets,
  seeders: r.seeders,
  leechers: r.leechers,
  ageMinutes: r.ageMinutes,
  langues: r.langues,
  score: null,
  rejete: false,
  raisons: [],
  telechargeable: true,
});

const cle = (r: { seeders: number | null }) => (r.seeders === null ? 4.5 : r.seeders);
type Vue = "indexeurs" | "stats" | "recherche";
const LIBELLE_STATUT = { actif: "Actif", desactive: "Désactivé", echec: "En échec" } as const;

/** Écran « Indexeurs » (Prowlarr) : état et cause des échecs, tests, statistiques sur 7 jours, recherche en lecture seule. */
export function Indexeurs({ onRetour, termeInitial }: { onRetour: () => void; termeInitial?: string }) {
  const [vue, setVue] = useState<Vue>(termeInitial ? "recherche" : "indexeurs");
  return (
    <>
      <header className="top">
        <BoutonRetour onClick={onRetour} />
        <h1>Indexeurs</h1>
        <span style={{ width: 44 }} />
      </header>
      <div className="segments" role="tablist" aria-label="Indexeurs">
        {([["indexeurs", "Indexeurs"], ["stats", "Statistiques"], ["recherche", "Recherche"]] as const).map(([v, l]) => (
          <button key={v} role="tab" aria-selected={vue === v} className={vue === v ? "actif" : ""} onClick={() => setVue(v)}>
            {l}
          </button>
        ))}
      </div>
      {vue === "indexeurs" && <VueIndexeurs />}
      {vue === "stats" && <VueStats />}
      {vue === "recherche" && <VueRecherche termeInitial={termeInitial} />}
    </>
  );
}

function VueIndexeurs() {
  const { data, erreur, chargement, recharger } = useApi<{ items: Indexeur[]; alertes: AlerteSante[] }>("/indexeurs", 60000);
  const [aTester, setATester] = useState<Indexeur | null>(null);
  const [toutTester, setToutTester] = useState(false);
  const [enCours, setEnCours] = useState<Set<number>>(new Set());
  const [toutEnCours, setToutEnCours] = useState(false);
  const [resume, setResume] = useState<string | null>(null);
  const [echec, setEchec] = useState<string | null>(null);

  async function tester(i: Indexeur) {
    setEnCours((s) => new Set(s).add(i.id));
    setEchec(null);
    try {
      await action("POST", `/indexeurs/${i.id}/tester`);
      recharger(); // le résultat du test est gardé par le serveur et revient dans la liste
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Test impossible");
    } finally {
      setEnCours((s) => {
        const n = new Set(s);
        n.delete(i.id);
        return n;
      });
    }
  }

  async function testerTout() {
    setToutEnCours(true);
    setEchec(null);
    setResume(null);
    try {
      const r = await action<{ ok: number; echecs: number }>("POST", "/indexeurs/tester-tout");
      setResume(`Test terminé : ${r.ok} indexeur${r.ok > 1 ? "s" : ""} en bon état, ${r.echecs} en échec.`);
      recharger();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Test impossible");
    } finally {
      setToutEnCours(false);
    }
  }

  const items = data?.items ?? [];
  const nbEchec = items.filter((i) => i.statut === "echec").length;

  return (
    <>
      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && !data && <Message>Chargement…</Message>}
      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {data?.alertes.map((a, i) => (
        <p key={i} className={a.niveau === "erreur" ? "card alerte-carte erreur" : "card alerte-carte"} role="status">
          {a.message}
        </p>
      ))}

      {data && (
        <div className="indexeurs-resume">
          <span className={nbEchec ? "chip warn rouge" : "chip"}>
            {nbEchec ? `${nbEchec} en échec` : "Tous les indexeurs actifs fonctionnent"}
          </span>
          <button className="bouton violet" disabled={toutEnCours || items.length === 0} onClick={() => setToutTester(true)}>
            {toutEnCours ? "Test en cours…" : "Tout tester"}
          </button>
        </div>
      )}
      {resume && (
        <p className="muted" role="status">
          {resume}
        </p>
      )}
      {data && items.length === 0 && <Message>Aucun indexeur dans Prowlarr.</Message>}

      {items.map((i) => (
        <article key={i.id} className={`card indexeur ${i.statut}`}>
          <div className="indexeur-tete">
            <strong className="indexeur-nom">{i.nom}</strong>
            <span className={`statut-pastille ${i.statut}`}>{LIBELLE_STATUT[i.statut]}</span>
          </div>
          <div className="muted">
            {i.protocole === "torrent" ? "Torrent" : "Usenet"} · Priorité {i.priorite}
          </div>
          {i.statut === "echec" && (
            <div className="cause-echec" role="alert">
              <strong>{i.cause}</strong>
              {i.dernierEchec && (
                <span>
                  Dernier échec : {ilYa(i.dernierEchec)} ({dateCourte(i.dernierEchec)})
                  {i.premierEchec ? ` · en échec depuis le ${dateCourte(i.premierEchec)}` : ""}
                </span>
              )}
              {i.reessaiApres && <span>Prowlarr réessaiera après {dateCourte(i.reessaiApres)} {new Date(i.reessaiApres).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.</span>}
            </div>
          )}
          {i.test && (
            <div className={i.test.ok ? "resultat-test ok" : "resultat-test ko"} role="status">
              {i.test.ok ? "✓ Dernier test : réussi" : `✗ Dernier test : ${i.test.cause}`} <span className="muted">({ilYa(i.test.date)})</span>
            </div>
          )}
          {i.statut !== "desactive" && (
            <button className="bouton violet" disabled={enCours.has(i.id) || toutEnCours} onClick={() => setATester(i)}>
              {enCours.has(i.id) ? "Test en cours…" : "Tester"}
            </button>
          )}
        </article>
      ))}

      {aTester && (
        <DialogueConfirmation
          titre="Tester cet indexeur ?"
          texte={`Prowlarr enverra une requête de test à « ${aTester.nom} ». Rien n'est modifié ni supprimé.`}
          boutons={[
            {
              libelle: "Lancer le test",
              variante: "plein",
              onClick: () => {
                const i = aTester;
                setATester(null);
                tester(i);
              },
            },
          ]}
          onAnnuler={() => setATester(null)}
        />
      )}
      {toutTester && (
        <DialogueConfirmation
          titre="Tester tous les indexeurs ?"
          texte={`Prowlarr va tester les ${items.filter((i) => i.statut !== "desactive").length} indexeurs actifs. Cela peut durer une minute. Rien n'est modifié ni supprimé.`}
          boutons={[
            {
              libelle: "Tout tester",
              variante: "plein",
              onClick: () => {
                setToutTester(false);
                testerTout();
              },
            },
          ]}
          onAnnuler={() => setToutTester(false)}
        />
      )}
    </>
  );
}

function VueStats() {
  const { data, erreur, chargement } = useApi<{ jours: number; items: StatIndexeur[] }>("/indexeurs/stats");
  return (
    <>
      <p className="muted">Activité des indexeurs sur les 7 derniers jours.</p>
      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && !data && <Message>Chargement…</Message>}
      {data && data.items.length === 0 && <Message>Aucune activité sur cette période.</Message>}
      {data?.items.map((s) => {
        const taux = s.requetes ? s.echecs / s.requetes : 0;
        const classe = s.requetes === 0 ? "" : taux >= 0.5 ? "rouge" : s.echecs > 0 ? "orange" : "vert";
        return (
          <article key={s.id} className="card stat-indexeur">
            <strong>{s.nom}</strong>
            <dl className="hist-infos">
              <div><dt>Requêtes</dt><dd>{entier(s.requetes)}</dd></div>
              <div>
                <dt>Échecs</dt>
                <dd className={`taux ${classe}`}>
                  {entier(s.echecs)}
                  {s.requetes ? ` (${Math.round(taux * 100)} %)` : ""}
                </dd>
              </div>
              <div><dt>Grabs</dt><dd>{entier(s.grabs)}</dd></div>
              <div><dt>Temps moyen</dt><dd>{s.tempsMoyenMs ? `${entier(s.tempsMoyenMs)} ms` : "—"}</dd></div>
            </dl>
          </article>
        );
      })}
    </>
  );
}

function VueRecherche({ termeInitial }: { termeInitial?: string }) {
  const [saisie, setSaisie] = useState(termeInitial ?? "");
  const [terme, setTerme] = useState(termeInitial ?? "");
  const { data, erreur, chargement } = useApi<{ items: ResultatRecherche[] }>(
    terme.length >= 2 ? `/indexeurs/recherche?q=${encodeURIComponent(terme)}` : null,
  );
  const [tri, setTri] = useState<Tri>("seeders");
  const [filtres, setFiltres] = useState<FiltresReleases>(FILTRES_REL_VIDES);
  const [etats, setEtats] = useState<Record<string, EtatEnvoiCarte>>({});
  const [aConfirmer, setAConfirmer] = useState<Release | null>(null);

  const brut = data?.items ?? [];
  const tous = useMemo(() => brut.map(enRelease), [brut]);
  const sansEnvoi = useMemo(() => new Set(brut.flatMap((r, i) => (r.guid === null ? [enRelease(r, i).guid] : []))), [brut]);
  const items = useMemo(() => trier(filtrerReleases(tous, filtres), tri), [tous, filtres, tri]);
  const note = (guid: string, e: EtatEnvoiCarte) => setEtats((s) => ({ ...s, [guid]: e }));

  async function envoyer(r: Release) {
    setAConfirmer(null);
    note(r.guid, { occupe: true });
    try {
      const res = await action<{ ok: true; client: string | null }>("POST", "/indexeurs/envoyer", { guid: r.guid, indexerId: r.indexerId });
      note(r.guid, { succes: res.client ? `Envoyé à ${res.client}` : "Envoyé au client de téléchargement de Prowlarr" });
    } catch (e) {
      note(r.guid, { echec: e instanceof Error ? e.message : "Envoi impossible" });
    }
  }

  return (
    <>
      <form
        className="ajout-ligne"
        onSubmit={(e) => {
          e.preventDefault();
          setTerme(saisie.trim());
        }}
      >
        <label className="recherche">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input aria-label="Rechercher sur tous les indexeurs" placeholder="Rechercher sur les indexeurs…" value={saisie} onChange={(e) => setSaisie(e.target.value)} />
        </label>
        <button type="submit" className="rond plein" aria-label="Chercher" disabled={saisie.trim().length < 2}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14m-5-5l5 5-5 5" />
          </svg>
        </button>
      </form>
      <p className="muted">
        Compare les indexeurs, puis envoie un résultat au client de téléchargement configuré dans Prowlarr (avec confirmation). Les langues sont
        déduites du nom de la release.
      </p>
      {terme.length >= 2 && chargement && <Message>Recherche en cours chez les indexeurs… cela peut prendre une minute.</Message>}
      {erreur && <Message erreur>{erreur}</Message>}
      {data && <FiltresRecherche pool={tous} filtres={filtres} onChange={setFiltres} tri={tri} onTri={setTri} />}
      {data && (
        <span className="muted" aria-live="polite">
          {items.length} résultat{items.length > 1 ? "s" : ""}
        </span>
      )}
      {data && items.length === 0 && <Message>{tous.length === 0 ? `Aucun résultat pour « ${terme} ».` : "Aucun résultat avec ces filtres."}</Message>}
      {items.map((r) => (
        <CarteRelease
          key={`${r.indexeur}-${r.guid}`}
          r={r}
          fichierQualite={null}
          etat={etats[r.guid] ?? {}}
          onTelecharger={setAConfirmer}
          envoiImpossible={sansEnvoi.has(r.guid) ? "Envoi impossible : ce résultat n'a pas d'identifiant sûr." : undefined}
        />
      ))}
      {aConfirmer && <ConfirmerTelechargement r={aConfirmer} fichierQualite={null} occupe={false} onConfirmer={() => envoyer(aConfirmer)} onAnnuler={() => setAConfirmer(null)} />}
    </>
  );
}

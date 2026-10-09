import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLE_MASQUER_REJETEES, classeSeeders, ecrireMasquerRejetees, lireMasquerRejetees, messageToutRejete,
  raisonLaPlusFrequente, texteSeeders, trier,
} from "./releasesLogique";
import type { Release } from "./api";

/** Une release minimale : seuls les champs utiles aux fonctions testées sont renseignés. */
function r(titre: string, o: Partial<Release> = {}): Release {
  return {
    guid: titre, indexerId: 1, titre, indexeur: "T", protocole: "torrent", qualite: "WEBDL-1080p", rang: 10805, groupe: null,
    dejaTelecharge: false, miseANiveau: false, inferieure: false, meilleurChoix: false, tailleOctets: 4e9, seeders: 10, leechers: 1,
    ageMinutes: 600, langues: [], score: null, rejete: false, raisons: [], telechargeable: true, ...o,
  };
}

const ACCEPTEE = r("acceptee", { seeders: 735, leechers: 850, tailleOctets: 8e9, ageMinutes: 300 });
const REJETEE = r("rejetee", { seeders: 900, rejete: true, raisons: ["Qualité non souhaitée dans le profil"], rang: 4805 });
const USENET = r("usenet", { protocole: "usenet", seeders: null, leechers: null, tailleOctets: 7e9, ageMinutes: 2880, rang: 21607 });
const ZERO = r("zero", { seeders: 0, leechers: 3, tailleOctets: 12e9, ageMinutes: 60 });

test("couleur des seeders : ≥ 50 vert, 5–49 orange, 1–4 rouge, 0 rouge vif", () => {
  assert.equal(classeSeeders(735), "vert");
  assert.equal(classeSeeders(50), "vert");
  assert.equal(classeSeeders(49), "orange");
  assert.equal(classeSeeders(5), "orange");
  assert.equal(classeSeeders(4), "rouge");
  assert.equal(classeSeeders(1), "rouge");
  assert.equal(classeSeeders(0), "rouge-vif");
});

test("texte du badge : « ▲ 735 », et « Aucun seed » quand il n'y en a aucun", () => {
  assert.equal(texteSeeders(735), "▲ 735");
  assert.equal(texteSeeders(1), "▲ 1");
  assert.equal(texteSeeders(0), "Aucun seed");
});

test("tri par défaut (seeders) : acceptées d'abord, puis seeders décroissants — les rejetées ferment la marche même avec beaucoup de seeders", () => {
  const liste = trier([ZERO, REJETEE, r("peu", { seeders: 3 }), ACCEPTEE, r("moyen", { seeders: 20 })], "seeders");
  assert.deepEqual(liste.map((x) => x.titre), ["acceptee", "moyen", "peu", "zero", "rejetee"]);
});

test("Usenet (sans seeders) : rangé entre les torrents corrects et les torrents presque morts, jamais avec les « 0 seed »", () => {
  const liste = trier([ZERO, USENET, r("bon", { seeders: 30 }), r("mort", { seeders: 2 })], "seeders");
  assert.deepEqual(liste.map((x) => x.titre), ["bon", "usenet", "mort", "zero"]);
});

test("tri par taille, âge (récentes d'abord) et qualité : acceptées toujours avant les rejetées", () => {
  const tout = [ACCEPTEE, REJETEE, USENET, ZERO];
  assert.deepEqual(trier(tout, "taille").map((x) => x.titre), ["zero", "acceptee", "usenet", "rejetee"]);
  assert.deepEqual(trier(tout, "age").map((x) => x.titre), ["zero", "acceptee", "usenet", "rejetee"]);
  assert.deepEqual(trier(tout, "qualite").map((x) => x.titre), ["usenet", "acceptee", "zero", "rejetee"]);
});

test("trier ne modifie pas la liste d'origine", () => {
  const origine = [ZERO, ACCEPTEE];
  trier(origine, "seeders");
  assert.deepEqual(origine.map((x) => x.titre), ["zero", "acceptee"]);
});

test("raison de rejet la plus fréquente (la première en cas d'égalité)", () => {
  const a = r("a", { rejete: true, raisons: ["Le fichier actuel atteint déjà la qualité souhaitée", "Qualité non souhaitée dans le profil"] });
  const b = r("b", { rejete: true, raisons: ["Le fichier actuel atteint déjà la qualité souhaitée"] });
  const c = r("c", { rejete: true, raisons: ["Pas assez de pairs"] });
  assert.deepEqual(raisonLaPlusFrequente([a, b, c]), { raison: "Le fichier actuel atteint déjà la qualité souhaitée", n: 2 });
  assert.deepEqual(raisonLaPlusFrequente([c, REJETEE]), { raison: "Pas assez de pairs", n: 1 });
  assert.equal(raisonLaPlusFrequente([ACCEPTEE]), null);
});

test("message « Tout est rejeté » : seulement si TOUT est rejeté, avec la raison la plus fréquente", () => {
  const a = r("a", { rejete: true, raisons: ["Le fichier actuel atteint déjà la qualité souhaitée"] });
  const b = r("b", { rejete: true, raisons: ["Le fichier actuel atteint déjà la qualité souhaitée"] });
  assert.equal(messageToutRejete([a, b]), "Tout est rejeté : le fichier actuel atteint déjà la qualité souhaitée.");
  assert.equal(messageToutRejete([a, ACCEPTEE]), null, "une acceptée suffit à ne pas afficher le message");
  assert.equal(messageToutRejete([]), null, "aucun résultat : c'est un autre message");
  assert.equal(messageToutRejete([r("x", { rejete: true })]), "Tout est rejeté par le service.", "rejetée sans raison connue");
});

test("« Masquer les rejetés » : coché par défaut, décoché puis mémorisé, stockage inaccessible → coché", () => {
  const memoire = new Map<string, string>();
  const stockage = { getItem: (k: string) => memoire.get(k) ?? null, setItem: (k: string, v: string) => void memoire.set(k, v) };
  assert.equal(lireMasquerRejetees(stockage), true, "rien de mémorisé : coché");
  assert.equal(lireMasquerRejetees(undefined), true);
  ecrireMasquerRejetees(stockage, false);
  assert.equal(memoire.get(CLE_MASQUER_REJETEES), "0");
  assert.equal(lireMasquerRejetees(stockage), false, "le choix est retrouvé à la prochaine ouverture");
  ecrireMasquerRejetees(stockage, true);
  assert.equal(lireMasquerRejetees(stockage), true);
  const casse = { getItem: () => { throw new Error("accès refusé"); }, setItem: () => { throw new Error("accès refusé"); } };
  assert.equal(lireMasquerRejetees(casse), true);
  assert.doesNotThrow(() => ecrireMasquerRejetees(casse, false));
});

// ---------- filtres de la recherche interactive ----------
import {
  comptesIndexeurs, FILTRES_REL_VIDES, filtrerReleases, languesPresentes, libelleResolution, nbFiltresReleases, resolutionsPresentes,
} from "./releasesLogique";

const POOL = [
  r("a", { indexeur: "NZBgeek", protocole: "usenet", seeders: null, leechers: null, langues: ["French", "English"], resolution: 1080, score: 50 }),
  r("b", { indexeur: "YGG", langues: ["French"], resolution: 2160, seeders: 80, score: 10 }),
  r("c", { indexeur: "YGG", langues: ["English"], resolution: 1080, seeders: 2, score: 200 }),
  r("d", { indexeur: "Nyaa", langues: [], resolution: null, seeders: 0 }),
];
const noms = (l: Release[]) => l.map((x) => x.titre);

test("filtres : langue (multi, OU), indexeur, résolution, protocole ; groupes différents = ET", () => {
  const f = (o: Partial<typeof FILTRES_REL_VIDES>) => noms(filtrerReleases(POOL, { ...FILTRES_REL_VIDES, ...o }));
  assert.deepEqual(f({}), ["a", "b", "c", "d"]);
  assert.deepEqual(f({ langues: ["French"] }), ["a", "b"]);
  assert.deepEqual(f({ langues: ["French", "English"] }), ["a", "b", "c"]);
  assert.deepEqual(f({ indexeurs: ["YGG"] }), ["b", "c"]);
  assert.deepEqual(f({ indexeurs: ["YGG", "Nyaa"] }), ["b", "c", "d"]);
  assert.deepEqual(f({ resolutions: [1080] }), ["a", "c"]);
  assert.deepEqual(f({ resolutions: [0] }), ["d"], "résolution inconnue = « Autre »");
  assert.deepEqual(f({ protocoles: ["usenet"] }), ["a"]);
  assert.deepEqual(f({ langues: ["English"], indexeurs: ["YGG"], resolutions: [1080] }), ["c"]);
});

test("seeders minimum : écarte les torrents trop faibles, jamais l'Usenet", () => {
  const f = (n: number) => noms(filtrerReleases(POOL, { ...FILTRES_REL_VIDES, seedersMin: n }));
  assert.deepEqual(f(5), ["a", "b"]);
  assert.deepEqual(f(1), ["a", "b", "c"]);
  assert.deepEqual(f(100), ["a"]);
});

test("compteurs : résultats par indexeur, langues, résolutions (4K d'abord, inconnue en dernier), nombre de filtres", () => {
  assert.deepEqual(comptesIndexeurs(POOL), [{ nom: "YGG", n: 2 }, { nom: "Nyaa", n: 1 }, { nom: "NZBgeek", n: 1 }]);
  assert.deepEqual(languesPresentes(POOL), ["English", "French"]);
  assert.deepEqual(resolutionsPresentes(POOL), [2160, 1080, 0]);
  assert.equal(libelleResolution(2160), "4K · 2160p");
  assert.equal(libelleResolution(720), "720p");
  assert.equal(libelleResolution(0), "Autre");
  assert.equal(nbFiltresReleases(FILTRES_REL_VIDES), 0);
  assert.equal(nbFiltresReleases({ ...FILTRES_REL_VIDES, langues: ["French"], seedersMin: 5, protocoles: ["torrent"] }), 3);
});

test("tri par score : le plus haut d'abord, les rejetées toujours après", () => {
  const rej = r("r", { score: 999, rejete: true });
  assert.deepEqual(noms(trier([...POOL, rej], "score")), ["c", "a", "b", "d", "r"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLE_QBIT, compterGroupes, construireArbre, contientMagnet, ecrireReglageQbit, FILTRES_QBIT_VIDES, filtrerTorrents, groupeDe, koVersOctets,
  lireReglageQbit, nbFiltresQbit, nettoyerReglageQbit, octetsVersKo, trierTorrents, type TorrentApp,
} from "./qbitLogique";

const base: TorrentApp = {
  hash: "a".repeat(40), nom: "X", etat: { code: "actif", libelle: "Téléchargement", attention: false, brut: "downloading" }, progression: 0.5, vitesse: 0,
  vitesseEnvoi: 0, resteSec: null, tailleOctets: 0, telechargesOctets: 0, televersesOctets: 0, ratio: 0, categorie: "", etiquettes: [], tracker: "",
  ajouteLe: null, termineLe: null, chemin: "/d", priorite: 0, sequentiel: false, premierDernier: false, forcer: false, limiteDl: 0, limiteUp: 0,
  seeds: 0, seedsTotal: 0, pairs: 0, pairsTotal: 0,
};
const t = (nom: string, brut: string, o: Partial<TorrentApp> = {}): TorrentApp => ({ ...base, nom, hash: nom.padEnd(40, "0"), etat: { ...base.etat, brut }, ...o });

const LISTE = [
  t("Film A", "downloading", { progression: 0.3, vitesse: 5e6, categorie: "Films", etiquettes: ["hd"], tracker: "ygg", tailleOctets: 8e9, ratio: 0.1, resteSec: 600, ajouteLe: "2026-10-01T00:00:00Z" }),
  t("Série B", "pausedDL", { progression: 0.6, categorie: "Séries", etiquettes: ["vu", "hd"], tracker: "nyaa", tailleOctets: 3e9, ajouteLe: "2026-10-05T00:00:00Z" }),
  t("Film C", "stalledDL", { progression: 0.1, categorie: "Films", tracker: "ygg", tailleOctets: 1e9, ajouteLe: "2026-09-20T00:00:00Z" }),
  t("Docu D", "uploading", { progression: 1, vitesseEnvoi: 1e5, ratio: 2.5, tailleOctets: 2e9, ajouteLe: "2026-10-07T00:00:00Z" }),
  t("Docu E", "stoppedUP", { progression: 1, ratio: 1.2, tailleOctets: 4e9 }),
  t("Cassé F", "missingFiles", { progression: 0.9, categorie: "Films", tailleOctets: 5e9 }),
  t("Attente G", "queuedDL", { progression: 0 }),
  t("Verif H", "checkingResumeData", { progression: 0 }),
  t("Fini I", "stalledUP", { progression: 1 }),
];
const noms = (l: TorrentApp[]) => l.map((x) => x.nom);

test("groupes d'état : en cours, pause, attente, terminé, bloqué, erreur — un seul par torrent, compteurs justes", () => {
  const g = Object.fromEntries(LISTE.map((x) => [x.nom, groupeDe(x)]));
  assert.deepEqual(g, {
    "Film A": "en-cours", "Série B": "pause", "Film C": "bloque", "Docu D": "termine", "Docu E": "pause", "Cassé F": "erreur",
    "Attente G": "attente", "Verif H": "attente", "Fini I": "termine",
  });
  assert.deepEqual(compterGroupes(LISTE), { tous: 9, "en-cours": 1, pause: 2, attente: 2, termine: 2, bloque: 1, erreur: 1 });
  assert.equal(groupeDe(t("x", "pausedUP", { progression: 1 })), "pause");
  assert.equal(groupeDe(t("x", "forcedDL")), "en-cours");
  assert.equal(groupeDe(t("x", "inconnu", { progression: 1 })), "termine");
  assert.equal(groupeDe(t("x", "inconnu", { progression: 0.2 })), "attente");
});

test("filtres : recherche sans accent ni casse, état, catégorie (dont « sans »), étiquette, tracker ; OU dans un groupe, ET entre groupes", () => {
  const f = (o: Partial<typeof FILTRES_QBIT_VIDES>) => noms(filtrerTorrents(LISTE, { ...FILTRES_QBIT_VIDES, ...o }));
  assert.equal(f({}).length, 9);
  assert.deepEqual(f({ recherche: "serie" }), ["Série B"]);
  assert.deepEqual(f({ recherche: " DOCU " }), ["Docu D", "Docu E"]);
  assert.deepEqual(f({ groupes: ["en-cours", "bloque"] }), ["Film A", "Film C"]);
  assert.deepEqual(f({ categories: ["Films"] }), ["Film A", "Film C", "Cassé F"]);
  assert.deepEqual(f({ categories: [""] }).length, 5, "sans catégorie");
  assert.deepEqual(f({ etiquettes: ["hd"] }), ["Film A", "Série B"]);
  assert.deepEqual(f({ etiquettes: ["vu", "absent"] }), ["Série B"]);
  assert.deepEqual(f({ trackers: ["ygg"] }), ["Film A", "Film C"]);
  assert.deepEqual(f({ categories: ["Films"], groupes: ["erreur", "bloque"], trackers: ["ygg"] }), ["Film C"]);
  assert.equal(nbFiltresQbit({ ...FILTRES_QBIT_VIDES, recherche: "x", groupes: ["pause"], etiquettes: ["a"] }), 2);
});

test("tri : nom, progression, vitesse, taille, ratio, date d'ajout, temps restant ; sens inversé ; valeurs absentes toujours à la fin", () => {
  const s = (cle: Parameters<typeof trierTorrents>[1]["cle"], desc = false) => noms(trierTorrents(LISTE, { cle, desc }));
  assert.deepEqual(s("nom").slice(0, 3), ["Attente G", "Cassé F", "Docu D"]);
  assert.deepEqual(s("nom", true).slice(0, 2), ["Verif H", "Série B"]);
  assert.deepEqual(s("progression", true).slice(0, 3), ["Docu D", "Docu E", "Fini I"]);
  assert.deepEqual(s("vitesse", true).slice(0, 2), ["Film A", "Docu D"]);
  assert.deepEqual(s("taille", true).slice(0, 3), ["Film A", "Cassé F", "Docu E"]);
  assert.deepEqual(s("ratio", true).slice(0, 2), ["Docu D", "Docu E"]);
  assert.deepEqual(s("ajout", true).slice(0, 4), ["Docu D", "Série B", "Film A", "Film C"]);
  assert.deepEqual(s("ajout", false).slice(0, 2), ["Film C", "Film A"]);
  assert.equal(s("eta")[0], "Film A");
  assert.deepEqual(s("eta", true)[0], "Film A", "un seul a un temps restant : en tête dans les deux sens");
  assert.equal(s("ajout", true).at(-1) !== "Docu D", true);
});

test("fichiers : arborescence, taille, progression et priorité agrégées par dossier", () => {
  const arbre = construireArbre([
    { index: 0, nom: "Serie/Saison 1/ep1.mkv", tailleOctets: 100, progression: 1, priorite: 1 },
    { index: 1, nom: "Serie/Saison 1/ep2.mkv", tailleOctets: 300, progression: 0, priorite: 0 },
    { index: 2, nom: "Serie/info.nfo", tailleOctets: 1, progression: 1, priorite: 1 },
    { index: 3, nom: "seul.txt", tailleOctets: 5, progression: 0.5, priorite: 6 },
  ]);
  assert.deepEqual(arbre.map((n) => [n.nom, n.dossier]), [["Serie", true], ["seul.txt", false]]);
  const serie = arbre[0];
  assert.deepEqual(serie.enfants.map((n) => n.nom), ["Saison 1", "info.nfo"], "dossiers d'abord");
  assert.equal(serie.tailleOctets, 401);
  assert.deepEqual(serie.indices, [0, 1, 2]);
  assert.equal(serie.priorite, null, "priorités différentes");
  const saison = serie.enfants[0];
  assert.equal(Math.round(saison.progression * 100), 25);
  assert.equal(saison.priorite, null);
  assert.equal(saison.enfants[1].priorite, 0);
  assert.equal(construireArbre([{ index: 0, nom: "d/a", tailleOctets: 1, progression: 0, priorite: 1 }, { index: 1, nom: "d/b", tailleOctets: 1, progression: 0, priorite: 1 }])[0].priorite, 1);
});

test("saisies : magnet dans le presse-papiers, limites en Ko/s", () => {
  assert.equal(contientMagnet("magnet:?xt=urn:btih:" + "a".repeat(40) + "&dn=x"), true);
  assert.equal(contientMagnet("regarde ça magnet:?xt=urn:btih:" + "A".repeat(32)), true);
  assert.equal(contientMagnet("https://exemple.test/x.torrent"), false);
  assert.equal(contientMagnet("magnet:?dn=sans"), false);
  assert.equal(koVersOctets("500"), 512000);
  assert.equal(koVersOctets("1,5"), 1536);
  assert.equal(koVersOctets(""), 0);
  assert.equal(koVersOctets("0"), 0);
  assert.equal(koVersOctets("-3"), null);
  assert.equal(koVersOctets("abc"), null);
  assert.equal(octetsVersKo(512000), "500");
  assert.equal(octetsVersKo(0), "");
});

test("mémorisation : relue, valeurs invalides remplacées par les défauts", () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const r = { filtres: { ...FILTRES_QBIT_VIDES, groupes: ["pause" as const], etiquettes: ["hd"], recherche: "x" }, tri: { cle: "ratio" as const, desc: false } };
  ecrireReglageQbit(st, r);
  assert.deepEqual(lireReglageQbit(st), r);
  m.set(CLE_QBIT, "{cassé");
  assert.deepEqual(lireReglageQbit(st).tri, { cle: "ajout", desc: true });
  const n = nettoyerReglageQbit({ filtres: { groupes: ["pause", "bidon", 4], trackers: "x" }, tri: { cle: "zzz", desc: "non" } });
  assert.deepEqual(n.filtres.groupes, ["pause"]);
  assert.deepEqual(n.filtres.trackers, []);
  assert.deepEqual(n.tri, { cle: "ajout", desc: true });
  assert.deepEqual(lireReglageQbit(undefined).filtres, FILTRES_QBIT_VIDES);
});

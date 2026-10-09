import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResumeMedia } from "./api";
import {
  CLE_BIBLIO, ecrireReglage, FILTRES_VIDES, filtrer, lireReglage, nbFiltresActifs, nettoyerReglage, optionsDe, trier,
} from "./bibliothequeLogique";

const base: ResumeMedia = {
  id: 1, type: "film", titre: "X", annee: 2000, affiche: null, etat: "complet", progression: null, suivi: true, synopsis: "",
  genres: [], dureeMin: null, qualite: null, ajoute: null, tailleOctets: 0, noteValeur: null, studio: null, statut: "sorti",
  sortie: null, profil: null, langue: null,
};
const m = (o: Partial<ResumeMedia>): ResumeMedia => ({ ...base, ...o });

const BIBLIO: ResumeMedia[] = [
  m({ id: 1, titre: "Delta", annee: 2021, genres: ["Science-fiction", "Aventure"], profil: "Ultra-HD", langue: "Anglais", studio: "Legendary", tailleOctets: 50e9, noteValeur: 8, ajoute: "2024-01-10T00:00:00Z", sortie: "2021-10-22T00:00:00Z" }),
  m({ id: 2, titre: "Éternels", annee: 2021, etat: "manquant", suivi: false, genres: ["Action"], profil: "HD-1080p", langue: "Anglais", studio: "Marvel", ajoute: "2025-03-01T00:00:00Z" }),
  m({ id: 3, titre: "Aube 3", annee: 2026, etat: "manquant", statut: "avenir", genres: ["Science-fiction"], profil: "HD-1080p", noteValeur: 7.1, tailleOctets: 0 }),
  m({ id: 4, type: "serie", titre: "Sillage", annee: 2022, etat: "partiel", progression: 60, statut: "enCours", genres: ["Drame", "Science-fiction"], studio: "Apple TV+", langue: "Anglais", noteValeur: 8.7, tailleOctets: 30e9, ajoute: "2023-05-05T00:00:00Z", sortie: "2026-10-15T00:00:00Z" }),
  m({ id: 5, type: "serie", titre: "Brume", annee: 2008, statut: "termine", genres: ["Drame"], studio: "AMC", noteValeur: 9.5, tailleOctets: 200e9, ajoute: "2020-01-01T00:00:00Z", sortie: "2013-09-29T00:00:00Z" }),
];
const titres = (l: ResumeMedia[]) => l.map((x) => x.titre);

test("recherche : insensible aux accents et à la casse", () => {
  assert.deepEqual(titres(filtrer(BIBLIO, { ...FILTRES_VIDES, recherche: "eternels" })), ["Éternels"]);
  assert.deepEqual(titres(filtrer(BIBLIO, { ...FILTRES_VIDES, recherche: "  SILL " })), ["Sillage"]);
  assert.equal(filtrer(BIBLIO, FILTRES_VIDES).length, 5);
});

test("statut : complet / manquant / à venir / en cours / terminée, plusieurs choix = OU", () => {
  const s = (statuts: Parameters<typeof filtrer>[1]["statuts"]) => titres(filtrer(BIBLIO, { ...FILTRES_VIDES, statuts }));
  assert.deepEqual(s(["complet"]), ["Delta", "Brume"]);
  assert.deepEqual(s(["manquant"]), ["Éternels", "Aube 3"]);
  assert.deepEqual(s(["avenir"]), ["Aube 3"]);
  assert.deepEqual(s(["enCours"]), ["Sillage"]);
  assert.deepEqual(s(["termine"]), ["Brume"]);
  assert.deepEqual(s(["partiel", "termine"]), ["Sillage", "Brume"]);
});

test("groupes différents = ET ; surveillé, service, genre, décennie, profil, langue, studio", () => {
  const f = (o: Partial<typeof FILTRES_VIDES>) => titres(filtrer(BIBLIO, { ...FILTRES_VIDES, ...o }));
  assert.deepEqual(f({ suivi: "non" }), ["Éternels"]);
  assert.deepEqual(f({ suivi: "oui" }).length, 4);
  assert.deepEqual(f({ services: ["Sonarr"] }), ["Sillage", "Brume"]);
  assert.deepEqual(f({ types: ["film"], genres: ["Science-fiction"] }), ["Delta", "Aube 3"]);
  assert.deepEqual(f({ genres: ["Action", "Drame"] }), ["Éternels", "Sillage", "Brume"]);
  assert.deepEqual(f({ decennies: [2020] }), ["Delta", "Éternels", "Aube 3", "Sillage"]);
  assert.deepEqual(f({ decennies: [2000] }), ["Brume"]);
  assert.deepEqual(f({ profils: ["HD-1080p"], statuts: ["manquant"] }), ["Éternels", "Aube 3"]);
  assert.deepEqual(f({ langues: ["Anglais"], types: ["serie"] }), ["Sillage"]);
  assert.deepEqual(f({ studios: ["Marvel", "AMC"] }), ["Éternels", "Brume"]);
});

test("compteur de filtres actifs : un par groupe, la recherche n'est pas comptée", () => {
  assert.equal(nbFiltresActifs(FILTRES_VIDES), 0);
  assert.equal(nbFiltresActifs({ ...FILTRES_VIDES, recherche: "x" }), 0);
  assert.equal(nbFiltresActifs({ ...FILTRES_VIDES, genres: ["a", "b"], suivi: "oui", statuts: ["complet"] }), 3);
});

test("tri : titre, année, ajout, sortie, taille, note ; sens inversé ; les valeurs absentes restent à la fin", () => {
  const t = (cle: Parameters<typeof trier>[1]["cle"], desc = false) => titres(trier(BIBLIO, { cle, desc }));
  assert.deepEqual(t("titre"), ["Aube 3", "Brume", "Delta", "Éternels", "Sillage"]);
  assert.deepEqual(t("titre", true), ["Sillage", "Éternels", "Delta", "Brume", "Aube 3"]);
  assert.deepEqual(t("annee").slice(0, 2), ["Brume", "Delta"]);
  assert.deepEqual(t("ajout", true), ["Éternels", "Delta", "Sillage", "Brume", "Aube 3"]);
  assert.deepEqual(t("taille", true), ["Brume", "Delta", "Sillage", "Aube 3", "Éternels"].map((x) => x));
  assert.deepEqual(t("note", true), ["Brume", "Sillage", "Delta", "Aube 3", "Éternels"]);
  assert.deepEqual(t("note", false).at(-1), "Éternels", "sans note : toujours à la fin");
  assert.deepEqual(t("sortie", true), ["Sillage", "Delta", "Brume", "Aube 3", "Éternels"]);
});

test("options du menu : seulement ce qui existe, décennies de la plus récente à la plus ancienne", () => {
  const o = optionsDe(BIBLIO);
  assert.deepEqual(o.genres, ["Action", "Aventure", "Drame", "Science-fiction"]);
  assert.deepEqual(o.decennies, [2020, 2000]);
  assert.deepEqual(o.profils, ["HD-1080p", "Ultra-HD"]);
  assert.deepEqual(o.langues, ["Anglais"]);
});

test("performance : 3000 titres filtrés et triés en moins de 300 ms", () => {
  const gros = Array.from({ length: 3000 }, (_, i) => m({ id: i, titre: `Titre ${i}`, annee: 1950 + (i % 75), genres: [`G${i % 20}`], noteValeur: i % 10 }));
  const t0 = Date.now();
  const r = trier(filtrer(gros, { ...FILTRES_VIDES, genres: ["G1", "G2"], recherche: "titre" }), { cle: "note", desc: true });
  assert.equal(r.length, 300);
  assert.ok(Date.now() - t0 < 300);
});

test("mémorisation : relue telle quelle, valeurs invalides ou absentes remplacées par les défauts", () => {
  const dispo = new Map<string, string>();
  const stockage = { getItem: (k: string) => dispo.get(k) ?? null, setItem: (k: string, v: string) => void dispo.set(k, v) };
  ecrireReglage(stockage, { filtres: { ...FILTRES_VIDES, genres: ["Drame"], suivi: "oui" }, tri: { cle: "note", desc: true } });
  assert.deepEqual(lireReglage(stockage), { filtres: { ...FILTRES_VIDES, genres: ["Drame"], suivi: "oui" }, tri: { cle: "note", desc: true } });
  dispo.set(CLE_BIBLIO, "pas du json");
  assert.deepEqual(lireReglage(stockage).tri, { cle: "titre", desc: false });
  const r = nettoyerReglage({ filtres: { statuts: ["bidon", "complet"], decennies: [1, 2020], types: ["film", 3], suivi: "x" }, tri: { cle: "bidon", desc: "oui" } });
  assert.deepEqual(r.filtres.statuts, ["complet"]);
  assert.deepEqual(r.filtres.decennies, [2020]);
  assert.deepEqual(r.filtres.types, ["film"]);
  assert.equal(r.filtres.suivi, "tous");
  assert.deepEqual(r.tri, { cle: "titre", desc: false });
  assert.deepEqual(lireReglage(undefined), { filtres: FILTRES_VIDES, tri: { cle: "titre", desc: false } });
});

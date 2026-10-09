import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anneesProposees, cleCarte, CLE_DECOUVRIR, dejaPris, ecrireReglageDecouvrir, fusionner, lireReglageDecouvrir, nettoyerReglageDecouvrir,
  REGLAGE_DECOUVRIR_DEFAUT, visibles, type CarteTitre,
} from "./decouvrirLogique";

const c = (type: "film" | "serie", tmdbId: number, statut: CarteTitre["statut"] = null): CarteTitre => ({
  type, tmdbId, titre: `T${tmdbId}`, annee: 2024, note: 7, affiche: null, synopsis: "", statut,
});
const cartes = [c("film", 1, "disponible"), c("film", 2, "demande"), c("serie", 3), c("serie", 4, "partiel"), c("film", 5, "bibliotheque"), c("film", 6)];
const ids = (l: CarteTitre[]) => l.map((x) => x.tmdbId);

test("pages : la suite s'ajoute sans doublon (un film et une série de même identifiant restent distincts)", () => {
  const fusion = fusionner([c("film", 1), c("film", 2)], [c("film", 2), c("serie", 2), c("film", 3)]);
  assert.deepEqual(fusion.map(cleCarte), ["film:1", "film:2", "serie:2", "film:3"]);
});

test("filtres : Films / Séries / Tout ; « masquer ce que j'ai déjà » cache disponible, partiel et bibliothèque, pas « demandé »", () => {
  const r = REGLAGE_DECOUVRIR_DEFAUT;
  assert.deepEqual(ids(visibles(cartes, r)), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(visibles(cartes, { ...r, type: "serie" })), [3, 4]);
  assert.deepEqual(ids(visibles(cartes, { ...r, type: "film" })), [1, 2, 5, 6]);
  assert.deepEqual(ids(visibles(cartes, { ...r, masquerPossedes: true })), [2, 3, 6]);
  assert.deepEqual(ids(visibles(cartes, { ...r, type: "film", masquerPossedes: true })), [2, 6]);
});

test("titre qu'on vient de demander : statut « Demandé » tout de suite, et caché par « masquer ce que j'ai déjà » seulement s'il était possédé", () => {
  const sur = new Map<string, CarteTitre["statut"]>([["film:6", "demande"]]);
  assert.equal(visibles(cartes, REGLAGE_DECOUVRIR_DEFAUT, sur).find((x) => x.tmdbId === 6)!.statut, "demande");
  assert.equal(cartes.find((x) => x.tmdbId === 6)!.statut, null, "la liste d'origine n'est pas modifiée");
  assert.deepEqual(ids(visibles(cartes, { ...REGLAGE_DECOUVRIR_DEFAUT, masquerPossedes: true }, sur)), [2, 3, 6]);
});

test("statut : seul « aucun » est demandable (film)", () => {
  assert.equal(dejaPris(null), false);
  for (const s of ["disponible", "partiel", "demande", "bibliotheque"] as const) assert.equal(dejaPris(s), true);
});

test("années : de l'année prochaine à 31 ans en arrière", () => {
  const a = anneesProposees(2026);
  assert.equal(a[0], 2027);
  assert.equal(a.at(-1), 1996);
  assert.equal(a.length, 32);
});

test("mémorisation : relue ; genre et année n'ont de sens qu'avec Films ou Séries ; valeurs invalides ignorées", () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  ecrireReglageDecouvrir(st, { type: "serie", genre: 18, annee: 2024, masquerPossedes: true });
  assert.deepEqual(lireReglageDecouvrir(st), { type: "serie", genre: 18, annee: 2024, masquerPossedes: true });
  assert.deepEqual(nettoyerReglageDecouvrir({ type: "tout", genre: 18, annee: 2024 }), { type: "tout", genre: null, annee: null, masquerPossedes: false });
  assert.deepEqual(nettoyerReglageDecouvrir({ type: "film", genre: -3, annee: 1500, masquerPossedes: "oui" }), { type: "film", genre: null, annee: null, masquerPossedes: false });
  m.set(CLE_DECOUVRIR, "{cassé");
  assert.deepEqual(lireReglageDecouvrir(st), REGLAGE_DECOUVRIR_DEFAUT);
  assert.deepEqual(lireReglageDecouvrir(undefined), REGLAGE_DECOUVRIR_DEFAUT);
});

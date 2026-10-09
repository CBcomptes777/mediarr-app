import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemCalendrier } from "./api";
import {
  CLE_CAL, ecrireReglageCal, FILTRES_CAL_VIDES, filtrerCal, joursDeVue, jourDe, lireReglageCal, lundiDe, nettoyerReglageCal, plusJours,
  regrouperParJour, statutDe, trierCal,
} from "./calendrierLogique";

const base: ItemCalendrier = {
  type: "film", id: 1, titre: "X", sousTitre: "Sortie numérique", date: "2026-10-08", heure: false, disponible: false,
  enTelechargement: false, suivi: true, affiche: null,
};
const it = (o: Partial<ItemCalendrier>): ItemCalendrier => ({ ...base, ...o });
// Jeudi 8 octobre 2026, 15 h (heure locale du test)
const NOW = new Date(2026, 9, 8, 15, 0, 0);

test("statut : disponible, téléchargement en cours, manquant (passé sans fichier), à venir", () => {
  assert.equal(statutDe(it({ disponible: true }), NOW), "disponible");
  assert.equal(statutDe(it({ enTelechargement: true, date: "2026-10-06" }), NOW), "telechargement");
  assert.equal(statutDe(it({ date: "2026-10-07" }), NOW), "manquant");
  assert.equal(statutDe(it({ date: "2026-10-08" }), NOW), "avenir", "un film qui sort aujourd'hui n'est pas encore « manquant »");
  assert.equal(statutDe(it({ date: "2026-10-12" }), NOW), "avenir");
  // épisode : l'heure compte
  const ep = (d: Date) => it({ type: "serie", heure: true, date: d.toISOString() });
  assert.equal(statutDe(ep(new Date(2026, 9, 8, 9)), NOW), "manquant");
  assert.equal(statutDe(ep(new Date(2026, 9, 8, 21)), NOW), "avenir");
  assert.equal(statutDe(it({ disponible: true, enTelechargement: true }), NOW), "disponible");
});

test("jours : lundi de la semaine, plage de 7 jours, 30 jours, grille du mois en semaines entières", () => {
  assert.equal(lundiDe("2026-10-08"), "2026-10-05");
  assert.equal(lundiDe("2026-10-11"), "2026-10-05", "le dimanche appartient à la semaine qui finit");
  assert.equal(lundiDe("2026-10-12"), "2026-10-12");
  assert.equal(plusJours("2026-10-31", 1), "2026-11-01");
  assert.equal(plusJours("2026-03-29", 1), "2026-03-30", "changement d'heure sans décalage de jour");
  assert.deepEqual(joursDeVue("semaine", 0, "2026-10-08"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  assert.equal(joursDeVue("semaine", 1, "2026-10-08")[0], "2026-10-12");
  assert.equal(joursDeVue("semaine", -1, "2026-10-08")[0], "2026-09-28");
  const liste = joursDeVue("liste", 0, "2026-10-08");
  assert.equal(liste.length, 30);
  assert.equal(liste[0], "2026-10-08");
  assert.equal(joursDeVue("liste", 1, "2026-10-08")[0], "2026-11-07");
  const mois = joursDeVue("mois", 0, "2026-10-08");
  assert.equal(mois[0], "2026-09-28");
  assert.equal(mois.at(-1), "2026-11-01");
  assert.equal(mois.length % 7, 0);
  assert.equal(joursDeVue("mois", 1, "2026-10-08")[0], "2026-10-26"); // novembre commence un dimanche
  assert.equal(joursDeVue("mois", -9, "2026-10-08")[10], "2026-01-08"); // janvier 2026
  assert.ok(joursDeVue("mois", 0, "2026-02-15").length >= 28 && joursDeVue("mois", 0, "2026-02-15").length <= 42);
});

test("filtres : service, statut (plusieurs = OU), surveillé, effacer", () => {
  const items = [
    it({ id: 1, titre: "A", date: "2026-10-07" }), // manquant, film
    it({ id: 2, titre: "B", date: "2026-10-12", suivi: false }), // à venir, film non surveillé
    it({ id: 3, type: "serie", titre: "C", disponible: true, date: "2026-10-08T01:00:00Z", heure: true }),
    it({ id: 4, type: "serie", titre: "D", enTelechargement: true, date: "2026-10-08T01:00:00Z", heure: true }),
  ];
  const t = (f: Partial<typeof FILTRES_CAL_VIDES>) => filtrerCal(items, { ...FILTRES_CAL_VIDES, ...f }, NOW).map((x) => x.titre);
  assert.deepEqual(t({}), ["A", "B", "C", "D"]);
  assert.deepEqual(t({ types: ["serie"] }), ["C", "D"]);
  assert.deepEqual(t({ statuts: ["manquant"] }), ["A"]);
  assert.deepEqual(t({ statuts: ["avenir", "telechargement"] }), ["B", "D"]);
  assert.deepEqual(t({ suivi: "non" }), ["B"]);
  assert.deepEqual(t({ types: ["film"], statuts: ["avenir"], suivi: "oui" }), []);
});

test("tri : par date, par titre, par service ; regroupement par jour", () => {
  const items = [
    it({ id: 1, titre: "Zéro", date: "2026-10-09" }),
    it({ id: 2, type: "serie", titre: "Alpha", date: "2026-10-08T01:00:00Z", heure: true }),
    it({ id: 3, titre: "Milieu", date: "2026-10-08" }),
  ];
  assert.deepEqual(trierCal(items, "titre").map((x) => x.titre), ["Alpha", "Milieu", "Zéro"]);
  assert.deepEqual(trierCal(items, "service").map((x) => x.titre), ["Milieu", "Zéro", "Alpha"], "Radarr avant Sonarr");
  assert.deepEqual(trierCal(items, "date").map((x) => x.titre), ["Milieu", "Alpha", "Zéro"]);
  const g = regrouperParJour(items);
  assert.equal(g.get("2026-10-09")?.length, 1);
  assert.equal(jourDe(items[1]), regrouperParJour([items[1]]).keys().next().value);
});

test("mémorisation du calendrier : relue, valeurs invalides remplacées", () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  ecrireReglageCal(st, { vue: "mois", tri: "titre", filtres: { types: ["film"], statuts: ["manquant"], suivi: "oui" } });
  assert.deepEqual(lireReglageCal(st), { vue: "mois", tri: "titre", filtres: { types: ["film"], statuts: ["manquant"], suivi: "oui" } });
  m.set(CLE_CAL, "{cassé");
  assert.equal(lireReglageCal(st).vue, "semaine");
  const r = nettoyerReglageCal({ vue: "annee", tri: "x", filtres: { types: ["film", 4], statuts: ["avenir", "zzz"], suivi: "?" } });
  assert.deepEqual(r, { vue: "semaine", tri: "date", filtres: { types: ["film"], statuts: ["avenir"], suivi: "tous" } });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };

function faux(routes: Record<string, unknown>): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const corps = routes[(req.url ?? "").split("?")[0]];
    if (corps === undefined) return void res.writeHead(404).end("{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(corps));
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })),
  );
}

test("bibliothèque : champs de tri et de filtre (ajout, taille, note, studio, statut, sortie, profil, langue)", async () => {
  const radarr = await faux({
    "/api/v3/movie": [
      { id: 1, title: "Delta", year: 2021, hasFile: true, monitored: true, status: "released", added: "2024-01-10T00:00:00Z", sizeOnDisk: 5e10, studio: "Legendary", qualityProfileId: 4, originalLanguage: { name: "English" }, digitalRelease: "2021-12-01T00:00:00Z", ratings: { imdb: { value: 8, votes: 100 } } },
      { id: 2, title: "Futur", year: 2027, hasFile: false, monitored: true, status: "announced", inCinemas: "2027-05-01T00:00:00Z" },
    ],
    "/api/v3/qualityprofile": [{ id: 4, name: "Ultra-HD" }],
  });
  const sonarr = await faux({
    "/api/v3/series": [
      { id: 7, title: "Sillage", year: 2022, monitored: false, status: "continuing", added: "2023-05-05T00:00:00Z", network: "Apple TV+", nextAiring: "2026-10-15T01:00:00Z", qualityProfileId: 2, ratings: { value: 8.7, votes: 10 }, statistics: { episodeCount: 10, episodeFileCount: 6, percentOfEpisodes: 60, sizeOnDisk: 3e10 } },
    ],
    "/api/v3/qualityprofile": [{ id: 2, name: "HD-1080p" }],
  });
  const app = buildServer({ RADARR_URL: radarr.url, SONARR_URL: sonarr.url, DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const { items } = (await app.inject({ url: "/api/bibliotheque" })).json();
  const delta = items.find((i: { titre: string }) => i.titre === "Delta");
  assert.equal(delta.tailleOctets, 5e10);
  assert.equal(delta.noteValeur, 8);
  assert.equal(delta.studio, "Legendary");
  assert.equal(delta.statut, "sorti");
  assert.equal(delta.profil, "Ultra-HD");
  assert.equal(delta.langue, "English");
  assert.equal(delta.sortie, "2021-12-01T00:00:00Z");
  assert.equal(delta.ajoute, "2024-01-10T00:00:00Z");
  const futur = items.find((i: { titre: string }) => i.titre === "Futur");
  assert.equal(futur.statut, "avenir");
  assert.equal(futur.noteValeur, null);
  assert.equal(futur.profil, null);
  const sev = items.find((i: { titre: string }) => i.titre === "Sillage");
  assert.equal(sev.statut, "enCours");
  assert.equal(sev.studio, "Apple TV+");
  assert.equal(sev.tailleOctets, 3e10);
  assert.equal(sev.noteValeur, 8.7);
  assert.equal(sev.profil, "HD-1080p");
  assert.equal(sev.sortie, "2026-10-15T01:00:00Z");
  radarr.close();
  sonarr.close();
});

test("bibliothèque : sans /qualityprofile, la liste reste servie (profil = null)", async () => {
  const radarr = await faux({ "/api/v3/movie": [{ id: 1, title: "Delta", qualityProfileId: 4 }] });
  const app = buildServer({ RADARR_URL: radarr.url, DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const r = (await app.inject({ url: "/api/bibliotheque" })).json();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].profil, null);
  assert.deepEqual(r.erreurs, []);
  radarr.close();
});

test("filtres enregistrés : gardés côté serveur, validés, relus après redémarrage", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "mediarr-"));
  const app = buildServer({ DATA_DIR: dossier });
  const put = (corps: unknown) => app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify(corps) });
  const r = (
    await put({
      filtresBiblio: [
        { id: "f1", nom: "  Films 4K manquants ", filtres: { types: ["film", "bidon"], statuts: ["manquant", "x"], profils: ["Ultra-HD"], decennies: [2020, 5], suivi: "oui", intrus: 1 }, tri: { cle: "note", desc: true } },
        { id: "f1", nom: "doublon", filtres: {}, tri: {} },
        { id: "pas valide!", nom: "x", filtres: {}, tri: {} },
        { id: "f2", nom: "", filtres: {}, tri: {} },
        { id: "f3", nom: "Séries en cours", filtres: { statuts: ["enCours"] }, tri: { cle: "inconnu" } },
      ],
    })
  ).json().prefs.filtresBiblio;
  assert.equal(r.length, 2);
  assert.equal(r[0].nom, "Films 4K manquants");
  assert.deepEqual(r[0].filtres.types, ["film"]);
  assert.deepEqual(r[0].filtres.statuts, ["manquant"]);
  assert.deepEqual(r[0].filtres.decennies, [2020]);
  assert.equal(r[0].filtres.suivi, "oui");
  assert.equal("intrus" in r[0].filtres, false);
  assert.deepEqual(r[0].tri, { cle: "note", desc: true });
  assert.deepEqual(r[1].tri, { cle: "titre", desc: false });

  const redemarre = buildServer({ DATA_DIR: dossier });
  assert.equal((await redemarre.inject({ url: "/api/prefs" })).json().prefs.filtresBiblio.length, 2);
});

test("calendrier : épisode avec identifiants, et « téléchargement en cours » d'après la file d'attente", async () => {
  const radarr = await faux({
    "/api/v3/calendar": [
      { id: 1, title: "Delta 3", hasFile: false, monitored: true, digitalRelease: "2026-10-08T00:00:00Z" },
      { id: 2, title: "Autre", hasFile: false, monitored: true, digitalRelease: "2026-10-09T00:00:00Z" },
    ],
    "/api/v3/queue": { records: [{ movieId: 1 }] },
  });
  const sonarr = await faux({
    "/api/v3/calendar": [
      { id: 55, seriesId: 7, seasonNumber: 1, episodeNumber: 2, airDateUtc: "2026-10-08T01:00:00Z", hasFile: false, monitored: true, series: { title: "Sillage" } },
    ],
    "/api/v3/queue": { records: [{ episodeId: 55 }] },
  });
  const app = buildServer({ RADARR_URL: radarr.url, SONARR_URL: sonarr.url, DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const { items } = (await app.inject({ url: "/api/calendrier?debut=2026-10-07&jours=5" })).json();
  const delta = items.find((i: { titre: string }) => i.titre === "Delta 3");
  const autre = items.find((i: { titre: string }) => i.titre === "Autre");
  const ep = items.find((i: { titre: string }) => i.titre === "Sillage");
  assert.equal(delta.enTelechargement, true);
  assert.equal(autre.enTelechargement, false);
  assert.equal(ep.enTelechargement, true);
  assert.equal(ep.episodeId, 55);
  assert.equal(ep.saison, 1);
  assert.equal(ep.numero, 2);
  assert.equal(ep.sousTitre, "S01E02");
  radarr.close();
  sonarr.close();
});

test("calendrier : sans /queue (service qui refuse), les sorties restent servies", async () => {
  const radarr = await faux({ "/api/v3/calendar": [{ id: 1, title: "Delta 3", digitalRelease: "2026-10-08T00:00:00Z" }] });
  const app = buildServer({ RADARR_URL: radarr.url, DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const r = (await app.inject({ url: "/api/calendrier?debut=2026-10-07&jours=5" })).json();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].enTelechargement, false);
  assert.deepEqual(r.erreurs, []);
  radarr.close();
});

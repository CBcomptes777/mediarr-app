import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculer, derniersMois, genreFr } from "./stats.js";
import { buildServer } from "./server.js";

const MAINTENANT = new Date("2026-10-08T12:00:00Z");

const FILMS = [
  { id: 1, year: 2024, added: "2026-10-03T10:00:00Z", genres: ["Drama", "Action"], qualityProfileId: 1, sizeOnDisk: 1e9, hasFile: true },
  { id: 2, year: 2019, added: "2026-08-15T10:00:00Z", genres: ["Drama"], qualityProfileId: 1, hasFile: false },
  { id: 3, year: 2024, added: "2024-01-01T10:00:00Z", genres: ["Science Fiction"], qualityProfileId: 2, hasFile: false },
  { id: 4, year: 1999, genres: [], qualityProfileId: 2, hasFile: false }, // pas de date d'ajout
];
const SERIES = [
  { id: 7, year: 2025, added: "2025-12-20T10:00:00Z", genres: ["Drama", "Sci-Fi & Fantasy"], qualityProfileId: 7, statistics: { episodeCount: 10, episodeFileCount: 4, sizeOnDisk: 5e9 } },
];
const PROFILS = { radarr: new Map([[1, "HD-1080p"], [2, "Ultra-HD"]]), sonarr: new Map([[7, "HD-1080p"]]) };

test("stats : les 12 derniers mois, du plus ancien au plus récent, à cheval sur deux années", () => {
  const mois = derniersMois(MAINTENANT);
  assert.equal(mois.length, 12);
  assert.equal(mois[0], "2025-11");
  assert.equal(mois[2], "2026-01");
  assert.equal(mois[11], "2026-10");
  assert.equal(derniersMois(new Date("2026-01-31T23:00:00Z"))[0], "2025-02");
});

test("stats : genres en français, décennies, profils par nom, vue d'ensemble et stockage", () => {
  const s = calculer(FILMS, SERIES, PROFILS, MAINTENANT);
  assert.deepEqual(s.genres, [
    { nom: "Drame", total: 3 },
    { nom: "Action", total: 1 },
    { nom: "Science-fiction", total: 1 },
    { nom: "Science-fiction et fantastique", total: 1 },
  ]);
  assert.deepEqual(s.decennies, [
    { decennie: 2020, total: 3, pct: 0.6 },
    { decennie: 2010, total: 1, pct: 0.2 },
    { decennie: 1990, total: 1, pct: 0.2 },
  ]);
  assert.deepEqual(s.profils, [
    { nom: "HD-1080p", total: 3, pct: 0.6 },
    { nom: "Ultra-HD", total: 2, pct: 0.4 },
  ]);
  assert.deepEqual(s.apercu, { films: { total: 4, disponibles: 1 }, series: { total: 1, episodes: 4, episodesTotal: 10 } });
  assert.deepEqual(s.stockage, { total: 6e9, parts: [{ nom: "Sonarr", octets: 5e9 }, { nom: "Radarr", octets: 1e9 }] });
  assert.equal(s.calculeA, MAINTENANT.toISOString());
});

test("stats : croissance sur 12 mois, socle = titres plus anciens ou sans date d'ajout", () => {
  const c = calculer(FILMS, SERIES, PROFILS, MAINTENANT).croissance;
  assert.equal(c.points.length, 12);
  assert.deepEqual(c.points[0], { mois: "2025-11", ajouts: 0, total: 2 }, "2 titres déjà là avant la période (un ancien, un sans date)");
  assert.deepEqual(c.points[1], { mois: "2025-12", ajouts: 1, total: 3 });
  assert.deepEqual(c.points[9], { mois: "2026-08", ajouts: 1, total: 4 });
  assert.deepEqual(c.points[11], { mois: "2026-10", ajouts: 1, total: 5 });
  assert.equal(c.ajoutsPeriode, 3);
  assert.equal(c.debut, "2025-11");
  assert.equal(c.fin, "2026-10");
  assert.ok(c.points.every((p, i) => i === 0 || p.total >= c.points[i - 1].total), "le total ne baisse jamais");
});

test("stats : un seul service configuré → l'autre est absent, pas à zéro", () => {
  const s = calculer(FILMS, null, PROFILS, MAINTENANT);
  assert.equal(s.apercu.series, null);
  assert.deepEqual(s.stockage.parts, [{ nom: "Radarr", octets: 1e9 }]);
  assert.equal(genreFr("Inconnu Exotique"), "Inconnu Exotique", "genre inconnu conservé");
  assert.equal(genreFr("  science fiction "), "Science-fiction");
});

function fakeLibrairie() {
  const vues: string[] = [];
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    vues.push(url);
    const json = (o: unknown, statut = 200) => void res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (url === "/api/v3/movie") return json(FILMS);
    if (url === "/api/v3/series") return json(SERIES);
    if (url === "/api/v3/qualityprofile") return json([{ id: 1, name: "HD-1080p" }, { id: 2, name: "Ultra-HD" }, { id: 7, name: "HD-1080p" }]);
    json({}, 404);
  });
  return new Promise<{ url: string; vues: string[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, vues, close: () => srv.close() }),
    ),
  );
}

const env = (url: string, extra: Record<string, string> = {}) => ({
  RADARR_URL: url, RADARR_API_KEY: "k", SONARR_URL: url, SONARR_API_KEY: "k", DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-st-")), ...extra,
});

test("/api/stats : calculé une fois puis gardé en cache ; « vider le cache » force un nouveau calcul", async () => {
  const f = await fakeLibrairie();
  const app = buildServer(env(f.url));
  const a = (await app.inject({ url: "/api/stats" })).json();
  assert.equal(a.apercu.films.total, 4);
  assert.equal(a.genres[0].nom, "Drame");
  assert.deepEqual(a.erreurs, []);
  const appels = () => f.vues.filter((u) => u === "/api/v3/movie").length;
  assert.equal(appels(), 1);
  const b = (await app.inject({ url: "/api/stats" })).json();
  assert.equal(b.calculeA, a.calculeA, "même calcul, relu en mémoire");
  assert.equal(appels(), 1);
  await app.inject({ method: "POST", url: "/api/cache/vider", headers: { "x-requested-with": "mediarr" } });
  await app.inject({ url: "/api/stats" });
  assert.equal(appels(), 2);
  f.close();
});

test("/api/stats : service en panne signalé, l'autre calculé ; rien de configuré → 404 ; jeton exigé", async () => {
  const f = await fakeLibrairie();
  const app = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "k", SONARR_URL: "http://127.0.0.1:1", SONARR_API_KEY: "k", DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-st-")) });
  const s = (await app.inject({ url: "/api/stats" })).json();
  assert.equal(s.apercu.films.total, 4);
  assert.equal(s.apercu.series, null);
  assert.deepEqual(s.erreurs, ["Sonarr injoignable"]);
  assert.equal((await buildServer({ DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-st-")) }).inject({ url: "/api/stats" })).statusCode, 404);
  assert.equal((await buildServer(env(f.url, { ACCESS_TOKEN: "abc" })).inject({ url: "/api/stats" })).statusCode, 401);
  f.close();
});

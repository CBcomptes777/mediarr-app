import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";

const WEB = { source: "web", resolution: 1080 };

/** Quatre releases de natures différentes : acceptée, rejetée, Usenet (pas de seeders), torrent à 0 seed. */
const RELEASES = [
  { guid: "acceptee", indexerId: 1, title: "Film.2026.1080p.WEB-DL-GRP", indexer: "Tracker A", protocol: "torrent", seeders: 735, leechers: 850, size: 8e9, ageHours: 5, quality: { quality: { name: "WEBDL-1080p", ...WEB } }, rejected: false, rejections: [] },
  { guid: "rejetee", indexerId: 2, title: "Film.2026.CAM", indexer: "Tracker B", protocol: "torrent", seeders: 900, leechers: 12, size: 1e9, ageMinutes: 90, quality: { quality: { name: "CAM", source: "cam", resolution: 480 } }, rejected: true, rejections: ["Quality for release is not wanted in profile", "Existing file meets cutoff"] },
  { guid: "usenet", indexerId: 3, title: "Film.2026.NZB", indexer: "NZB Hydra", protocol: "usenet", size: 7e9, age: 2, quality: { quality: { name: "Bluray-1080p", source: "bluray", resolution: 1080 } }, rejected: false, rejections: [] },
  { guid: "zero", indexerId: 4, title: "Film.2026.720p.HDTV", indexer: "Tracker C", protocol: "torrent", seeders: 0, leechers: 3, size: 2e9, age: 1, quality: { quality: { name: "HDTV-720p", source: "television", resolution: 720 } }, rejected: false, rejections: [] },
];

function fakeRadarr(releases: unknown[] = RELEASES) {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown, statut = 200) => void res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.headers["x-api-key"] !== "k") return json({}, 401);
    if (url.startsWith("/api/v3/release?movieId=")) return json(releases);
    if (url.startsWith("/api/v3/movie/")) return json({ id: 1, title: "Film", hasFile: false });
    json({}, 404);
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })),
  );
}

const lire = async (releases?: unknown[]) => {
  const f = await fakeRadarr(releases);
  const app = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "k", DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-rc-")) });
  const res = await app.inject({ url: "/api/releases/film/1" });
  f.close();
  return res.json();
};

test("recherche manuelle (faux Radarr) : acceptée, rejetée, Usenet et 0 seed — seeders et leechers exacts pour les badges", async () => {
  const { items } = await lire();
  const par = Object.fromEntries(items.map((i: { guid: string }) => [i.guid, i]));
  assert.equal(items.length, 4);

  assert.equal(par.acceptee.seeders, 735);
  assert.equal(par.acceptee.leechers, 850);
  assert.equal(par.acceptee.protocole, "torrent");
  assert.equal(par.acceptee.rejete, false);

  assert.equal(par.rejetee.seeders, 900, "une release rejetée garde ses seeders (c'est le client qui la range en dernier)");
  assert.equal(par.rejetee.rejete, true);
  assert.deepEqual(par.rejetee.raisons, ["Qualité non souhaitée dans le profil", "Le fichier actuel atteint déjà la qualité souhaitée"]);

  assert.equal(par.usenet.protocole, "usenet");
  assert.equal(par.usenet.seeders, null, "Usenet : pas de seeders, donc pas de badge");
  assert.equal(par.usenet.leechers, null);
  assert.equal(par.usenet.rejete, false);

  assert.equal(par.zero.seeders, 0, "0 seed reste 0 (et non null) : le badge « Aucun seed » peut s'afficher");
  assert.equal(par.zero.leechers, 3);
  assert.equal(par.zero.rejete, false);
});

test("recherche manuelle : tout est rejeté → toutes les releases portent leurs raisons (de quoi écrire « Tout est rejeté : … »)", async () => {
  const toutes = RELEASES.map((r) => ({ ...r, rejected: true, rejections: ["Existing file meets cutoff"] }));
  const { items } = await lire(toutes);
  assert.equal(items.length, 4);
  assert.ok(items.every((i: { rejete: boolean; raisons: string[] }) => i.rejete && i.raisons[0] === "Le fichier actuel atteint déjà la qualité souhaitée"));
});

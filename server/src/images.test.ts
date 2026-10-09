import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** Faux service d'images : exige la clé / le jeton, compte les requêtes. */
function fakeImages(opts: { cle?: string; jeton?: string; sansReduite?: boolean }) {
  const seen: Array<{ url: string; accept?: string }> = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", accept: req.headers.accept });
    const ok =
      (opts.cle && req.headers["x-api-key"] === opts.cle) ||
      (opts.jeton && req.headers["x-plex-token"] === opts.jeton);
    if (!ok) return void res.writeHead(401).end();
    if (opts.sansReduite && /-\d+\.jpg/.test(req.url ?? "")) return void res.writeHead(404).end();
    if (req.url?.startsWith("/MediaCover/9/"))
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    res.writeHead(200, { "content-type": "image/jpeg" }).end(PNG);
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((r) =>
    srv.listen(0, "127.0.0.1", () =>
      r({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() }),
    ),
  );
}

test("image : ajoute la clé côté serveur, met en cache, demande la version réduite", async () => {
  const f = await fakeImages({ cle: "k" });
  const app = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "k" });
  const a = await app.inject({ url: "/api/image/radarr/MediaCover/1/poster.jpg?lastWrite=5&w=250" });
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers["content-type"], "image/jpeg");
  assert.deepEqual(a.rawPayload, PNG);
  assert.ok(f.seen[0].url.startsWith("/MediaCover/1/poster-250.jpg"));
  assert.equal(f.seen.length, 1);
  await app.inject({ url: "/api/image/radarr/MediaCover/1/poster.jpg?lastWrite=5&w=250" });
  assert.equal(f.seen.length, 1, "la 2e demande vient du cache");
  f.close();
});

test("image : retombe sur l'original si la version réduite n'existe pas", async () => {
  const f = await fakeImages({ cle: "k", sansReduite: true });
  const app = buildServer({ SONARR_URL: f.url, SONARR_API_KEY: "k" });
  const a = await app.inject({ url: "/api/image/sonarr/MediaCover/3/poster.jpg?w=500" });
  assert.equal(a.statusCode, 200);
  assert.deepEqual(
    f.seen.map((s) => s.url),
    ["/MediaCover/3/poster-500.jpg", "/MediaCover/3/poster.jpg"],
  );
  f.close();
});

test("image : Plex avec le jeton côté serveur, en demandant une image", async () => {
  const f = await fakeImages({ jeton: "tok" });
  const app = buildServer({ PLEX_URL: f.url, PLEX_TOKEN: "tok" });
  const a = await app.inject({ url: "/api/image/plex/library/metadata/9/thumb/1" });
  assert.equal(a.statusCode, 200);
  assert.equal(f.seen[0].accept, "image/*");
  assert.equal(f.seen[0].url, "/library/metadata/9/thumb/1");
  f.close();
});

test("image : chemins hors images, traversée, services non prévus et réponses non image refusés", async () => {
  const f = await fakeImages({ cle: "k" });
  const app = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "k", QBIT_URL: f.url });
  for (const url of [
    "/api/image/radarr/api/v3/movie",
    "/api/image/radarr/MediaCover/../../system/status",
    "/api/image/radarr/MediaCover/%2e%2e/x",
    "/api/image/plex/library/metadata/1/thumb/1", // Plex non configuré
    "/api/image/qbittorrent/MediaCover/1/poster.jpg",
  ]) {
    assert.notEqual((await app.inject({ url })).statusCode, 200, url);
  }
  assert.equal(f.seen.length, 0, "rien n'a été demandé au service");
  const json = await app.inject({ url: "/api/image/radarr/MediaCover/9/poster.jpg" });
  assert.equal(json.statusCode, 502, "un service qui répond autre chose qu'une image est refusé");
  f.close();
});

test("image : protégée par ACCESS_TOKEN comme le reste de l'API", async () => {
  const f = await fakeImages({ cle: "k" });
  const app = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "k", ACCESS_TOKEN: "abc" });
  assert.equal((await app.inject({ url: "/api/image/radarr/MediaCover/1/poster.jpg" })).statusCode, 401);
  const ok = await app.inject({
    url: "/api/image/radarr/MediaCover/1/poster.jpg",
    headers: { authorization: "Bearer abc" },
  });
  assert.equal(ok.statusCode, 200);
  f.close();
});

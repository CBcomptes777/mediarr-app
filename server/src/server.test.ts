import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

// Faux Radarr : exige la clé API et répond comme le vrai.
function fakeRadarr(): Promise<{ url: string; close: () => void; seen: string[] }> {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.headers["x-api-key"] !== "secret-radarr") {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v3/system/status") res.end(JSON.stringify({ version: "5.0.0" }));
    else if (req.url?.startsWith("/api/v3/movie")) res.end(JSON.stringify([{ id: 1 }]));
    else res.writeHead(404).end("{}");
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => srv.close(),
        seen,
      }),
    ),
  );
}

test("santé : service joignable, version lue, service hors ligne signalé", async () => {
  const radarr = await fakeRadarr();
  const app = buildServer({
    RADARR_URL: radarr.url,
    RADARR_API_KEY: "secret-radarr",
    SONARR_URL: "http://127.0.0.1:1", // personne n'écoute
  });
  const res = await app.inject({ method: "GET", url: "/api/health" });
  const { services } = res.json();
  const r = services.find((s: { id: string }) => s.id === "radarr");
  const s = services.find((x: { id: string }) => x.id === "sonarr");
  assert.equal(r.ok, true);
  assert.equal(r.version, "5.0.0");
  assert.equal(s.ok, false);
  radarr.close();
});

test("proxy : ajoute la clé API côté serveur et relaie la requête", async () => {
  const radarr = await fakeRadarr();
  const app = buildServer({ RADARR_URL: radarr.url, RADARR_API_KEY: "secret-radarr" });
  const res = await app.inject({ method: "GET", url: "/api/proxy/radarr/movie?x=1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [{ id: 1 }]);
  assert.ok(radarr.seen.includes("GET /api/v3/movie?x=1"));
  radarr.close();
});

test("proxy : service non configuré et chemin dangereux refusés", async () => {
  const app = buildServer({});
  const a = await app.inject({ method: "GET", url: "/api/proxy/radarr/movie" });
  assert.equal(a.statusCode, 404);
  const radarr = await fakeRadarr();
  const app2 = buildServer({ RADARR_URL: radarr.url, RADARR_API_KEY: "secret-radarr" });
  const b = await app2.inject({ method: "GET", url: "/api/proxy/radarr/../../etc/passwd" });
  assert.notEqual(b.statusCode, 200);
  radarr.close();
});

test("jeton d'accès : refuse sans jeton, accepte avec", async () => {
  const app = buildServer({ ACCESS_TOKEN: "abc" });
  const no = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(no.statusCode, 401);
  const yes = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { authorization: "Bearer abc" },
  });
  assert.equal(yes.statusCode, 200);
});

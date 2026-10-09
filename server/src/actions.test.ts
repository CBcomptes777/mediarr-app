import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

const H = "a".repeat(40);
const H64 = "b".repeat(64);
const MARQUE = { "x-requested-with": "mediarr" };

interface Appel {
  method: string;
  url: string;
  body: string;
  referer?: string;
  cookie?: string;
}

/** Faux qBittorrent : se connecte, note chaque commande reçue. `v4` : stop/start n'existent pas (404). */
function fakeQbit(opts: { v4?: boolean; sansFile?: boolean } = {}) {
  const appels: Appel[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/v2/auth/login") {
        res.writeHead(200, { "set-cookie": "SID=abc; HttpOnly" }).end("Ok.");
        return;
      }
      appels.push({ method: req.method ?? "", url: req.url ?? "", body, referer: req.headers.referer, cookie: req.headers.cookie });
      if (opts.v4 && /\/torrents\/(stop|start)$/.test(req.url ?? "")) return void res.writeHead(404).end();
      if (opts.sansFile && /Prio$/.test(req.url ?? "")) return void res.writeHead(409).end("Torrent queueing must be enabled");
      res.writeHead(200).end();
    });
  });
  return new Promise<{ url: string; appels: Appel[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, appels, close: () => srv.close() }),
    ),
  );
}

const env = (url: string) => ({ QBIT_URL: url, QBIT_USER: "u", QBIT_PASS: "p" });

test("pause et reprise : commandes qBittorrent 5 (stop/start) avec session et empreinte", async () => {
  const q = await fakeQbit();
  const app = buildServer(env(q.url));
  const p = await app.inject({ method: "POST", url: `/api/activite/${H}/pause`, headers: MARQUE });
  assert.equal(p.statusCode, 200);
  assert.deepEqual(p.json(), { ok: true });
  await app.inject({ method: "POST", url: `/api/activite/${H64}/reprise`, headers: MARQUE });
  assert.deepEqual(
    q.appels.map((a) => `${a.method} ${a.url} ${a.body}`),
    [`POST /api/v2/torrents/stop hashes=${H}`, `POST /api/v2/torrents/start hashes=${H64}`],
  );
  assert.equal(q.appels[0].cookie, "SID=abc");
  assert.equal(q.appels[0].referer, q.url);
  q.close();
});

test("pause et reprise : retombe sur pause/resume avec qBittorrent 4", async () => {
  const q = await fakeQbit({ v4: true });
  const app = buildServer(env(q.url));
  assert.equal((await app.inject({ method: "POST", url: `/api/activite/${H}/pause`, headers: MARQUE })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/activite/${H}/reprise`, headers: MARQUE })).statusCode, 200);
  assert.deepEqual(
    q.appels.map((a) => a.url),
    ["/api/v2/torrents/stop", "/api/v2/torrents/pause", "/api/v2/torrents/start", "/api/v2/torrents/resume"],
  );
  q.close();
});

test("priorité : en tête / en fin de file ; file d'attente désactivée → message clair", async () => {
  const q = await fakeQbit();
  const app = buildServer(env(q.url));
  await app.inject({ method: "POST", url: `/api/activite/${H}/priorite/tete`, headers: MARQUE });
  await app.inject({ method: "POST", url: `/api/activite/${H}/priorite/fin`, headers: MARQUE });
  assert.deepEqual(q.appels.map((a) => a.url), ["/api/v2/torrents/topPrio", "/api/v2/torrents/bottomPrio"]);
  assert.equal((await app.inject({ method: "POST", url: `/api/activite/${H}/priorite/milieu`, headers: MARQUE })).statusCode, 404);
  q.close();

  const q2 = await fakeQbit({ sansFile: true });
  const app2 = buildServer(env(q2.url));
  const r = await app2.inject({ method: "POST", url: `/api/activite/${H}/priorite/tete`, headers: MARQUE });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /file d'attente/);
  q2.close();
});

test("suppression : avec ou sans les fichiers, jamais par défaut", async () => {
  const q = await fakeQbit();
  const app = buildServer(env(q.url));
  await app.inject({ method: "DELETE", url: `/api/activite/${H}`, headers: MARQUE });
  await app.inject({ method: "DELETE", url: `/api/activite/${H}?fichiers=1`, headers: MARQUE });
  await app.inject({ method: "DELETE", url: `/api/activite/${H}?fichiers=oui`, headers: MARQUE });
  assert.deepEqual(
    q.appels.map((a) => a.body),
    [`hashes=${H}&deleteFiles=false`, `hashes=${H}&deleteFiles=true`, `hashes=${H}&deleteFiles=false`],
  );
  q.close();
});

test("empreinte invalide refusée sans rien envoyer à qBittorrent", async () => {
  const q = await fakeQbit();
  const app = buildServer(env(q.url));
  for (const h of ["abc", "z".repeat(40), `${H}|${H}`, `${H}%0A`]) {
    const r = await app.inject({ method: "POST", url: `/api/activite/${h}/pause`, headers: MARQUE });
    assert.equal(r.statusCode, 400, h);
  }
  assert.equal(q.appels.length, 0);
  q.close();
});

test("sans en-tête X-Requested-With, toute requête qui modifie est refusée (autre site web)", async () => {
  const q = await fakeQbit();
  const app = buildServer(env(q.url));
  assert.equal((await app.inject({ method: "POST", url: `/api/activite/${H}/pause` })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/activite/${H}?fichiers=1` })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/proxy/qbittorrent/torrents/delete" })).statusCode, 403);
  assert.equal(q.appels.length, 0);
  // La lecture n'est pas concernée.
  assert.notEqual((await app.inject({ url: "/api/health" })).statusCode, 403);
  q.close();
});

test("actions : jeton d'accès exigé, et qBittorrent absent → 404", async () => {
  const q = await fakeQbit();
  const app = buildServer({ ...env(q.url), ACCESS_TOKEN: "abc" });
  assert.equal((await app.inject({ method: "POST", url: `/api/activite/${H}/pause`, headers: MARQUE })).statusCode, 401);
  const ok = await app.inject({
    method: "POST",
    url: `/api/activite/${H}/pause`,
    headers: { ...MARQUE, authorization: "Bearer abc" },
  });
  assert.equal(ok.statusCode, 200);
  q.close();
  const vide = buildServer({});
  assert.equal((await vide.inject({ method: "POST", url: `/api/activite/${H}/pause`, headers: MARQUE })).statusCode, 404);
});

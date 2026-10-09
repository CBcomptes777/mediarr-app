import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-"));

/** Faux Sonarr dont la recherche de releases est réglable : lente, muette, en erreur… */
function sonarr(comportement: "lent" | "muet" | "erreur500" | "ok", ms = 0) {
  const etat = { releaseRecues: 0, releaseFermees: 0 };
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/v3/release")) {
      etat.releaseRecues++;
      req.on("close", () => {
        if (!res.writableFinished) etat.releaseFermees++;
      });
      if (comportement === "muet") return; // ne répond jamais
      if (comportement === "erreur500") return void res.writeHead(500).end(JSON.stringify({ message: "Indexer error" }));
      return void setTimeout(() => res.end(JSON.stringify([{ guid: "g1", indexerId: 1, title: "Maree.Haute.S04E10.1080p", indexer: "X", protocol: "torrent", seeders: 5, quality: { quality: { name: "WEBDL-1080p", resolution: 1080 } }, rejections: [] }])), ms);
    }
    if (req.url?.startsWith("/api/v3/episode/")) return void res.end(JSON.stringify({ id: 55, hasFile: false }));
    res.writeHead(404).end("{}");
  });
  return new Promise<{ url: string; close: () => void; etat: typeof etat }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => { srv.closeAllConnections(); srv.close(); }, etat })),
  );
}

test("recherche d'épisode lente : on attend la réponse (délai propre à la recherche), durée indiquée et journalisée", async () => {
  const s = await sonarr("lent", 400);
  const logs: string[] = [];
  const app = buildServer({ SONARR_URL: s.url, DATA_DIR: dossier() }, { journal: (m) => logs.push(m), delaiRechercheMs: 5000 });
  const r = await app.inject({ url: "/api/releases/episode/55" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().items.length, 1);
  assert.ok(r.json().dureeMs >= 350, `durée ${r.json().dureeMs}`);
  assert.ok(logs.some((l) => /\[releases\] Sonarr episode 55 : 1 résultat\(s\) en 0\.\d s/.test(l)), logs.join("|"));
  s.close();
});

test("le délai ordinaire (15 s) ne s'applique pas à la recherche : 90 s par défaut, réglable et plafonné", async () => {
  const app = buildServer({ DATA_DIR: dossier() });
  assert.equal((await app.inject({ url: "/api/prefs" })).json().prefs.reglages.delaiRechercheMs, 90000);
  const put = (v: number) => app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify({ reglages: { delaiRechercheMs: v } }) });
  assert.equal((await put(120000)).json().prefs.reglages.delaiRechercheMs, 120000);
  assert.equal((await put(1000)).json().prefs.reglages.delaiRechercheMs, 15000);
  assert.equal((await put(9_999_999)).json().prefs.reglages.delaiRechercheMs, 300000);
});

test("indexeurs muets : 504 « n'ont pas répondu à temps » au bout du délai, jamais d'attente infinie", async () => {
  const s = await sonarr("muet");
  const logs: string[] = [];
  const app = buildServer({ SONARR_URL: s.url, DATA_DIR: dossier() }, { journal: (m) => logs.push(m), delaiRechercheMs: 500 });
  const debut = Date.now();
  const r = await app.inject({ url: "/api/releases/episode/55" });
  const duree = Date.now() - debut;
  assert.equal(r.statusCode, 504);
  assert.equal(r.json().code, "delai");
  assert.match(r.json().error, /Les indexeurs n'ont pas répondu à temps/);
  assert.ok(duree >= 450 && duree < 3000, `durée ${duree}`);
  assert.ok(logs.some((l) => /échec après .* \(délai dépassé\)/.test(l)));
  s.close();
});

test("Sonarr en erreur 500 : 502 expliqué (indexeur en panne), sans détail inventé", async () => {
  const s = await sonarr("erreur500");
  const app = buildServer({ SONARR_URL: s.url, DATA_DIR: dossier() }, { journal: () => {}, delaiRechercheMs: 5000 });
  const r = await app.inject({ url: "/api/releases/episode/55" });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().code, "service");
  assert.match(r.json().error, /Sonarr a répondu par une erreur \(HTTP 500\)/);
  s.close();
});

test("fermer la feuille annule la recherche chez Sonarr (la requête amont est coupée)", async () => {
  const s = await sonarr("muet");
  const logs: string[] = [];
  const app = buildServer({ SONARR_URL: s.url, DATA_DIR: dossier() }, { journal: (m) => logs.push(m), delaiRechercheMs: 30_000 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const arret = new AbortController();
  const requete = fetch(`http://127.0.0.1:${port}/api/releases/episode/55`, { signal: arret.signal, headers: { "x-requested-with": "mediarr" } }).catch((e) => e);
  for (let i = 0; i < 50 && s.etat.releaseRecues === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(s.etat.releaseRecues, 1);
  arret.abort(); // l'app ferme la feuille
  await requete;
  for (let i = 0; i < 60 && s.etat.releaseFermees === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(s.etat.releaseFermees, 1, "Sonarr a vu la connexion se fermer");
  assert.ok(logs.some((l) => /annulée par l'app/.test(l)), logs.join("|"));
  await app.close();
  s.close();
});

test("chemins de saison : même comportement (délai et annulation partagés)", async () => {
  const s = await sonarr("muet");
  const app = buildServer({ SONARR_URL: s.url, DATA_DIR: dossier() }, { journal: () => {}, delaiRechercheMs: 400 });
  const r = await app.inject({ url: "/api/releases/saison/7/2" });
  assert.equal(r.statusCode, 504);
  s.close();
});

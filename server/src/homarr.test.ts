import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

// Faux Homarr : une page web, aucune API. Redirige la racine vers /auth/login comme le vrai.
function fauxHomarr(): Promise<{ url: string; close: () => void; vus: string[] }> {
  const vus: string[] = [];
  const srv = http.createServer((req, res) => {
    vus.push(`${req.method} ${req.url} ${req.headers["x-api-key"] ?? ""}`);
    if (req.url === "/") return void res.writeHead(307, { location: "/auth/login" }).end();
    res.setHeader("content-type", "text/html");
    res.end("<html>Homarr</html>");
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), vus }),
    ),
  );
}

test("Homarr : en ligne, avec le lien à ouvrir, sans envoyer de clé", async () => {
  const homarr = await fauxHomarr();
  const app = buildServer({ HOMARR_URL: homarr.url });
  const { services } = (await app.inject({ method: "GET", url: "/api/health" })).json();
  const h = services.find((s: { id: string }) => s.id === "homarr");
  assert.equal(h.ok, true);
  assert.equal(h.label, "Homarr");
  assert.equal(h.lien, homarr.url);
  assert.equal(h.version, undefined);
  assert.ok(homarr.vus.every((v) => v.endsWith(" ")), "aucune clé envoyée à Homarr");
  homarr.close();
});

test("Homarr : hors ligne signalé, lien conservé ; HOMARR_OPEN_URL remplace le lien", async () => {
  const app = buildServer({ HOMARR_URL: "http://127.0.0.1:1", HOMARR_OPEN_URL: "https://homarr.exemple.ts.net" });
  const { services } = (await app.inject({ method: "GET", url: "/api/health" })).json();
  const h = services.find((s: { id: string }) => s.id === "homarr");
  assert.equal(h.ok, false);
  assert.equal(h.lien, "https://homarr.exemple.ts.net");
});

test("Homarr : absent si HOMARR_URL n'est pas défini ; les autres services n'ont pas de lien", async () => {
  const app = buildServer({ RADARR_URL: "http://127.0.0.1:1" });
  const { services } = (await app.inject({ method: "GET", url: "/api/health" })).json();
  assert.equal(services.find((s: { id: string }) => s.id === "homarr"), undefined);
  assert.equal(services.find((s: { id: string }) => s.id === "radarr").lien, undefined);
});

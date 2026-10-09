import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";

const TOKEN = "jeton-plex-secret-abc123";
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-px-"));

interface Vue {
  url: string;
  token?: string;
  accept?: string;
}
type Reponse = { status?: number; type?: string; corps?: string; silence?: boolean };

/**
 * Faux Plex. `/identity` répond TOUJOURS, sans jeton (comme le vrai Plex) : c'est ce qui rend Plex « En ligne » dans
 * Services même quand le jeton est mauvais. `/status/sessions` répond selon `sessions`.
 */
function fakePlex(sessions: Reponse) {
  const vues: Vue[] = [];
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/identity") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ MediaContainer: { version: "1.41.3.9314" } }));
      return;
    }
    vues.push({ url, token: req.headers["x-plex-token"] as string | undefined, accept: req.headers.accept });
    if (sessions.silence) return; // ne répond jamais (test du délai)
    res.writeHead(sessions.status ?? 200, { "content-type": sessions.type ?? "application/json" }).end(sessions.corps ?? "{}");
  });
  return new Promise<{ url: string; vues: Vue[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, vues, close: () => srv.close() }),
    ),
  );
}

const env = (url: string, extra: Record<string, string> = {}) => ({ PLEX_URL: url, PLEX_TOKEN: TOKEN, DATA_DIR: dossier(), ...extra });
const plexDe = async (app: ReturnType<typeof buildServer>) => (await app.inject({ url: "/api/accueil" })).json().plex;

const SESSION = {
  title: "Pilote", grandparentTitle: "Foundation", parentIndex: 3, index: 5,
  User: { title: "moi" }, Player: { title: "iPhone", state: "playing" }, Session: { location: "lan" }, Media: [{ videoResolution: "1080" }],
};

test("Plex : la requête des sessions porte le jeton en en-tête X-Plex-Token et Accept: application/json", async () => {
  const p = await fakePlex({ corps: '{"MediaContainer":{"size":0}}' });
  await plexDe(buildServer(env(p.url)));
  assert.equal(p.vues.length, 1);
  assert.equal(p.vues[0].url, "/status/sessions");
  assert.equal(p.vues[0].token, TOKEN);
  assert.equal(p.vues[0].accept, "application/json");
  p.close();
});

test("Plex : aucune lecture en cours (MediaContainer size 0, SANS tableau Metadata) → ok, liste vide, pas une erreur", async () => {
  const p = await fakePlex({ corps: '{"MediaContainer":{"size":0}}' });
  assert.deepEqual(await plexDe(buildServer(env(p.url))), { ok: true, lectures: [] });
  p.close();
});

test("Plex : une session en cours est lue (titre, utilisateur, appareil, lecture directe, réseau local)", async () => {
  const p = await fakePlex({ corps: JSON.stringify({ MediaContainer: { size: 1, Metadata: [SESSION] } }) });
  const plex = await plexDe(buildServer(env(p.url)));
  assert.equal(plex.ok, true);
  assert.equal(plex.lectures.length, 1);
  assert.equal(plex.lectures[0].titre, "Foundation · S03E05");
  assert.equal(plex.lectures[0].utilisateur, "moi");
  assert.equal(plex.lectures[0].transcode, false);
  assert.equal(plex.lectures[0].local, true);
  p.close();
});

test("Plex : HTTP 401 → « accès refusé » (jeton), alors que Services dit « En ligne » (/identity ne demande pas de jeton)", async () => {
  const p = await fakePlex({ status: 401, type: "text/html", corps: `<html><head><title>Unauthorized</title></head><body>Invalid token ${TOKEN}</body></html>` });
  const app = buildServer(env(p.url));
  const plex = await plexDe(app);
  assert.equal(plex.ok, false);
  assert.equal(plex.nature, "refuse");
  assert.equal(plex.error, "Plex : HTTP 401");
  assert.match(plex.detail, /^HTTP 401 — <html><head><title>Unauthorized<\/title>/);
  assert.ok(!JSON.stringify(plex).includes(TOKEN), "le jeton, même répété par Plex, est masqué");
  assert.match(plex.detail, /Invalid token \*\*\*/);
  // Le ping, lui, réussit : c'est exactement le symptôme observé.
  const sante = (await app.inject({ url: "/api/health" })).json().services.find((s: { id: string }) => s.id === "plex");
  assert.equal(sante.ok, true);
  assert.equal(sante.version, "1.41.3.9314");
  // Et l'échec est noté dans le journal (sans le jeton).
  const journal = await app.inject({ url: "/api/journal" });
  assert.ok(journal.json().items.some((i: { service: string; chemin: string; statut: number }) => i.service === "plex" && i.chemin === "/status/sessions" && i.statut === 401));
  assert.ok(!journal.body.includes(TOKEN));
  p.close();
});

test("Plex : HTTP 403 aussi → « refuse » ; jeton absent → Plex refuse, et la requête partait bien sans jeton", async () => {
  const p = await fakePlex({ status: 403, corps: "Forbidden" });
  assert.equal((await plexDe(buildServer(env(p.url)))).nature, "refuse");
  const q = await fakePlex({ status: 401, corps: "Unauthorized" });
  const plex = await plexDe(buildServer({ PLEX_URL: q.url, DATA_DIR: dossier() }));
  assert.equal(plex.nature, "refuse");
  assert.equal(q.vues[0].token, undefined, "PLEX_TOKEN non défini : aucun jeton envoyé");
  p.close(); q.close();
});

test("Plex : jeton avec espace ou retour à la ligne parasite (copier-coller) → nettoyé avant l'envoi", async () => {
  const p = await fakePlex({ corps: '{"MediaContainer":{"size":0}}' });
  await plexDe(buildServer(env(p.url, { PLEX_TOKEN: `  ${TOKEN}\n` })));
  assert.equal(p.vues[0].token, TOKEN);
  p.close();
});

test("Plex : du XML au lieu de JSON → « illisible », avec le début de la réponse (sans jeton) pour comprendre", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" X-Plex-Token="${TOKEN}" machineIdentifier="abc">` + " ".repeat(300) + "</MediaContainer>";
  const p = await fakePlex({ type: "text/xml;charset=utf-8", corps: xml });
  const plex = await plexDe(buildServer(env(p.url)));
  assert.equal(plex.ok, false);
  assert.equal(plex.nature, "illisible");
  assert.equal(plex.error, "Plex : réponse illisible");
  assert.match(plex.detail, /^HTTP 200 — <\?xml version="1\.0" encoding="UTF-8"\?> <MediaContainer size="0" X-Plex-Token="\*\*\*"/);
  assert.ok(plex.detail.length <= 220, "extrait limité à 200 caractères");
  assert.ok(!JSON.stringify(plex).includes(TOKEN));
  p.close();
});

test("Plex : JSON sans MediaContainer → « illisible » (format inattendu), pas « injoignable »", async () => {
  for (const corps of ['{"autre":1}', '{"MediaContainer":5}', "null"]) {
    const p = await fakePlex({ corps });
    const plex = await plexDe(buildServer(env(p.url)));
    assert.equal(plex.ok, false, corps);
    assert.equal(plex.nature, "illisible", corps);
    p.close();
  }
});

test("Plex : erreur serveur (500) → « http » avec le code ; Plex éteint → « reseau » avec « connexion refusée »", async () => {
  const p = await fakePlex({ status: 500, corps: "boom" });
  const plex = await plexDe(buildServer(env(p.url)));
  assert.equal(plex.nature, "http");
  assert.match(plex.detail, /^HTTP 500 — boom/);
  p.close();

  const ferme = http.createServer();
  await new Promise<void>((ok) => ferme.listen(0, "127.0.0.1", ok));
  const port = (ferme.address() as AddressInfo).port;
  await new Promise<void>((ok) => ferme.close(() => ok()));
  const eteint = await plexDe(buildServer(env(`http://127.0.0.1:${port}`)));
  assert.equal(eteint.ok, false);
  assert.equal(eteint.nature, "reseau");
  assert.equal(eteint.error, "Plex : connexion refusée");
});

test("Plex : délai dépassé (réglage minimum, 5 s) → « reseau » avec « délai dépassé »", async () => {
  const p = await fakePlex({ silence: true });
  const app = buildServer(env(p.url));
  await app.inject({ method: "PUT", url: "/api/prefs", headers: { "x-requested-with": "mediarr", "content-type": "application/json" }, payload: JSON.stringify({ reglages: { delaiHttpMs: 5000 } }) });
  const plex = await plexDe(app);
  assert.equal(plex.ok, false);
  assert.equal(plex.nature, "reseau");
  assert.equal(plex.error, "Plex : délai dépassé");
  p.close();
});

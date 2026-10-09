import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { causeIndexeur } from "./prowlarr.js";
import { buildServer } from "./server.js";

const CLE = "cle-prowlarr-secrete-xyz";
const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-pw-"));

interface Appel {
  method: string;
  url: string;
  body: any;
  cle?: string;
}
type Rep = { status?: number; json?: unknown; attente?: number; silence?: boolean } | undefined;

function fake(handler: (a: Appel) => Rep) {
  const appels: Appel[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      let body: any;
      try {
        body = brut ? JSON.parse(brut) : undefined;
      } catch {
        body = brut;
      }
      const a: Appel = { method: req.method ?? "", url: req.url ?? "", body, cle: req.headers["x-api-key"] as string | undefined };
      appels.push(a);
      const r = handler(a);
      if (!r) return void res.writeHead(404).end("{}");
      if (r.silence) return;
      setTimeout(() => res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? {})), r.attente ?? 0);
    });
  });
  return new Promise<{ url: string; appels: Appel[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, appels, close: () => srv.close() })),
  );
}

const INDEXEURS = [
  { id: 1, name: "1337x", enable: true, protocol: "torrent", priority: 25 },
  { id: 2, name: "Nyaa.si", enable: true, protocol: "torrent", priority: 25 },
  { id: 3, name: "YTS", enable: true, protocol: "torrent", priority: 30 },
  { id: 4, name: "NZBgeek", enable: true, protocol: "usenet", priority: 10 },
  { id: 5, name: "Ancien", enable: false, protocol: "torrent", priority: 50 },
];
const futur = () => new Date(Date.now() + 3 * 3600_000).toISOString();
/** Trois indexeurs en échec depuis le 5 octobre, comme chez l'utilisateur. */
const EN_ECHEC = [1, 2, 3].map((id) => ({ indexerId: id, initialFailure: "2026-10-05T10:00:00Z", mostRecentFailure: "2026-10-08T01:00:00Z", disabledTill: futur() }));

/** Faux Prowlarr complet ; `etat` règle les scénarios. */
function prowlarr(etat: { statuts?: unknown[]; sante?: unknown[]; indexeurs?: unknown[] } = {}) {
  return fake((a) => {
    if (a.cle !== CLE) return { status: 401 };
    const u = a.url;
    if (u === "/api/v1/system/status") return { json: { version: "1.30.2.4939" } };
    if (u === "/api/v1/indexer" && a.method === "GET") return { json: etat.indexeurs ?? INDEXEURS };
    const un = u.match(/^\/api\/v1\/indexer\/(\d+)$/);
    if (un && a.method === "GET") return { json: INDEXEURS.find((i) => i.id === Number(un[1])) ?? undefined, status: INDEXEURS.some((i) => i.id === Number(un[1])) ? 200 : 404 };
    if (u === "/api/v1/indexerstatus") return { json: etat.statuts ?? [] };
    if (u === "/api/v1/health") return { json: etat.sante ?? [] };
    if (u === "/api/v1/indexer/test" && a.method === "POST") {
      const id = a.body?.id;
      if (id === 1) return { status: 400, json: [{ propertyName: "", errorMessage: `Unable to connect to indexer, check the log for more details: HTTP request failed: [401:Unauthorized] [GET] at [https://1337x.to/api?apikey=${CLE}]` }] };
      if (id === 2) return { status: 400, json: [{ propertyName: "", errorMessage: "The operation has timed out." }] };
      return { json: {} };
    }
    if (u === "/api/v1/indexer/testall" && a.method === "POST") {
      return { attente: 150, json: [{ id: 1, isValid: false, validationFailures: [{ errorMessage: "Request failed: 401 Unauthorized" }] }, { id: 4, isValid: true, validationFailures: [] }] };
    }
    if (u.startsWith("/api/v1/indexerstats?"))
      return {
        json: {
          indexers: [
            { indexerId: 4, indexerName: "NZBgeek", numberOfQueries: 40, numberOfRssQueries: 10, numberOfAuthQueries: 0, numberOfGrabs: 3, numberOfFailedQueries: 0, numberOfFailedRssQueries: 0, numberOfFailedAuthQueries: 0, averageResponseTime: 820 },
            { indexerId: 1, indexerName: "1337x", numberOfQueries: 120, numberOfRssQueries: 5, numberOfAuthQueries: 2, numberOfGrabs: 9, numberOfFailedQueries: 120, numberOfFailedRssQueries: 5, numberOfFailedAuthQueries: 2, averageResponseTime: 0 },
          ],
        },
      };
    if (u.startsWith("/api/v1/search?"))
      return {
        json: [
          { guid: "g1", title: "Film.2026.1080p", size: 8e9, ageHours: 5, seeders: 735, leechers: 850, indexer: "1337x", protocol: "torrent", categories: [{ id: 2000, name: "Movies" }], downloadUrl: `http://192.168.1.10:30050/1/download?apikey=${CLE}&link=x`, infoUrl: "https://1337x.to/t/1" },
          { guid: "g2", title: "Film.2026.NZB", size: 7e9, age: 2, indexer: "NZBgeek", protocol: "usenet", downloadUrl: `http://192.168.1.10:30050/4/download?apikey=${CLE}` },
          { guid: "g3", title: "Film.2026.mort", size: 1e9, ageMinutes: 90, seeders: 0, leechers: 2, indexer: "YTS", protocol: "torrent", downloadUrl: `x?apikey=${CLE}` },
        ],
      };
    return undefined;
  });
}

const demarrer = (p: { url: string }, extra: Record<string, string> = {}) =>
  buildServer({ PROWLARR_URL: p.url, PROWLARR_API_KEY: CLE, DATA_DIR: dossier(), ...extra });

test("Prowlarr : tout est vert — indexeurs actifs, un désactivé, aucune alerte, version dans /api/health", async () => {
  const p = await prowlarr();
  const app = demarrer(p);
  const { items, alertes } = (await app.inject({ url: "/api/indexeurs" })).json();
  assert.deepEqual(items.map((i: { nom: string; statut: string }) => `${i.nom}:${i.statut}`), ["1337x:actif", "Nyaa.si:actif", "NZBgeek:actif", "YTS:actif", "Ancien:desactive"]);
  assert.deepEqual(alertes, []);
  assert.equal(items[2].protocole, "usenet");
  assert.equal(items[0].priorite, 25);
  assert.ok(items.every((i: { cause: string | null }) => i.cause === null));
  const sante = (await app.inject({ url: "/api/health" })).json().services.find((s: { id: string }) => s.id === "prowlarr");
  assert.equal(sante.ok, true);
  assert.equal(sante.version, "1.30.2.4939");
  assert.equal(sante.label, "Prowlarr");
  assert.ok(p.appels.every((a) => a.cle === CLE), "la clé part du serveur, dans l'en-tête X-Api-Key");
  p.close();
});

test("Prowlarr : 1337x, Nyaa.si et YTS en échec (401) ressortent en premier, avec le dernier échec ; la clé n'est jamais renvoyée", async () => {
  const p = await prowlarr({ statuts: EN_ECHEC, sante: [{ source: "IndexerStatusCheck", type: "warning", message: "Indexers unavailable due to failures: 1337x, Nyaa.si, YTS" }] });
  const res = await demarrer(p).inject({ url: "/api/indexeurs" });
  assert.ok(!res.body.includes(CLE));
  const { items, alertes } = res.json();
  assert.deepEqual(items.map((i: { nom: string; statut: string }) => `${i.nom}:${i.statut}`), ["1337x:echec", "Nyaa.si:echec", "YTS:echec", "NZBgeek:actif", "Ancien:desactive"]);
  const e = items[0];
  assert.equal(e.dernierEchec, "2026-10-08T01:00:00Z");
  assert.equal(e.premierEchec, "2026-10-05T10:00:00Z");
  assert.ok(e.reessaiApres, "date de réessai connue tant que l'indexeur est désactivé par Prowlarr");
  assert.equal(e.causeSource, "prowlarr");
  assert.match(e.cause, /dernier échec le 2026-10-08/);
  assert.match(e.cause, /Tester/);
  assert.deepEqual(alertes, [{ niveau: "avertissement", message: "Indexeurs indisponibles à cause d'échecs : 1337x, Nyaa.si, YTS" }]);
  p.close();
});

test("« Tester » : la fiche de l'indexeur est envoyée, la vraie cause (401) est traduite sans fuite de clé, puis conservée dans la liste", async () => {
  const p = await prowlarr({ statuts: EN_ECHEC });
  const app = demarrer(p);
  const r = await app.inject({ method: "POST", url: "/api/indexeurs/1/tester", headers: MARQUE });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes(CLE), "la clé que le message d'erreur de l'indexeur répète est masquée");
  const t = r.json();
  assert.equal(t.ok, false);
  assert.equal(t.cause, "401 Unauthorized : clé API ou identifiants refusés par l'indexeur");
  const envoye = p.appels.find((a) => a.url === "/api/v1/indexer/test")!;
  assert.deepEqual(envoye.body, INDEXEURS[0], "Prowlarr attend la fiche complète, pas seulement l'identifiant");

  const liste = (await app.inject({ url: "/api/indexeurs" })).json().items.find((i: { id: number }) => i.id === 1);
  assert.equal(liste.causeSource, "test");
  assert.equal(liste.cause, t.cause);
  assert.equal(liste.test.ok, false);

  const ok = (await app.inject({ method: "POST", url: "/api/indexeurs/4/tester", headers: MARQUE })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.cause, null);
  p.close();
});

test("« Tester » : délai dépassé de l'indexeur traduit ; indexeur inconnu → 404 ; identifiant invalide → 400", async () => {
  const p = await prowlarr({ statuts: EN_ECHEC });
  const app = demarrer(p);
  assert.equal((await app.inject({ method: "POST", url: "/api/indexeurs/2/tester", headers: MARQUE })).json().cause, "Délai dépassé : l'indexeur ne répond pas");
  assert.equal((await app.inject({ method: "POST", url: "/api/indexeurs/99/tester", headers: MARQUE })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/indexeurs/1abc/tester", headers: MARQUE })).statusCode, 400);
  p.close();
});

test("« Tout tester » : résultat par indexeur avec les noms, pas deux fois en même temps", async () => {
  const p = await prowlarr();
  const app = demarrer(p);
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/api/indexeurs/tester-tout", headers: MARQUE }),
    app.inject({ method: "POST", url: "/api/indexeurs/tester-tout", headers: MARQUE }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);
  const ok = (a.statusCode === 200 ? a : b).json();
  assert.deepEqual(ok.items.map((i: { nom: string; ok: boolean }) => `${i.nom}:${i.ok}`), ["1337x:false", "NZBgeek:true"]);
  assert.equal(ok.ok, 1);
  assert.equal(ok.echecs, 1);
  assert.match(ok.items[0].cause, /^401 Unauthorized/);
  p.close();
});

test("« Tester » et « Tout tester » sont protégés : en-tête X-Requested-With et jeton exigés", async () => {
  const p = await prowlarr();
  const app = demarrer(p, { ACCESS_TOKEN: "jeton" });
  for (const url of ["/api/indexeurs/1/tester", "/api/indexeurs/tester-tout"]) {
    assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "Bearer jeton" } })).statusCode, 403, url + " sans en-tête");
    assert.equal((await app.inject({ method: "POST", url, headers: { "x-requested-with": "mediarr" } })).statusCode, 401, url + " sans jeton");
  }
  assert.equal(p.appels.filter((a) => a.method === "POST").length, 0, "aucun test n'est parti");
  p.close();
});

test("statistiques : 7 jours, requêtes / échecs / grabs additionnés, triées par nombre de requêtes", async () => {
  const p = await prowlarr();
  const r = (await demarrer(p).inject({ url: "/api/indexeurs/stats" })).json();
  assert.equal(r.jours, 7);
  const ecart = new Date(r.fin).getTime() - new Date(r.debut).getTime();
  assert.equal(Math.round(ecart / 86_400_000), 7);
  const appel = p.appels.find((a) => a.url.startsWith("/api/v1/indexerstats?"))!;
  assert.match(appel.url, /startDate=.+&endDate=/);
  assert.deepEqual(r.items, [
    { id: 1, nom: "1337x", requetes: 127, echecs: 127, grabs: 9, tempsMoyenMs: null },
    { id: 4, nom: "NZBgeek", requetes: 50, echecs: 0, grabs: 3, tempsMoyenMs: 820 },
  ]);
  p.close();
});

test("recherche directe : seeders / leechers, Usenet sans seeders, 0 seed conservé, AUCUN lien de téléchargement ni clé", async () => {
  const p = await prowlarr();
  const app = demarrer(p);
  const res = await app.inject({ url: "/api/indexeurs/recherche?q=film%202026" });
  assert.ok(!res.body.includes(CLE) && !/apikey|download/i.test(res.body), "les adresses de téléchargement (qui contiennent la clé) sont écartées");
  const { items } = res.json();
  assert.deepEqual(items.map((i: { titre: string }) => i.titre), ["Film.2026.1080p", "Film.2026.NZB", "Film.2026.mort"]);
  assert.deepEqual([items[0].seeders, items[0].leechers, items[0].ageMinutes, items[0].categorie], [735, 850, 300, "Movies"]);
  assert.deepEqual([items[1].protocole, items[1].seeders, items[1].leechers, items[1].ageMinutes], ["usenet", null, null, 2880]);
  assert.deepEqual([items[2].seeders, items[2].leechers], [0, 2]);
  assert.equal((await app.inject({ url: "/api/indexeurs/recherche?q=a" })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/indexeurs/recherche?q=${"x".repeat(101)}` })).statusCode, 400);
  assert.ok(p.appels.find((a) => a.url.startsWith("/api/v1/search?"))!.url.includes("query=film%202026"));
  p.close();
});

test("alertes : avertissements et erreurs de santé de Prowlarr traduits, erreurs d'abord ; Prowlarr en panne → liste vide, pas d'erreur", async () => {
  const p = await prowlarr({
    sante: [
      { source: "A", type: "notice", message: "Une info" },
      { source: "IndexerLongTermStatusCheck", type: "warning", message: "Indexers unavailable due to failures for more than 6 hours: YTS" },
      { source: "B", type: "error", message: "All indexers are unavailable due to failures" },
    ],
  });
  const { items } = (await demarrer(p).inject({ url: "/api/alertes" })).json();
  assert.deepEqual(items, [
    { source: "Prowlarr", niveau: "erreur", message: "Tous les indexeurs sont indisponibles à cause d'échecs" },
    { source: "Prowlarr", niveau: "avertissement", message: "Indexeurs indisponibles depuis plus de 6 heures : YTS" },
  ]);
  p.close();
  const eteint = demarrer({ url: "http://127.0.0.1:9" });
  const r = await eteint.inject({ url: "/api/alertes" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().items, []);
});

test("Prowlarr absent (non configuré) : aucune erreur, routes en 404 explicite, pas dans les services, alertes vides", async () => {
  const app = buildServer({ DATA_DIR: dossier() });
  for (const [url, methode] of [["/api/indexeurs", "GET"], ["/api/indexeurs/stats", "GET"], ["/api/indexeurs/recherche?q=film", "GET"], ["/api/indexeurs/1/tester", "POST"], ["/api/indexeurs/tester-tout", "POST"]] as const) {
    const r = await app.inject({ method: methode, url, headers: MARQUE });
    assert.equal(r.statusCode, 404, url);
    assert.equal(r.json().error, "Prowlarr n'est pas configuré");
  }
  assert.deepEqual((await app.inject({ url: "/api/health" })).json().services, []);
  assert.deepEqual((await app.inject({ url: "/api/alertes" })).json().items, []);
  assert.equal((await app.inject({ url: "/api/accueil" })).statusCode, 200);
});

test("Prowlarr ne répond pas (délai dépassé) : 502 avec la cause, et l'incident est noté dans le journal sans la clé", async () => {
  const p = await fake(() => ({ silence: true }));
  const app = demarrer(p);
  await app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify({ reglages: { delaiHttpMs: 5000 } }) });
  const r = await app.inject({ url: "/api/indexeurs" });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, "Prowlarr : délai dépassé");
  const journal = await app.inject({ url: "/api/journal" });
  assert.ok(journal.json().items.some((i: { service: string; statut: number }) => i.service === "prowlarr" && i.statut === 0));
  assert.ok(!journal.body.includes(CLE));
  p.close();
});

test("causes d'échec d'un indexeur traduites en français", () => {
  assert.match(causeIndexeur("HTTP request failed: [401:Unauthorized]"), /^401 Unauthorized/);
  assert.match(causeIndexeur("403 Forbidden"), /^403 Forbidden/);
  assert.match(causeIndexeur("Cloudflare protection detected"), /FlareSolverr/);
  assert.match(causeIndexeur("429 Too Many Requests"), /^429/);
  assert.match(causeIndexeur("The request timed out"), /^Délai dépassé/);
  assert.match(causeIndexeur("Unable to connect to indexer"), /^Connexion impossible/);
  assert.match(causeIndexeur("502 Bad Gateway"), /^Erreur côté indexeur/);
  assert.equal(causeIndexeur("Quelque chose d'inattendu"), "Erreur : Quelque chose d'inattendu");
  assert.equal(causeIndexeur(""), "Échec sans détail");
});

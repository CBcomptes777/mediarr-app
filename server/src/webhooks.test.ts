import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memeSecret, notificationWebhook, resumerEvenement } from "./webhooks.js";
import { buildServer } from "./server.js";

const SECRET = "un-secret-webhook-assez-long";
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-wh-"));
const post = (app: ReturnType<typeof buildServer>, url: string, corps: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: typeof corps === "string" ? corps : JSON.stringify(corps) });

test("secret comparé en temps constant, longueurs différentes refusées", () => {
  assert.equal(memeSecret("abc", "abc"), true);
  assert.equal(memeSecret("abc", "abd"), false);
  assert.equal(memeSecret("abc", "abcd"), false);
  assert.equal(memeSecret("", "abc"), false);
});

test("résumé des évènements Radarr, Sonarr et Overseerr", () => {
  assert.deepEqual(resumerEvenement("radarr", { eventType: "Grab", movie: { title: "Nuit Écarlate" } }), { evenement: "Grab", titre: "Nuit Écarlate" });
  assert.deepEqual(
    resumerEvenement("sonarr", { eventType: "Download", series: { title: "La Frontière" }, episodes: [{ seasonNumber: 2, episodeNumber: 5 }] }),
    { evenement: "Download", titre: "La Frontière S02E05" },
  );
  assert.deepEqual(resumerEvenement("overseerr", { notification_type: "MEDIA_PENDING", subject: "Sables d'Argent" }), { evenement: "MEDIA_PENDING", titre: "Sables d'Argent" });
  assert.deepEqual(resumerEvenement("radarr", {}), { evenement: "Inconnu", titre: "" });
});

test("webhook entrant : sans WEBHOOK_SECRET (ou trop court) → 503, rien n'est mémorisé", async () => {
  for (const env of [{}, { WEBHOOK_SECRET: "court" }]) {
    const app = buildServer({ ...env, DATA_DIR: dossier() });
    assert.equal((await post(app, "/api/webhooks/radarr", { eventType: "Test" })).statusCode, 503);
  }
});

test("webhook entrant : secret en en-tête Bearer, X-Webhook-Secret ou ?secret=, sans jeton d'app ni X-Requested-With", async () => {
  const app = buildServer({ WEBHOOK_SECRET: SECRET, ACCESS_TOKEN: "jeton-app", DATA_DIR: dossier() });
  assert.equal((await post(app, "/api/webhooks/radarr", { eventType: "Test" })).statusCode, 401, "sans secret");
  assert.equal((await post(app, "/api/webhooks/radarr", { eventType: "Test" }, { authorization: "Bearer mauvais-secret-long" })).statusCode, 401);
  assert.equal((await post(app, "/api/webhooks/radarr", { eventType: "Grab", movie: { title: "Film A" } }, { authorization: `Bearer ${SECRET}` })).statusCode, 200);
  assert.equal((await post(app, "/api/webhooks/sonarr", { eventType: "Download", series: { title: "Série B" } }, { "x-webhook-secret": SECRET })).statusCode, 200);
  assert.equal((await post(app, `/api/webhooks/overseerr?secret=${SECRET}`, { notification_type: "MEDIA_PENDING", subject: "Film C" })).statusCode, 200);
  // Seules les trois routes de réception sont exemptées de l'en-tête : un autre nom est traité comme n'importe quelle écriture.
  assert.equal((await post(app, "/api/webhooks/inconnu", {}, { authorization: `Bearer ${SECRET}` })).statusCode, 403);
  assert.equal((await post(app, "/api/webhooks/inconnu", {}, { authorization: "Bearer jeton-app", "x-requested-with": "mediarr" })).statusCode, 404);
  assert.equal((await post(app, "/api/webhooks/radarr", "pas du json", { authorization: `Bearer ${SECRET}` })).statusCode, 400);

  // La lecture de l'état reste protégée par le jeton de l'app, et ne contient jamais le secret.
  assert.equal((await app.inject({ url: "/api/webhooks/etat" })).statusCode, 401);
  const etat = await app.inject({ url: "/api/webhooks/etat", headers: { authorization: "Bearer jeton-app" } });
  assert.ok(!etat.body.includes(SECRET));
  const e = etat.json();
  assert.equal(e.actif, true);
  assert.deepEqual(e.evenements.map((x: { titre: string }) => x.titre), ["Film C", "Série B", "Film A"], "du plus récent au plus ancien");
  assert.equal(e.evenements[2].service, "radarr");
  assert.equal(e.evenements[2].evenement, "Grab");
});

// ---------- configuration automatique ----------

interface Appel { method: string; url: string; body: any }
function fake(handler: (a: Appel) => unknown) {
  const appels: Appel[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      const a = { method: req.method ?? "", url: req.url ?? "", body: brut ? JSON.parse(brut) : undefined };
      appels.push(a);
      const r = handler(a) as { status?: number; json?: unknown } | undefined;
      if (!r) return void res.writeHead(404).end("{}");
      res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? {}));
    });
  });
  return new Promise<{ url: string; appels: Appel[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, appels, close: () => srv.close() })),
  );
}

const ATTENTES = [5, 5]; // au lieu de 3 s puis 10 s

/** Démarre un vrai serveur (la configuration des webhooks ne se lance qu'une fois qu'il écoute). */
async function demarrer(env: Record<string, string>, port = 0) {
  const app = buildServer(env, { attentesWebhooks: ATTENTES });
  await app.listen({ port, host: "127.0.0.1" });
  return app;
}

async function portLibre(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((ok) => srv.close(() => ok()));
  return port;
}

async function attendre(app: ReturnType<typeof buildServer>, fin: (e: any) => boolean) {
  for (let i = 0; i < 100; i++) {
    const e = (await app.inject({ url: "/api/webhooks/etat" })).json();
    if (fin(e)) return e;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("configuration automatique non terminée");
}

const MODELE = {
  implementation: "Webhook", configContract: "WebhookSettings", name: "",
  fields: [{ name: "url", value: "" }, { name: "method", value: 0 }, { name: "username", value: "" }, { name: "headers", value: [] }],
  onGrab: false, onDownload: false, onUpgrade: false, onHealthIssue: false,
};

test("notification Webhook : adresse, méthode POST, en-tête Authorization, évènements utiles activés", () => {
  const n = notificationWebhook(MODELE, "http://mediarr:8080/api/webhooks/radarr", SECRET);
  assert.equal(n.name, "Mediarr");
  assert.deepEqual(n.fields.find((f: any) => f.name === "url"), { name: "url", value: "http://mediarr:8080/api/webhooks/radarr" });
  assert.equal(n.fields.find((f: any) => f.name === "method").value, 1);
  assert.deepEqual(n.fields.find((f: any) => f.name === "headers").value, [{ key: "Authorization", value: `Bearer ${SECRET}` }]);
  assert.equal(n.fields.find((f: any) => f.name === "username").value, "", "les autres champs sont conservés");
  assert.equal(n.onGrab && n.onDownload && n.onUpgrade && n.onHealthIssue, true);
  assert.ok(!("onRename" in n), "un évènement absent du modèle n'est pas inventé");
});

test("configuration automatique : crée la notification Radarr, met à jour Sonarr, ne touche pas ce qui est déjà bon, configure Overseerr", async () => {
  const radarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [{ implementation: "Autre" }, MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") return { status: 201, json: { id: 1 } };
    return undefined;
  });
  const sonarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [{ id: 5, name: "Mediarr", implementation: "Webhook", fields: [{ name: "url", value: "http://ancienne-adresse/api/webhooks/sonarr" }] }] };
    if (a.url === "/api/v3/notification/5" && a.method === "PUT") return { json: {} };
    return undefined;
  });
  const overseerr = await fake((a) => {
    if (a.url === "/api/v1/settings/notifications/webhook" && a.method === "GET") return { json: { enabled: false, options: {} } };
    if (a.url === "/api/v1/settings/notifications/webhook" && a.method === "POST") return { json: {} };
    return undefined;
  });
  const app = await demarrer({
    RADARR_URL: radarr.url, RADARR_API_KEY: "kr", SONARR_URL: sonarr.url, SONARR_API_KEY: "ks",
    OVERSEERR_URL: overseerr.url, OVERSEERR_API_KEY: "ko",
    WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080/", DATA_DIR: dossier(),
  });
  const e = await attendre(app, (x) => !x.enCours && Object.keys(x.automatique).length === 3);
  assert.deepEqual(e.automatique, { radarr: "configuré", sonarr: "mis à jour", overseerr: "configuré" });
  assert.equal(e.raison, null);
  assert.ok(!JSON.stringify(e).includes(SECRET));

  const cree = radarr.appels.find((a) => a.method === "POST")!.body;
  assert.equal(cree.fields.find((f: any) => f.name === "url").value, "http://mediarr:8080/api/webhooks/radarr");
  assert.equal(cree.name, "Mediarr");
  const maj = sonarr.appels.find((a) => a.method === "PUT")!.body;
  assert.equal(maj.fields.find((f: any) => f.name === "url").value, "http://mediarr:8080/api/webhooks/sonarr");
  const ov = overseerr.appels.find((a) => a.method === "POST")!.body;
  assert.equal(ov.options.webhookUrl, "http://mediarr:8080/api/webhooks/overseerr");
  assert.equal(ov.options.authHeader, `Bearer ${SECRET}`);
  assert.equal(ov.enabled, true);
  radarr.close(); sonarr.close(); overseerr.close(); await app.close();
});

test("configuration automatique : déjà en place → aucune écriture ; échec d'un service → noté sans le secret", async () => {
  const deja = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET")
      return { json: [{ id: 2, name: "Mediarr", fields: [{ name: "url", value: "http://mediarr:8080/api/webhooks/radarr" }] }] };
    return undefined;
  });
  const casse = await fake(() => ({ status: 500 }));
  const app = await demarrer({
    RADARR_URL: deja.url, RADARR_API_KEY: "kr", SONARR_URL: casse.url, SONARR_API_KEY: "ks",
    WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dossier(),
  });
  const e = await attendre(app, (x) => !x.enCours && Object.keys(x.automatique).length === 2);
  assert.equal(e.automatique.radarr, "déjà configuré");
  assert.match(e.automatique.sonarr, /^échec/);
  assert.ok(!JSON.stringify(e).includes(SECRET));
  assert.deepEqual(deja.appels.map((a) => a.method), ["GET"], "rien n'a été écrit");
  deja.close(); casse.close(); await app.close();
});

test("configuration automatique : désactivable, et la raison est dite quand elle ne tourne pas", async () => {
  const f = await fake(() => ({ json: [] }));
  const base = { RADARR_URL: f.url, RADARR_API_KEY: "kr", DATA_DIR: dossier() };
  const sansUrl = await demarrer({ ...base, WEBHOOK_SECRET: SECRET });
  assert.match((await sansUrl.inject({ url: "/api/webhooks/etat" })).json().raison, /MEDIARR_URL/);
  assert.match((await buildServer({ ...base }).inject({ url: "/api/webhooks/etat" })).json().raison, /WEBHOOK_SECRET/);

  // Le réglage est enregistré AVANT le démarrage (comme en vrai : les préférences existent déjà au lancement).
  const dir = dossier();
  const avant = buildServer({ RADARR_URL: f.url, RADARR_API_KEY: "kr", DATA_DIR: dir });
  await avant.inject({ method: "PUT", url: "/api/prefs", headers: { "x-requested-with": "mediarr", "content-type": "application/json" }, payload: JSON.stringify({ reglages: { webhooksAuto: false } }) });
  const desactive = await demarrer({ RADARR_URL: f.url, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dir });
  await new Promise((r) => setTimeout(r, 150));
  assert.match((await desactive.inject({ url: "/api/webhooks/etat" })).json().raison, /désactivée/);
  assert.equal(f.appels.length, 0, "aucune requête vers les services");
  f.close(); await sansUrl.close(); await desactive.close();
});


// ---------- démarrage : ordre, tentatives, cause réelle, bouton manuel ----------

const REFUS = (adresse: string) => ({ status: 500, json: [{ propertyName: "", errorMessage: `Unable to send test message: Connection refused (${adresse})` }] });

test("démarrage : la configuration ne commence qu'APRÈS l'écoute — Radarr, qui teste l'adresse à la création, y trouve Mediarr", async () => {
  const port = await portLibre();
  let refus = 0;
  const radarr = await fakeAsync(async (a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") {
      // Comme le vrai Radarr : à la création, il envoie un message de test à l'adresse du webhook.
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/webhooks/radarr`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ eventType: "Test" }) });
        return r.ok ? { status: 201, json: { id: 1 } } : { status: 500, json: [] };
      } catch {
        refus++;
        return REFUS(`127.0.0.1:${port}`);
      }
    }
    return undefined;
  });
  const app = await demarrer({ RADARR_URL: radarr.url, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: `http://127.0.0.1:${port}`, DATA_DIR: dossier() }, port);
  const e = await attendre(app, (x) => !x.enCours && x.automatique.radarr !== undefined && x.automatique.radarr !== "en cours");
  assert.equal(e.automatique.radarr, "configuré");
  assert.equal(refus, 0, "aucune connexion refusée : le serveur écoutait déjà");
  assert.equal(radarr.appels.filter((a) => a.method === "POST").length, 1, "une seule tentative a suffi");
  // Et le message de test de Radarr a bien été reçu et listé.
  assert.equal(e.evenements[0].evenement, "Test");
  radarr.close(); await app.close();
});

test("tentatives : refus au premier essai puis succès — « nouvelle tentative » affichée avec la cause, puis « configuré »", async () => {
  let essais = 0;
  const radarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") return ++essais === 1 ? REFUS("192.168.1.10:30060") : { status: 201, json: { id: 1 } };
    return undefined;
  });
  const app = buildServer(
    { RADARR_URL: radarr.url, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dossier() },
    { attentesWebhooks: [400, 400] },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const pendant = await attendre(app, (x) => /nouvelle tentative/.test(x.automatique.radarr ?? ""));
  assert.match(pendant.automatique.radarr, /^nouvelle tentative 2\/3 dans \d+ s \(connexion refusée — Unable to send test message/);
  assert.equal(pendant.enCours, true);
  const fin = await attendre(app, (x) => x.automatique.radarr === "configuré");
  assert.equal(fin.enCours, false);
  assert.equal(essais, 2);
  radarr.close(); await app.close();
});

test("échec après 3 tentatives : la cause réelle du service est affichée, sans le secret, et un service ne retarde pas l'autre", async () => {
  let essais = 0;
  const radarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") { essais++; return REFUS(`192.168.1.10:30060 ${SECRET}`); }
    return undefined;
  });
  const sonarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [{ id: 5, name: "Mediarr", fields: [{ name: "url", value: "http://mediarr:8080/api/webhooks/sonarr" }] }] };
    return undefined;
  });
  const app = buildServer(
    { RADARR_URL: radarr.url, RADARR_API_KEY: "kr", SONARR_URL: sonarr.url, SONARR_API_KEY: "ks", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dossier() },
    { attentesWebhooks: [300, 300] },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const tot = await attendre(app, (x) => x.automatique.sonarr === "déjà configuré");
  assert.equal(tot.enCours, true, "Sonarr est fini alors que Radarr est encore en train de réessayer");
  const fin = await attendre(app, (x) => !x.enCours);
  assert.equal(essais, 3);
  assert.match(fin.automatique.radarr, /^échec : connexion refusée — Unable to send test message: Connection refused \(192.168.1.10:30060 \*\*\*\) \(HTTP 500\)$/);
  assert.ok(!JSON.stringify(fin).includes(SECRET));
  radarr.close(); sonarr.close(); await app.close();
});

test("cause réelle d'une panne réseau : service éteint → « connexion refusée » (pas « fetch failed »)", async () => {
  const ferme = await portLibre(); // un port où personne n'écoute (le port 1 est refusé par fetch lui-même : « bad port »)
  const app = buildServer(
    { RADARR_URL: `http://127.0.0.1:${ferme}`, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dossier() },
    { attentesWebhooks: [5, 5] },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const fin = await attendre(app, (x) => !x.enCours && /^échec/.test(x.automatique.radarr ?? ""));
  assert.equal(fin.automatique.radarr, "échec : connexion refusée");
  await app.close();
});

test("« Reconfigurer maintenant » : protégé (jeton + en-tête), relance, pas deux fois en même temps, prérequis expliqués", async () => {
  let echecs = 3; // les 3 tentatives du lancement échouent, puis le service se rétablit
  const radarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") return echecs-- > 0 ? REFUS("192.168.1.10:30060") : { status: 201, json: { id: 1 } };
    return undefined;
  });
  const env = { RADARR_URL: radarr.url, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", ACCESS_TOKEN: "jeton-app", DATA_DIR: dossier() };
  const app = buildServer(env, { attentesWebhooks: [150, 150] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const en = { authorization: "Bearer jeton-app", "x-requested-with": "mediarr" };
  const lire = async () => (await app.inject({ url: "/api/webhooks/etat", headers: { authorization: "Bearer jeton-app" } })).json();

  // Protection : contrairement aux trois routes de réception, celle-ci demande le jeton ET l'en-tête.
  assert.equal((await app.inject({ method: "POST", url: "/api/webhooks/configurer", headers: { "x-requested-with": "mediarr" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/webhooks/configurer", headers: { authorization: "Bearer jeton-app" } })).statusCode, 403);

  // Le lancement automatique a échoué 3 fois ; le bouton relance et réussit.
  await attendre2(lire, (x) => !x.enCours && /^échec/.test(x.automatique.radarr ?? ""));
  const relance = await app.inject({ method: "POST", url: "/api/webhooks/configurer", headers: en });
  assert.equal(relance.statusCode, 202);
  assert.equal(relance.json().enCours, true);
  assert.equal((await lire()).automatique.radarr, "en cours", "l'état est remis à zéro pour chaque service");
  assert.equal((await app.inject({ method: "POST", url: "/api/webhooks/configurer", headers: en })).statusCode, 409, "déjà en cours");
  const fin = await attendre2(lire, (x) => x.automatique.radarr === "configuré");
  assert.equal(fin.enCours, false);
  radarr.close(); await app.close();

  // Prérequis manquants : message clair (et rien n'est lancé).
  const sans = buildServer({ RADARR_URL: "http://127.0.0.1:1", RADARR_API_KEY: "kr", DATA_DIR: dossier() });
  const r = await sans.inject({ method: "POST", url: "/api/webhooks/configurer", headers: { "x-requested-with": "mediarr" } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /WEBHOOK_SECRET/);
});

test("« Reconfigurer maintenant » fonctionne même si la configuration automatique est désactivée dans les Réglages", async () => {
  const radarr = await fake((a) => {
    if (a.url === "/api/v3/notification" && a.method === "GET") return { json: [] };
    if (a.url === "/api/v3/notification/schema") return { json: [MODELE] };
    if (a.url === "/api/v3/notification" && a.method === "POST") return { status: 201, json: { id: 1 } };
    return undefined;
  });
  const dir = dossier();
  const avant = buildServer({ DATA_DIR: dir });
  await avant.inject({ method: "PUT", url: "/api/prefs", headers: { "x-requested-with": "mediarr", "content-type": "application/json" }, payload: JSON.stringify({ reglages: { webhooksAuto: false } }) });
  const app = await demarrer({ RADARR_URL: radarr.url, RADARR_API_KEY: "kr", WEBHOOK_SECRET: SECRET, MEDIARR_URL: "http://mediarr:8080", DATA_DIR: dir });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(radarr.appels.length, 0, "rien au lancement");
  assert.equal((await app.inject({ method: "POST", url: "/api/webhooks/configurer", headers: { "x-requested-with": "mediarr" } })).statusCode, 202);
  await attendre(app, (x) => x.automatique.radarr === "configuré");
  radarr.close(); await app.close();
});

async function attendre2(lire: () => Promise<any>, fin: (e: any) => boolean) {
  for (let i = 0; i < 150; i++) {
    const e = await lire();
    if (fin(e)) return e;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("état attendu non atteint");
}

/** Comme `fake`, mais le gestionnaire peut être asynchrone (Radarr qui teste l'adresse du webhook avant de répondre). */
function fakeAsync(handler: (a: Appel) => Promise<unknown>) {
  const appels: Appel[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", async () => {
      const a = { method: req.method ?? "", url: req.url ?? "", body: brut ? JSON.parse(brut) : undefined };
      appels.push(a);
      const r = (await handler(a)) as { status?: number; json?: unknown } | undefined;
      if (!r) return void res.writeHead(404).end("{}");
      res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? {}));
    });
  });
  return new Promise<{ url: string; appels: Appel[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, appels, close: () => srv.close() })),
  );
}

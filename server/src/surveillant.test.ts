import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { configNtfy, creerEnvoiNtfy, purgerNtfy, type Notif } from "./ntfy.js";
import { instantMontreal, Surveillant, DELAI_RENVOI_MS } from "./surveillant.js";
import type { ReglagesNotifs } from "./prefs.js";
import type { ServiceId } from "./services.js";

const GO = 1024 ** 3;
const MIN = 60_000;
const H = 3_600_000;
const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };

const REGLAGES: ReglagesNotifs = {
  types: { disque: true, indexeur: true, torrent: true, service: true, resume: true },
  intervalleMin: 2,
  seuils: { disquePct: 10, disqueGo: 200, disqueCritiquePct: 5, torrentHeures: 2, serviceMinutes: 5 },
};

/** Un petit « monde » modifiable : faux services, fausse horloge, faux ntfy. */
function monde(opts: { dossier?: string; envoyer?: boolean; configures?: ServiceId[] } = {}) {
  const m = {
    t: Date.UTC(2026, 9, 8, 15, 0), // jeudi 8 octobre 2026, 11 h à Montréal
    envoyes: [] as Notif[],
    ntfyHs: false,
    reglages: structuredClone(REGLAGES),
    // 1 To dont 600 Go libres : tout va bien
    libre: 600 * GO,
    libreSerie: 600 * GO,
    total: 1024 * GO,
    radarrHs: false,
    films: [] as { title: string; added: string }[],
    series: [] as { title: string; added: string }[],
    indexeurs: [{ id: 1, name: "YTS", enable: true }] as Record<string, unknown>[],
    statuts: [] as Record<string, unknown>[],
    torrents: [] as Record<string, unknown>[],
    services: [
      { id: "radarr", label: "Radarr", ok: true },
      { id: "plex", label: "Plex", ok: true },
    ] as { id: string; label: string; ok: boolean }[],
    tests: 0,
    causeTest: "401 Unauthorized : clé API ou identifiants refusés par l'indexeur" as string | null,
  };
  const configures = new Set<ServiceId>(opts.configures ?? ["radarr", "sonarr", "prowlarr", "qbittorrent"]);
  const surveillant = new Surveillant({
    getJson: async (id, path) => {
      if (id === "radarr" && m.radarrHs) throw new Error("Radarr : connexion refusée");
      if (path === "/rootfolder") {
        return id === "sonarr"
          ? [{ path: "/series", freeSpace: m.libreSerie, totalSpace: m.total, accessible: true }]
          : [{ path: "/films", freeSpace: m.libre, totalSpace: m.total, accessible: true }];
      }
      if (path === "/diskspace") return [];
      if (path === "/movie") return m.films;
      if (path === "/series") return m.series;
      if (path === "/indexer") return m.indexeurs;
      if (path === "/indexerstatus") return m.statuts;
      if (path === "/torrents/info") return m.torrents;
      throw new Error(`chemin inattendu ${path}`);
    },
    configured: (id) => configures.has(id),
    sante: async () => m.services,
    causeConnue: () => null,
    causeParTest: async () => {
      m.tests++;
      return m.causeTest;
    },
    envoyer:
      opts.envoyer === false
        ? null
        : async (n) => {
            if (m.ntfyHs) throw new Error("ntfy injoignable (connexion refusée)");
            m.envoyes.push(n);
          },
    reglages: () => m.reglages,
    maintenant: () => m.t,
    dossier: opts.dossier ?? mkdtempSync(join(tmpdir(), "mediarr-surv-")),
  });
  return { m, s: surveillant };
}

/** Première lecture (silencieuse), puis 2 minutes plus tard. */
async function amorcer(w: ReturnType<typeof monde>) {
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0, "rien n'est envoyé à la première lecture");
  w.m.t += 2 * MIN;
}

// ---------- disque ----------

test("disque : sous 10 % → alerte ; sous 5 % → critique tout de suite ; retour à la normale → « résolu » une fois", async () => {
  const w = monde();
  await amorcer(w);
  w.m.libre = 80 * GO; // 7,8 % de 1 To et moins de 200 Go
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  assert.match(w.m.envoyes[0].titre, /Peu d'espace disque : \/films/);
  assert.equal(w.m.envoyes[0].priorite, 4);
  assert.match(w.m.envoyes[0].message, /80 Go libres \(7,8 %\)/);

  w.m.t += 2 * MIN;
  w.m.libre = 30 * GO; // 2,9 % : critique, envoyé sans attendre 6 h
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2);
  assert.equal(w.m.envoyes[1].priorite, 5);
  assert.match(w.m.envoyes[1].titre, /presque plein/);

  w.m.t += 2 * MIN;
  w.m.libre = 700 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 3);
  assert.match(w.m.envoyes[2].titre, /Espace disque revenu/);
  assert.equal(w.m.envoyes[2].priorite, 3);

  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 3, "« résolu » n'est envoyé qu'une fois");
});

test("disque : seuil en Go seul (disque énorme à 15 % mais 150 Go libres) ; seuils réglables", async () => {
  const w = monde();
  await amorcer(w);
  w.m.total = 1000 * GO; // 15 % libres, mais < 200 Go
  w.m.libre = 150 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);

  const v = monde();
  await amorcer(v);
  v.m.reglages.seuils.disqueGo = 0;
  v.m.reglages.seuils.disquePct = 20;
  v.m.libre = 150 * GO; // 14,6 % < 20 %
  await v.s.tick();
  assert.equal(v.m.envoyes.length, 1);

  const u = monde(); // à 15 % et 300 Go libres, les seuils par défaut ne disent rien
  await amorcer(u);
  u.m.total = 2000 * GO;
  u.m.libre = 300 * GO;
  await u.s.tick();
  assert.equal(u.m.envoyes.length, 0);
});

test("anti-spam : une alerte identique ne revient qu'après 6 h tant que le problème dure", async () => {
  const w = monde();
  await amorcer(w);
  w.m.libre = 50 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  for (let i = 0; i < 20; i++) {
    w.m.t += 2 * MIN;
    await w.s.tick();
  }
  assert.equal(w.m.envoyes.length, 1, "40 minutes plus tard : rien de nouveau");
  w.m.t += DELAI_RENVOI_MS;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2, "après 6 h : on rappelle");
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2);
});

test("premier lancement : un problème déjà là n'est pas annoncé tout de suite ni « résolu » ensuite", async () => {
  const w = monde();
  w.m.libre = 50 * GO;
  await w.s.tick(); // état jamais lu : silence
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0);
  w.m.libre = 700 * GO;
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0, "jamais annoncé → pas de « résolu » non plus");
});

test("état gardé sur disque : un redémarrage ne renvoie rien pendant les 6 h", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "mediarr-surv-"));
  const w = monde({ dossier });
  await amorcer(w);
  w.m.libre = 50 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);

  const w2 = monde({ dossier });
  w2.m.t = w.m.t + 10 * MIN;
  w2.m.libre = 50 * GO;
  await w2.s.tick(); // état relu : plus de silence de démarrage, mais l'alerte date de 10 min
  assert.equal(w2.m.envoyes.length, 0);
  w2.m.t += DELAI_RENVOI_MS;
  await w2.s.tick();
  assert.equal(w2.m.envoyes.length, 1);
});

// ---------- indexeurs ----------

test("indexeur en échec : cause trouvée par un test unique, puis « rétabli » ; un indexeur désactivé par toi n'alerte pas", async () => {
  const w = monde();
  w.m.indexeurs = [
    { id: 1, name: "YTS", enable: true },
    { id: 2, name: "Ancien", enable: false },
  ];
  await amorcer(w);
  w.m.statuts = [
    { indexerId: 1, mostRecentFailure: "2026-10-05T10:00:00Z", initialFailure: "2026-10-05T09:00:00Z" },
    { indexerId: 2, mostRecentFailure: "2026-10-05T10:00:00Z" },
  ];
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  assert.match(w.m.envoyes[0].titre, /Indexeur en échec : YTS/);
  assert.match(w.m.envoyes[0].message, /401 Unauthorized/);
  assert.match(w.m.envoyes[0].message, /2026-10-05/);
  assert.equal(w.m.tests, 1);

  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.tests, 1, "la cause n'est cherchée qu'une fois par épisode");
  assert.equal(w.m.envoyes.length, 1);

  w.m.statuts = [];
  w.m.t += 3 * H;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2);
  assert.match(w.m.envoyes[1].titre, /Indexeur rétabli : YTS/);
  assert.match(w.m.envoyes[1].message, /3 h/);
});

test("indexeur : sans cause trouvée, le message le dit au lieu d'inventer", async () => {
  const w = monde();
  w.m.causeTest = null;
  await amorcer(w);
  w.m.statuts = [{ indexerId: 1, mostRecentFailure: "2026-10-05T10:00:00Z" }];
  await w.s.tick();
  assert.match(w.m.envoyes[0].message, /cause inconnue/);
});

// ---------- torrents ----------

test("torrent bloqué : seulement au-delà de 2 h ; nom et durée dans le message ; en pause ignoré ; « débloqué » à la fin", async () => {
  const w = monde();
  await amorcer(w);
  const il = (ms: number) => Math.floor((w.m.t - ms) / 1000);
  w.m.torrents = [
    { hash: "a", name: "Film.Bloque.2024", state: "stalledDL", progress: 0.4, added_on: il(10 * H), last_activity: il(3 * H + 30 * MIN) },
    { hash: "b", name: "Recent.Bloque", state: "stalledDL", progress: 0.4, added_on: il(10 * H), last_activity: il(30 * MIN) },
    { hash: "c", name: "Zero.Pour.Cent", state: "downloading", progress: 0, added_on: il(5 * H), last_activity: il(1 * MIN) },
    { hash: "d", name: "En.Pause", state: "pausedDL", progress: 0, added_on: il(20 * H), last_activity: 0 },
    { hash: "e", name: "Termine", state: "stalledUP", progress: 1, added_on: il(20 * H), last_activity: il(9 * H) },
  ];
  await w.s.tick();
  const titres = w.m.envoyes.map((n) => n.titre).sort();
  assert.deepEqual(titres, ["Torrent bloqué : Film.Bloque.2024", "Torrent bloqué : Zero.Pour.Cent"]);
  const film = w.m.envoyes.find((n) => n.titre.includes("Film.Bloque"))!;
  assert.match(film.message, /bloqué, sans source depuis 3 h 3\d/);
  const zero = w.m.envoyes.find((n) => n.titre.includes("Zero"))!;
  assert.match(zero.message, /toujours à 0 % depuis 5 h/);

  w.m.torrents = [];
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.filter((n) => n.titre.startsWith("Torrent débloqué")).length, 2);
});

test("torrent « fichiers manquants » : annoncé 2 h après la première fois qu'on le voit", async () => {
  const w = monde();
  w.m.torrents = [{ hash: "m", name: "Fichiers.Perdus", state: "missingFiles", progress: 0.9, added_on: 1, last_activity: 1 }];
  await amorcer(w);
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0);
  w.m.t += 2 * H;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  assert.match(w.m.envoyes[0].message, /fichiers manquants depuis 2 h/);
});

// ---------- services ----------

test("service hors ligne : annoncé après 5 minutes, puis « de nouveau en ligne » avec la durée ; un service non configuré n'existe pas", async () => {
  const w = monde();
  await amorcer(w);
  w.m.services[1].ok = false; // Plex tombe
  await w.s.tick();
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0, "4 minutes : trop tôt");
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0, "tout juste 4 min 59 plus tard…");
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  assert.match(w.m.envoyes[0].titre, /Plex est hors ligne/);

  w.m.services[1].ok = true;
  w.m.t += 4 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2);
  assert.match(w.m.envoyes[1].titre, /Plex est de nouveau en ligne/);
  assert.match(w.m.envoyes[1].message, /hors ligne pendant 1\d min/);
});

test("service qui revient avant 5 minutes : aucune notification", async () => {
  const w = monde();
  await amorcer(w);
  w.m.services[0].ok = false;
  await w.s.tick();
  w.m.t += 2 * MIN;
  w.m.services[0].ok = true;
  await w.s.tick();
  w.m.t += 10 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0);
});

test("service non configuré : aucune alerte, aucune erreur", async () => {
  const w = monde({ configures: [] });
  w.m.services = [];
  await amorcer(w);
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0);
});

test("source illisible (Radarr éteint) : l'alerte disque en cours n'est ni résolue ni oubliée", async () => {
  const w = monde();
  await amorcer(w);
  w.m.libre = 50 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1);
  w.m.radarrHs = true;
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 1, "pas de faux « résolu » parce que Radarr ne répond pas");
  w.m.radarrHs = false;
  w.m.libre = 700 * GO;
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 2);
  assert.match(w.m.envoyes[1].titre, /Espace disque revenu/);
});

// ---------- réglages ----------

test("un type coupé dans Réglages n'envoie rien ; ntfy non configuré = surveillant inactif", async () => {
  const w = monde();
  w.m.reglages.types.disque = false;
  await amorcer(w);
  w.m.libre = 10 * GO;
  await w.s.tick();
  assert.equal(w.m.envoyes.length, 0);

  const v = monde({ envoyer: false });
  assert.equal(v.s.actif, false);
  await v.s.tick();
  assert.equal(v.s.resume().journal.length, 0);
});

// ---------- ntfy injoignable ----------

test("ntfy injoignable : la surveillance continue, l'échec est noté, l'envoi est retenté à la passe suivante", async () => {
  const w = monde();
  await amorcer(w);
  w.m.ntfyHs = true;
  w.m.libre = 50 * GO;
  w.m.services[1].ok = false;
  await w.s.tick(); // ne doit pas lever d'exception
  w.m.t += 2 * MIN;
  await w.s.tick();
  const journal = w.s.resume().journal;
  assert.ok(journal.length >= 1);
  assert.ok(journal.every((j) => !j.ok && /ntfy injoignable/.test(j.erreur ?? "")));
  assert.equal(w.m.envoyes.length, 0);

  w.m.ntfyHs = false;
  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.ok(w.m.envoyes.some((n) => /presque plein/.test(n.titre)), "l'alerte part dès que ntfy répond");
});

test("journal : seulement les 50 dernières notifications", async () => {
  const w = monde();
  for (let i = 0; i < 60; i++) await w.s.notifier("test", `n°${i}`, "x", 3, []);
  const j = w.s.resume().journal;
  assert.equal(j.length, 50);
  assert.equal(j[0].titre, "n°59");
});

// ---------- résumé hebdomadaire ----------

test("résumé : dimanche 9 h (Montréal) seulement, une fois, avec titres ajoutés, espace et alertes", async () => {
  assert.deepEqual(instantMontreal(Date.UTC(2026, 9, 11, 12, 59)), { jour: 0, heure: 8, date: "2026-10-11" }); // 8 h 59 EDT
  assert.deepEqual(instantMontreal(Date.UTC(2026, 9, 11, 13, 0)), { jour: 0, heure: 9, date: "2026-10-11" });
  // Après le passage à l'heure d'hiver (1er novembre), 9 h = 14 h UTC.
  assert.equal(instantMontreal(Date.UTC(2026, 10, 8, 13, 59)).heure, 8);
  assert.equal(instantMontreal(Date.UTC(2026, 10, 8, 14, 0)).heure, 9);

  const w = monde();
  w.m.t = Date.UTC(2026, 9, 10, 15, 0); // samedi
  w.m.films = [
    { title: "Delta", added: "2026-10-07T10:00:00Z" },
    { title: "Trop Vieux", added: "2026-08-01T10:00:00Z" },
  ];
  w.m.series = [{ title: "Sillage", added: "2026-10-09T10:00:00Z" }];
  await amorcer(w);
  w.m.libre = 50 * GO;
  await w.s.tick(); // une alerte dans la semaine
  assert.equal(w.m.envoyes.length, 1);

  w.m.t = Date.UTC(2026, 9, 11, 12, 30); // dimanche 8 h 30 : trop tôt
  await w.s.tick();
  assert.equal(w.m.envoyes.filter((n) => /Résumé/.test(n.titre)).length, 0);

  w.m.t = Date.UTC(2026, 9, 11, 13, 5); // dimanche 9 h 05
  await w.s.tick();
  const resume = w.m.envoyes.filter((n) => /Résumé/.test(n.titre));
  assert.equal(resume.length, 1);
  assert.match(resume[0].message, /2 titres ajoutés \(1 film, 1 série\) : Delta, Sillage/);
  assert.doesNotMatch(resume[0].message, /Trop Vieux/);
  assert.match(resume[0].message, /50 Go libres/);
  assert.match(resume[0].message, /1 alerte cette semaine : Peu d'espace disque|1 alerte cette semaine : Disque presque plein/);

  w.m.t += 2 * MIN;
  await w.s.tick();
  assert.equal(w.m.envoyes.filter((n) => /Résumé/.test(n.titre)).length, 1, "une seule fois ce dimanche");

  w.m.reglages.types.resume = false;
  w.m.t = Date.UTC(2026, 9, 18, 14, 0); // dimanche suivant, résumé coupé
  await w.s.tick();
  assert.equal(w.m.envoyes.filter((n) => /Résumé/.test(n.titre)).length, 1);
});

// ---------- client ntfy ----------

test("configNtfy : désactivé sans URL ou sans sujet, ou si invalide ; jamais d'erreur", () => {
  assert.equal(configNtfy({}), null);
  assert.equal(configNtfy({ NTFY_URL: "http://nas:8090" }), null);
  assert.equal(configNtfy({ NTFY_TOPIC: "mediarr" }), null);
  assert.equal(configNtfy({ NTFY_URL: "pas une url", NTFY_TOPIC: "mediarr" }), null);
  assert.equal(configNtfy({ NTFY_URL: "ftp://nas", NTFY_TOPIC: "mediarr" }), null);
  assert.equal(configNtfy({ NTFY_URL: "http://nas:8090", NTFY_TOPIC: "un sujet/avec espace" }), null);
  assert.deepEqual(configNtfy({ NTFY_URL: " http://nas:8090/ ", NTFY_TOPIC: " mediarr " }), { url: "http://nas:8090", topic: "mediarr" });
  assert.equal(configNtfy({ NTFY_URL: "http://nas:8090", NTFY_TOPIC: "mediarr", NTFY_TOKEN: " tk_abc " })?.token, "tk_abc");
});

test("purgerNtfy retire jeton, sujet, adresse et hôte", () => {
  const cfg = { url: "http://nas.maison:8090", topic: "mediarr-secret", token: "tk_abcdef" };
  const t = purgerNtfy("échec http://nas.maison:8090 sujet mediarr-secret jeton tk_abcdef hôte nas.maison:8090", cfg);
  assert.doesNotMatch(t, /nas\.maison|mediarr-secret|tk_abcdef/);
});

// ---------- intégration : faux serveur ntfy + routes ----------

function fauxNtfy(statut = 200): Promise<{ url: string; close: () => void; recus: { auth?: string; corps: Record<string, unknown> }[] }> {
  const recus: { auth?: string; corps: Record<string, unknown> }[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      if (statut === 200) recus.push({ auth: req.headers.authorization, corps: JSON.parse(brut) });
      res.writeHead(statut, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), recus }),
    ),
  );
}

test("routes : sans NTFY_URL/NTFY_TOPIC → message clair, pas d'erreur ; le test est refusé proprement", async () => {
  const app = buildServer({ DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const etat = (await app.inject({ url: "/api/notifications/etat" })).json();
  assert.equal(etat.configure, false);
  assert.equal(etat.message, "Notifications : définis NTFY_URL et NTFY_TOPIC");
  assert.deepEqual(etat.journal, []);
  const test = await app.inject({ method: "POST", url: "/api/notifications/test", headers: MARQUE, payload: "{}" });
  assert.equal(test.statusCode, 409);
  assert.equal(test.json().error, "Notifications : définis NTFY_URL et NTFY_TOPIC");
});

test("routes : bouton de test protégé (jeton + X-Requested-With), envoie en JSON, jeton/sujet jamais renvoyés", async () => {
  const ntfy = await fauxNtfy();
  const app = buildServer({
    DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")),
    ACCESS_TOKEN: "jeton-app-12345",
    NTFY_URL: ntfy.url,
    NTFY_TOPIC: "sujet-prive-xyz",
    NTFY_TOKEN: "tk_secret_ntfy",
  });
  const sansMarque = await app.inject({ method: "POST", url: "/api/notifications/test", headers: { authorization: "Bearer jeton-app-12345" } });
  assert.equal(sansMarque.statusCode, 403);
  const sansJeton = await app.inject({ method: "POST", url: "/api/notifications/test", headers: MARQUE, payload: "{}" });
  assert.equal(sansJeton.statusCode, 401);
  assert.equal(ntfy.recus.length, 0);

  const auth = { ...MARQUE, authorization: "Bearer jeton-app-12345" };
  const ok = await app.inject({ method: "POST", url: "/api/notifications/test", headers: auth, payload: "{}" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ntfy.recus.length, 1);
  assert.equal(ntfy.recus[0].auth, "Bearer tk_secret_ntfy");
  assert.equal(ntfy.recus[0].corps.topic, "sujet-prive-xyz");
  assert.equal(ntfy.recus[0].corps.title, "Notification de test");

  const etat = await app.inject({ url: "/api/notifications/etat", headers: { authorization: "Bearer jeton-app-12345" } });
  const corps = etat.body;
  assert.equal(etat.json().configure, true);
  assert.equal(etat.json().journal.length, 1);
  assert.equal(etat.json().journal[0].ok, true);
  for (const secret of ["tk_secret_ntfy", "sujet-prive-xyz", ntfy.url, "127.0.0.1"]) assert.ok(!corps.includes(secret), `fuite : ${secret}`);
  ntfy.close();
});

test("routes : ntfy refuse (401) → 502 clair, noté au journal, sans aucun secret", async () => {
  const ntfy = await fauxNtfy(401);
  const app = buildServer({ DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")), NTFY_URL: ntfy.url, NTFY_TOPIC: "sujet-prive-xyz", NTFY_TOKEN: "tk_secret_ntfy" });
  const r = await app.inject({ method: "POST", url: "/api/notifications/test", headers: MARQUE, payload: "{}" });
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /HTTP 401/);
  const etat = await app.inject({ url: "/api/notifications/etat" });
  assert.equal(etat.json().journal[0].ok, false);
  for (const secret of ["tk_secret_ntfy", "sujet-prive-xyz", "127.0.0.1"]) assert.ok(!r.body.includes(secret) && !etat.body.includes(secret));
  ntfy.close();
});

test("routes : ntfy éteint → 502 « injoignable », le serveur reste debout", async () => {
  const app = buildServer({ DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")), NTFY_URL: "http://127.0.0.1:1", NTFY_TOPIC: "mediarr" });
  const r = await app.inject({ method: "POST", url: "/api/notifications/test", headers: MARQUE, payload: "{}" });
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /ntfy injoignable/);
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
});

test("préférences : section notifications validée (bornes, seuil critique ≤ seuil d'alerte)", async () => {
  const app = buildServer({ DATA_DIR: mkdtempSync(join(tmpdir(), "mediarr-")) });
  const defauts = (await app.inject({ url: "/api/prefs" })).json().prefs.notifications;
  assert.deepEqual(defauts, REGLAGES);
  const r = (
    await app.inject({
      method: "PUT",
      url: "/api/prefs",
      headers: MARQUE,
      payload: JSON.stringify({ notifications: { types: { disque: false, bidon: true }, intervalleMin: 9999, seuils: { disquePct: 8, disqueCritiquePct: 30, torrentHeures: -4, serviceMinutes: "x" } } }),
    })
  ).json().prefs.notifications;
  assert.equal(r.types.disque, false);
  assert.equal(r.types.service, true);
  assert.equal(r.types.bidon, undefined);
  assert.equal(r.intervalleMin, 60);
  assert.equal(r.seuils.disquePct, 8);
  assert.equal(r.seuils.disqueCritiquePct, 8);
  assert.equal(r.seuils.torrentHeures, 1);
  assert.equal(r.seuils.serviceMinutes, 5);
});

test("alertes de l'accueil : les problèmes du surveillant s'ajoutent à ceux de Prowlarr", async () => {
  const w = monde();
  await amorcer(w);
  w.m.libre = 20 * GO;
  await w.s.tick();
  const a = w.s.alertes();
  assert.equal(a.length, 1);
  assert.equal(a[0].niveau, "critique");
  assert.equal(a[0].source, "Disque");
  const creaneau = creerEnvoiNtfy({ url: "http://127.0.0.1:1", topic: "t" }, async () => {
    throw Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
  });
  await assert.rejects(creaneau({ titre: "é", message: "m", priorite: 3 }), /ntfy injoignable \(connexion refusée\)/);
});

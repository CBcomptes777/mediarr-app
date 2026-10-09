import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "./journal.js";
import { buildServer } from "./server.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };
const dossierTemp = () => mkdtempSync(join(tmpdir(), "mediarr-test-"));
const put = (app: ReturnType<typeof buildServer>, corps: unknown) =>
  app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify(corps) });

// ---------- préférences ----------

test("préférences : valeurs par défaut complètes, stockage persistant avec DATA_DIR", async () => {
  const app = buildServer({ DATA_DIR: dossierTemp() });
  const r = (await app.inject({ url: "/api/prefs" })).json();
  assert.deepEqual(r.prefs.reglages.ordreServices, ["radarr", "sonarr", "overseerr", "qbittorrent", "plex", "prowlarr", "homarr"]);
  assert.equal(r.prefs.reglages.delaiHttpMs, 15000);
  assert.equal(r.prefs.reglages.masquerSuppression, false);
  assert.equal(r.prefs.reglages.webhooksAuto, true);
  assert.deepEqual(r.prefs.accueil.widgets.filter((w: { visible: boolean }) => !w.visible).map((w: { id: string }) => w.id), ["genres", "actions"]);
  assert.equal(r.prefs.accueil.widgets.length, 12);
  assert.equal(r.prefs.stats.cartes.length, 6);
  assert.equal(r.prefs.apparence.theme, "auto");
  assert.equal(r.prefs.apparence.accent, "#a78bfa");
  assert.equal(r.stockage.persistant, true);
  assert.equal(r.stockage.avertissement, null);
  assert.equal(r.jetonActif, false);
});

test("préférences : tout est validé, les valeurs inconnues ou dangereuses sont remplacées", async () => {
  const app = buildServer({ DATA_DIR: dossierTemp() });
  const r = (
    await put(app, {
      reglages: {
        reseau: { maison: "http://192.168.1.10:8080/", tailscale: "javascript:alert(1)", preferee: "nimporte" },
        ordreServices: ["plex", "plex", "inconnu", "radarr"],
        delaiHttpMs: 999999,
        masquerSuppression: "oui",
      },
      accueil: { widgets: [{ id: "stockage", visible: false }, { id: "inconnu", visible: true }, { id: "stockage", visible: true }, { id: "services" }] },
      actionsRapides: [
        { id: "a1", libelle: "Film", type: "media", mediaType: "film", mediaId: 12 },
        { id: "a2", libelle: "Mauvais lien", type: "url", url: "javascript:alert(1)" },
        { id: "a3", libelle: "Bon lien", type: "url", url: "https://exemple.org/page" },
        { id: "a4", libelle: "Écran", type: "ecran", ecran: "stats" },
        { id: "a5", libelle: "Écran inconnu", type: "ecran", ecran: "../../etc" },
        { id: "a1", libelle: "Doublon", type: "ecran", ecran: "stats" },
        { id: "a6", libelle: "", type: "ecran", ecran: "stats" },
      ],
      apparence: { theme: "rose", accent: "pas-une-couleur", intensite: 500, onglets: [{ id: "activite", visible: false }] },
    })
  ).json().prefs;
  assert.deepEqual(r.reglages.reseau, { maison: "http://192.168.1.10:8080", tailscale: "", preferee: "auto" });
  assert.deepEqual(r.reglages.ordreServices, ["plex", "radarr", "sonarr", "overseerr", "qbittorrent", "prowlarr", "homarr"]);
  assert.equal(r.reglages.delaiHttpMs, 120000, "plafonné");
  assert.equal(r.reglages.masquerSuppression, false);
  assert.deepEqual(r.accueil.widgets.find((w: { id: string }) => w.id === "stockage"), { id: "stockage", visible: false }, "la première occurrence gagne");
  assert.equal(r.accueil.widgets.filter((w: { id: string }) => w.id === "stockage").length, 1);
  assert.equal(r.accueil.widgets.length, 12, "les widgets manquants sont ajoutés (Alertes en tête, les autres à la fin)");
  assert.equal(r.accueil.widgets[0].id, "alertes", "le widget Alertes apparaît en tête même avec des préférences déjà enregistrées");
  assert.deepEqual(r.actionsRapides.map((a: { id: string }) => a.id), ["a1", "a3", "a4"]);
  assert.equal(r.apparence.theme, "auto");
  assert.equal(r.apparence.accent, "#a78bfa");
  assert.equal(r.apparence.intensite, 100);
  assert.deepEqual(r.apparence.onglets[0], { id: "activite", visible: false });
  assert.equal(r.apparence.onglets.length, 8);
});

test("préférences : écrites dans un fichier, relues au redémarrage, aucun fichier temporaire oublié", async () => {
  const dossier = dossierTemp();
  const a = buildServer({ DATA_DIR: dossier });
  await put(a, { reglages: { delaiHttpMs: 30000, ordreServices: ["qbittorrent"] } });
  assert.deepEqual(readdirSync(dossier), ["prefs.json"]);
  assert.equal(JSON.parse(readFileSync(join(dossier, "prefs.json"), "utf8")).reglages.delaiHttpMs, 30000);
  const b = buildServer({ DATA_DIR: dossier });
  const r = (await b.inject({ url: "/api/prefs" })).json().prefs;
  assert.equal(r.reglages.delaiHttpMs, 30000);
  assert.equal(r.reglages.ordreServices[0], "qbittorrent");
});

test("préférences : fichier abîmé → valeurs par défaut, pas de plantage", async () => {
  const dossier = dossierTemp();
  writeFileSync(join(dossier, "prefs.json"), "{pas du json", "utf8");
  const r = (await buildServer({ DATA_DIR: dossier }).inject({ url: "/api/prefs" })).json();
  assert.equal(r.prefs.reglages.delaiHttpMs, 15000);
});

test("préférences : sans volume, repli local et avertissement visible ; écriture impossible → avertissement", async () => {
  if (!existsSync("/data")) {
    const r = (await buildServer({}).inject({ url: "/api/prefs" })).json();
    assert.equal(r.stockage.persistant, false);
    assert.match(r.stockage.avertissement, /Aucun volume monté sur \/data/);
  }
  const fichier = join(dossierTemp(), "pas-un-dossier");
  writeFileSync(fichier, "x");
  const app = buildServer({ DATA_DIR: join(fichier, "sous-dossier") });
  const r = (await put(app, { reglages: { delaiHttpMs: 20000 } })).json();
  assert.equal(r.stockage.persistant, false);
  assert.match(r.stockage.avertissement, /Impossible d'écrire/);
  assert.equal(r.prefs.reglages.delaiHttpMs, 20000, "elles restent utilisables en mémoire");
});

test("préférences : écriture protégée (en-tête, jeton, corps valide) ; l'état du jeton est indiqué sans le dévoiler", async () => {
  const app = buildServer({ DATA_DIR: dossierTemp(), ACCESS_TOKEN: "abc-secret" });
  assert.equal((await app.inject({ url: "/api/prefs" })).statusCode, 401);
  const en = { authorization: "Bearer abc-secret" };
  const lecture = await app.inject({ url: "/api/prefs", headers: en });
  assert.equal(lecture.json().jetonActif, true);
  assert.ok(!lecture.body.includes("abc-secret"));
  assert.equal((await app.inject({ method: "PUT", url: "/api/prefs", headers: en, payload: "{}" })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/prefs", headers: { ...MARQUE, ...en }, payload: "pas du json" })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/prefs", headers: { ...MARQUE, ...en }, payload: "{}" })).statusCode, 200);
});

// ---------- journal ----------

function fakeService(reponses: Record<string, number>) {
  const vues: string[] = [];
  const srv = http.createServer((req, res) => {
    vues.push(req.url ?? "");
    const statut = reponses[(req.url ?? "").split("?")[0]];
    if (statut === undefined) return void res.writeHead(404).end("{}");
    res.writeHead(statut, { "content-type": "application/json" }).end("[]");
  });
  return new Promise<{ url: string; vues: string[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, vues, close: () => srv.close() }),
    ),
  );
}

test("journal : erreurs serveur et accès refusé notés, 404 non ; jamais de clé ni de paramètres", async () => {
  const cle = "cle-radarr-tres-secrete";
  const r = await fakeService({ "/api/v3/movie": 500, "/api/v3/qualityprofile": 401 });
  const app = buildServer({ RADARR_URL: r.url, RADARR_API_KEY: cle, DATA_DIR: dossierTemp() });
  await app.inject({ url: "/api/bibliotheque" }); // /movie → 500
  await app.inject({ url: "/api/ajout/options/film" }); // /rootfolder → 404 (non noté), /qualityprofile → 401
  await app.inject({ url: `/api/image/radarr/MediaCover/1/poster.jpg?lastWrite=5&apikey=${cle}` });
  const res = await app.inject({ url: "/api/journal" });
  const items = res.json().items;
  assert.ok(items.some((i: { service: string; chemin: string; statut: number }) => i.service === "radarr" && i.chemin === "/movie" && i.statut === 500));
  assert.ok(items.some((i: { chemin: string; statut: number }) => i.chemin === "/qualityprofile" && i.statut === 401));
  assert.ok(!items.some((i: { statut: number }) => i.statut === 404), "un 404 n'est pas une connexion échouée");
  assert.ok(items.every((i: { chemin: string }) => !i.chemin.includes("?")));
  assert.ok(!res.body.includes(cle), "la clé n'apparaît jamais");
  r.close();
});

test("journal : service éteint noté (statut 0) via /api/health, doublons regroupés, effacement", async () => {
  const app = buildServer({ SONARR_URL: "http://127.0.0.1:1", SONARR_API_KEY: "cle-sonarr-secrete", DATA_DIR: dossierTemp() });
  await app.inject({ url: "/api/health" });
  await app.inject({ url: "/api/health" });
  const items = (await app.inject({ url: "/api/journal" })).json().items;
  assert.equal(items.length, 1, "même service, même chemin, même statut : une seule ligne");
  assert.equal(items[0].service, "sonarr");
  assert.equal(items[0].statut, 0);
  assert.equal(items[0].compteur, 2);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/journal" })).statusCode, 403, "effacer demande l'en-tête");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/journal", headers: MARQUE })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: "/api/journal" })).json().items, []);
});

test("journal : purger retire toute clé, y compris encodée dans une adresse", () => {
  const j = new Journal(["cle-secrete-1234", "mot de passe long"]);
  assert.equal(j.purger("GET /x?apikey=cle-secrete-1234&t=1"), "GET /x?apikey=***&t=1");
  assert.equal(j.purger("echec mot%20de%20passe%20long ou mot de passe long"), "echec *** ou ***");
  j.ajouter("radarr", "/movie?apikey=cle-secrete-1234", 500, "erreur cle-secrete-1234");
  const [e] = j.lister();
  assert.equal(e.chemin, "/movie");
  assert.equal(e.message, "erreur ***");
});

// ---------- demandes Overseerr ----------

function fakeOverseerr() {
  const recues: { method: string; url: string }[] = [];
  const demandes = [
    { id: 1, status: 1, type: "movie", is4k: false, createdAt: "2026-10-06T10:00:00Z", media: { tmdbId: 100 }, requestedBy: { displayName: "Alice" } },
    { id: 2, status: 3, type: "tv", is4k: true, createdAt: "2026-10-05T10:00:00Z", media: { tmdbId: 200 }, requestedBy: { username: "bob" }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 0 }] },
    { id: 3, status: 2, type: "movie", createdAt: "2026-10-04T10:00:00Z", media: { tmdbId: 999 }, requestedBy: { email: "c@x.org" } },
  ];
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    recues.push({ method: req.method ?? "", url });
    if (req.headers["x-api-key"] !== "k-over") return void res.writeHead(401).end();
    const json = (o: unknown, statut = 200) => void res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (url.startsWith("/api/v1/request?")) {
      const filtre = new URL(url, "http://x").searchParams.get("filter");
      return json({ results: filtre === "pending" ? demandes.filter((d) => d.status === 1) : filtre === "approved" ? demandes.filter((d) => d.status === 2) : demandes });
    }
    if (url === "/api/v1/request/count") return json({ pending: 3 });
    if (url === "/api/v1/movie/100") return json({ title: "Nuit Écarlate", releaseDate: "2026-03-04", posterPath: "/aaa.jpg" });
    if (url === "/api/v1/tv/200") return json({ name: "La Frontière", firstAirDate: "2025-01-01", posterPath: "/bbb.jpg" });
    if (url === "/api/v1/request/1/approve" && req.method === "POST") return json({});
    if (url === "/api/v1/request/2/decline" && req.method === "POST") return json({});
    if (url === "/api/v1/request/7/approve") return json({}, 404);
    if (url === "/api/v1/request/8/approve") return json({}, 403);
    return json({}, 404);
  });
  return new Promise<{ url: string; recues: typeof recues; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, recues, close: () => srv.close() }),
    ),
  );
}

test("demandes : liste normalisée avec titre, affiche, demandeur, saisons et statut en français", async () => {
  const o = await fakeOverseerr();
  const app = buildServer({ OVERSEERR_URL: o.url, OVERSEERR_API_KEY: "k-over", DATA_DIR: dossierTemp() });
  const { items } = (await app.inject({ url: "/api/demandes?filtre=toutes" })).json();
  assert.deepEqual(items.map((i: { id: number }) => i.id), [1, 2, 3]);
  const [a, b, c] = items;
  assert.equal(a.titre, "Nuit Écarlate");
  assert.equal(a.annee, 2026);
  assert.equal(a.statut, "en_attente");
  assert.equal(a.type, "film");
  assert.equal(a.demandeur, "Alice");
  assert.equal(a.affiche, `/image-externe?u=${encodeURIComponent("https://image.tmdb.org/t/p/w342/aaa.jpg")}`);
  assert.equal(b.statut, "refusee");
  assert.equal(b.type, "serie");
  assert.deepEqual(b.saisons, [1, 2], "la saison 0 est ignorée");
  assert.equal(b.quatreK, true);
  assert.equal(b.demandeur, "bob");
  assert.equal(c.titre, "Titre inconnu (TMDB 999)", "fiche introuvable : libellé honnête");
  assert.equal(c.demandeur, "c@x.org");
  const attente = (await app.inject({ url: "/api/demandes" })).json().items;
  assert.deepEqual(attente.map((i: { id: number }) => i.id), [1], "par défaut : en attente");
  const refusees = (await app.inject({ url: "/api/demandes?filtre=refusees" })).json().items;
  assert.deepEqual(refusees.map((i: { id: number }) => i.id), [2]);
  assert.equal((await app.inject({ url: "/api/demandes?filtre=n-importe-quoi" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/demandes/compteur" })).json().enAttente, 3);
  const accueil = (await app.inject({ url: "/api/accueil" })).json();
  assert.deepEqual(accueil.overseerr, { ok: true, enAttente: 3 });
  o.close();
});

test("demandes : approuver et refuser appellent Overseerr ; erreurs expliquées ; entrées validées", async () => {
  const o = await fakeOverseerr();
  const app = buildServer({ OVERSEERR_URL: o.url, OVERSEERR_API_KEY: "k-over", DATA_DIR: dossierTemp() });
  const post = (url: string, headers: Record<string, string> = MARQUE) => app.inject({ method: "POST", url, headers });
  assert.equal((await post("/api/demandes/1/approuver")).statusCode, 200);
  assert.equal((await post("/api/demandes/2/refuser")).statusCode, 200);
  assert.deepEqual(o.recues.filter((r) => r.method === "POST"), [
    { method: "POST", url: "/api/v1/request/1/approve" },
    { method: "POST", url: "/api/v1/request/2/decline" },
  ]);
  const absente = await post("/api/demandes/7/approuver");
  assert.equal(absente.statusCode, 404);
  assert.match(absente.json().error, /n'existe plus/);
  const interdit = await post("/api/demandes/8/approuver");
  assert.equal(interdit.statusCode, 403);
  assert.match(interdit.json().error, /droit/);
  assert.equal((await post("/api/demandes/1abc/approuver")).statusCode, 400);
  assert.equal((await post("/api/demandes/1/supprimer")).statusCode, 404);
  assert.equal((await post("/api/demandes/1/approuver", {})).statusCode, 403, "sans X-Requested-With");
  assert.equal((await buildServer({ DATA_DIR: dossierTemp() }).inject({ method: "POST", url: "/api/demandes/1/approuver", headers: MARQUE })).statusCode, 404);
  o.close();
});

// ---------- cache ----------

test("vider le cache : les listes sont redemandées au service, après confirmation par l'en-tête", async () => {
  const r = await fakeService({ "/api/v3/movie": 200, "/api/v3/series": 200 });
  const app = buildServer({ RADARR_URL: r.url, RADARR_API_KEY: "k", SONARR_URL: r.url, SONARR_API_KEY: "k", DATA_DIR: dossierTemp() });
  const compte = () => r.vues.filter((u) => u === "/api/v3/movie").length;
  await app.inject({ url: "/api/bibliotheque" });
  await app.inject({ url: "/api/bibliotheque" });
  assert.equal(compte(), 1, "la 2e lecture vient de la mémoire");
  assert.equal((await app.inject({ method: "POST", url: "/api/cache/vider" })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/cache/vider", headers: MARQUE })).statusCode, 200);
  await app.inject({ url: "/api/bibliotheque" });
  assert.equal(compte(), 2);
  r.close();
});

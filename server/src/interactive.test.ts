import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { languesDepuisTitre, resolutionDepuisTitre } from "./prowlarr.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-"));

type Reponse = { statut?: number; corps: unknown };
interface Faux {
  url: string;
  close: () => void;
  /** « METHODE chemin?requête » de chaque requête reçue, et le corps JSON des POST. */
  vus: string[];
  corps: unknown[];
}
function faux(routes: Record<string, Reponse | ((corps: unknown) => Reponse)>): Promise<Faux> {
  const vus: string[] = [];
  const corps: unknown[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      vus.push(`${req.method} ${req.url}`);
      let json: unknown;
      try {
        json = brut ? JSON.parse(brut) : undefined;
      } catch {
        json = undefined;
      }
      if (req.method === "POST") corps.push(json);
      const r = routes[`${req.method} ${(req.url ?? "").split("?")[0]}`];
      if (r === undefined) return void res.writeHead(404).end("{}");
      const rep = typeof r === "function" ? r(json) : r;
      res.writeHead(rep.statut ?? 200, { "content-type": "application/json" }).end(JSON.stringify(rep.corps));
    });
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), vus, corps })),
  );
}

const release = (o: Record<string, unknown>) => ({
  guid: "g1", indexerId: 3, title: "Sillage.S02.MULTi.1080p.WEB", indexer: "NZBgeek", protocol: "usenet", size: 40e9, age: 2,
  quality: { quality: { name: "WEBDL-1080p", resolution: 1080, source: "web" } }, languages: [{ name: "French" }, { name: "English" }],
  rejections: [], customFormatScore: 50, approved: true, downloadAllowed: true, fullSeason: true, ...o,
});

// ---------- saison, épisode, langues, indexeurs ----------

test("recherche de saison : /release?seriesId&seasonNumber, packs, résolution, langues, indexeurs ; l'épisode garde son chemin", async () => {
  const sonarr = await faux({
    "GET /api/v3/release": { corps: [
      release({ guid: "pack-fr", indexer: "NZBgeek" }),
      release({ guid: "pack-en", indexer: "Drunken", languages: [{ name: "English" }], quality: { quality: { name: "Bluray-2160p", resolution: 2160, source: "bluray" } } }),
      release({ guid: "rejet", indexer: "NZBgeek", rejected: true, rejections: [{ reason: "Quality profile does not allow upgrades" }] }),
    ] },
  });
  const app = buildServer({ SONARR_URL: sonarr.url, DATA_DIR: dossier() });
  const r = (await app.inject({ url: "/api/releases/saison/7/2" })).json();
  assert.ok(sonarr.vus.includes("GET /api/v3/release?seriesId=7&seasonNumber=2"), sonarr.vus.join(" | "));
  assert.equal(r.titre.statut, "inconnu", "pas d'état de titre pour une saison");
  assert.equal(r.items.length, 3);
  const fr = r.items.find((x: { guid: string }) => x.guid === "pack-fr");
  assert.equal(fr.pack, true);
  assert.equal(fr.resolution, 1080);
  assert.deepEqual(fr.langues, ["French", "English"]);
  assert.equal(r.items.find((x: { guid: string }) => x.guid === "pack-en").resolution, 2160);
  assert.deepEqual([...new Set(r.items.map((x: { indexeur: string }) => x.indexeur))].sort(), ["Drunken", "NZBgeek"]);
  const rejet = r.items.find((x: { guid: string }) => x.guid === "rejet");
  assert.equal(rejet.rejete, true);
  assert.ok(rejet.raisons.length >= 1);

  await app.inject({ url: "/api/releases/episode/55" });
  assert.ok(sonarr.vus.includes("GET /api/v3/release?episodeId=55"));
  sonarr.close();
});

test("recherche : requêtes invalides refusées (saison sans numéro, numéro hors saison, cible inconnue)", async () => {
  const sonarr = await faux({});
  const app = buildServer({ SONARR_URL: sonarr.url, DATA_DIR: dossier() });
  for (const url of ["/api/releases/saison/7", "/api/releases/episode/55/2", "/api/releases/saison/abc/1", "/api/releases/saison/7/x", "/api/releases/serie/7"]) {
    assert.equal((await app.inject({ url })).statusCode, 400, url);
  }
  sonarr.close();
});

// ---------- envoi au client de téléchargement ----------

test("envoi : guid + indexerId vers POST /release, nom du client, doublon refusé, protection jeton + X-Requested-With", async () => {
  const sonarr = await faux({
    "POST /api/v3/release": { corps: {} },
    "GET /api/v3/downloadclient": { corps: [{ name: "qBittorrent", protocol: "torrent", enable: true }, { name: "SABnzbd", protocol: "usenet", enable: true }] },
  });
  const app = buildServer({ SONARR_URL: sonarr.url, ACCESS_TOKEN: "jeton-app-12345", DATA_DIR: dossier() });
  const auth = { ...MARQUE, authorization: "Bearer jeton-app-12345" };
  const corps = JSON.stringify({ guid: "pack-fr", indexerId: 3, protocole: "torrent" });

  assert.equal((await app.inject({ method: "POST", url: "/api/releases/saison", headers: { authorization: "Bearer jeton-app-12345" }, payload: corps })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/releases/saison", headers: MARQUE, payload: corps })).statusCode, 401);
  assert.equal(sonarr.corps.length, 0, "rien n'est parti sans autorisation");

  const ok = await app.inject({ method: "POST", url: "/api/releases/saison", headers: auth, payload: corps });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true, client: "qBittorrent" });
  assert.deepEqual(sonarr.corps[0], { guid: "pack-fr", indexerId: 3 });

  const usenet = await app.inject({ method: "POST", url: "/api/releases/episode", headers: auth, payload: JSON.stringify({ guid: "nzb", indexerId: 4, protocole: "usenet" }) });
  assert.equal(usenet.json().client, "SABnzbd");

  const doublon = await app.inject({ method: "POST", url: "/api/releases/saison", headers: auth, payload: corps });
  assert.equal(doublon.statusCode, 409);
  assert.match(doublon.json().error, /déjà été envoyée/);
  assert.equal(sonarr.corps.length, 2, "le doublon n'est pas renvoyé à Sonarr");
  sonarr.close();
});

test("envoi : échec expliqué (refus de Sonarr traduit), résultat expiré (410), demande invalide (400), service éteint (502)", async () => {
  const sonarr = await faux({
    "POST /api/v3/release": (b) => {
      const guid = (b as { guid: string }).guid;
      if (guid === "expire") return { statut: 404, corps: {} };
      if (guid === "liste-noire") return { statut: 400, corps: [{ errorMessage: "Release is on the blocklist" }] };
      if (guid === "bizarre") return { statut: 500, corps: { message: "Disque plein sur le client secret-xyz-123" } };
      return { corps: {} };
    },
  });
  const app = buildServer({ SONARR_URL: sonarr.url, SONARR_API_KEY: "secret-xyz-123", DATA_DIR: dossier() });
  const post = (b: unknown, url = "/api/releases/episode") => app.inject({ method: "POST", url, headers: MARQUE, payload: JSON.stringify(b) });

  const expire = await post({ guid: "expire", indexerId: 1 });
  assert.equal(expire.statusCode, 410);
  const noire = await post({ guid: "liste-noire", indexerId: 1 });
  assert.equal(noire.statusCode, 502);
  assert.match(noire.json().error, /Sonarr a refusé le téléchargement : Release sur la liste noire/);
  const bizarre = await post({ guid: "bizarre", indexerId: 1 });
  assert.equal(bizarre.statusCode, 502);
  assert.match(bizarre.json().error, /Disque plein/);
  assert.ok(!bizarre.body.includes("secret-xyz-123"), "la clé est purgée de la cause");
  assert.equal((await post({ guid: "", indexerId: 1 })).statusCode, 400);
  assert.equal((await post({ guid: "x", indexerId: -2 })).statusCode, 400);
  assert.equal((await post({ guid: "x", indexerId: 1 }, "/api/releases/serie")).statusCode, 400);
  sonarr.close();

  const eteint = buildServer({ SONARR_URL: "http://127.0.0.1:1", DATA_DIR: dossier() });
  assert.equal((await eteint.inject({ method: "POST", url: "/api/releases/episode", headers: MARQUE, payload: JSON.stringify({ guid: "x", indexerId: 1 }) })).statusCode, 502);
});

test("film : Radarr reçoit l'envoi ; un échec d'un envoi ne bloque pas un autre résultat", async () => {
  const radarr = await faux({
    "POST /api/v3/release": (b) => ((b as { guid: string }).guid === "mauvais" ? { statut: 400, corps: [{ errorMessage: "Release in queue already" }] } : { corps: {} }),
    "GET /api/v3/downloadclient": { corps: [{ name: "qBittorrent", protocol: "torrent", enable: true }] },
  });
  const app = buildServer({ RADARR_URL: radarr.url, DATA_DIR: dossier() });
  const post = (guid: string) => app.inject({ method: "POST", url: "/api/releases/film", headers: MARQUE, payload: JSON.stringify({ guid, indexerId: 1 }) });
  const ko = await post("mauvais");
  assert.equal(ko.statusCode, 502);
  assert.match(ko.json().error, /Radarr a refusé le téléchargement : Déjà dans la file de téléchargement/);
  const ok = await post("bon");
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().client, "qBittorrent");
  radarr.close();
});

// ---------- Prowlarr : recherche et envoi ----------

test("Prowlarr : langues et résolution déduites du nom ; guid sûr seulement ; envoi via POST /search avec guid + indexerId", async () => {
  assert.deepEqual(languesDepuisTitre("Delta.2021.MULTi.TRUEFRENCH.1080p.BluRay.x264-GRP"), ["Français", "Multi"]);
  assert.deepEqual(languesDepuisTitre("Show.S01E01.VOSTFR.720p"), ["Français (sous-titres)"]);
  assert.deepEqual(languesDepuisTitre("Movie 2020 ENGLISH 2160p"), ["Anglais"]);
  assert.deepEqual(languesDepuisTitre("Movie.2020.1080p.WEB-DL"), []);
  assert.equal(resolutionDepuisTitre("Movie.2020.2160p.UHD"), 2160);
  assert.equal(resolutionDepuisTitre("Movie 4K HDR"), 2160);
  assert.equal(resolutionDepuisTitre("Movie 720p"), 720);
  assert.equal(resolutionDepuisTitre("Movie DVDRip"), null);

  const prowlarr = await faux({
    "GET /api/v1/search": { corps: [
      { guid: "https://indexeur.test/torrent/1", indexerId: 5, title: "Delta.2021.MULTi.1080p", indexer: "YggTest", protocol: "torrent", size: 9e9, seeders: 40, leechers: 3, ageMinutes: 120, categories: [{ name: "Movies" }] },
      { guid: "https://indexeur.test/dl?apikey=cle-prowlarr-secrete", indexerId: 6, title: "Delta.2021.720p", indexer: "Autre", protocol: "torrent", size: 3e9, seeders: 1, leechers: 0, ageMinutes: 60, categories: [] },
    ] },
    "POST /api/v1/search": { corps: {} },
    "GET /api/v1/downloadclient": { corps: [{ name: "qBittorrent", enable: true }] },
  });
  const app = buildServer({ PROWLARR_URL: prowlarr.url, PROWLARR_API_KEY: "cle-prowlarr-secrete", DATA_DIR: dossier() });
  const r = (await app.inject({ url: "/api/indexeurs/recherche?q=delta" })).json();
  assert.deepEqual(r.items[0].langues, ["Multi"]);
  assert.equal(r.items[0].resolution, 1080);
  assert.equal(r.items[0].guid, "https://indexeur.test/torrent/1");
  assert.equal(r.items[0].indexerId, 5);
  assert.equal(r.items[1].guid, null, "un guid qui contient la clé n'est jamais renvoyé");
  assert.equal(r.items[1].indexerId, null);
  assert.ok(!JSON.stringify(r).includes("cle-prowlarr-secrete"));

  const envoi = (b: unknown, headers: Record<string, string> = MARQUE) => app.inject({ method: "POST", url: "/api/indexeurs/envoyer", headers, payload: JSON.stringify(b) });
  assert.equal((await envoi({ guid: "g", indexerId: 5 }, { "content-type": "application/json" })).statusCode, 403);
  assert.equal((await envoi({ guid: "", indexerId: 5 })).statusCode, 400);
  assert.equal(prowlarr.corps.length, 0);
  const ok = await envoi({ guid: "https://indexeur.test/torrent/1", indexerId: 5 });
  assert.deepEqual(ok.json(), { ok: true, client: "qBittorrent" });
  assert.deepEqual(prowlarr.corps[0], { guid: "https://indexeur.test/torrent/1", indexerId: 5 });
  const doublon = await envoi({ guid: "https://indexeur.test/torrent/1", indexerId: 5 });
  assert.equal(doublon.statusCode, 409);
  assert.equal(prowlarr.corps.length, 1);
  prowlarr.close();
});

test("Prowlarr : refus à l'envoi expliqué sans secret ; Prowlarr absent → 404", async () => {
  const prowlarr = await faux({ "POST /api/v1/search": { statut: 400, corps: [{ errorMessage: "No download client available (cle-prowlarr-secrete)" }] } });
  const app = buildServer({ PROWLARR_URL: prowlarr.url, PROWLARR_API_KEY: "cle-prowlarr-secrete", DATA_DIR: dossier() });
  const r = await app.inject({ method: "POST", url: "/api/indexeurs/envoyer", headers: MARQUE, payload: JSON.stringify({ guid: "g", indexerId: 1 }) });
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /Prowlarr a refusé l'envoi : No download client available/);
  assert.ok(!r.body.includes("cle-prowlarr-secrete"));
  prowlarr.close();
  const sans = buildServer({ DATA_DIR: dossier() });
  assert.equal((await sans.inject({ method: "POST", url: "/api/indexeurs/envoyer", headers: MARQUE, payload: JSON.stringify({ guid: "g", indexerId: 1 }) })).statusCode, 404);
});

// ---------- Activité : torrent à problème → film / épisode ----------

test("activité : un torrent « fichiers manquants » est relié au film / à l'épisode d'après la file de Radarr et Sonarr", async () => {
  const qbit = http.createServer((req, res) => {
    if (req.url === "/api/v2/auth/login") return void res.writeHead(200, { "set-cookie": "SID=abc; Path=/" }).end("Ok.");
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/v2/transfer/info")) return void res.end(JSON.stringify({ dl_info_speed: 0, up_info_speed: 0 }));
    if (req.url?.startsWith("/api/v2/torrents/info"))
      return void res.end(JSON.stringify([
        { hash: "AAA111", name: "Film.Perdu", state: "missingFiles", progress: 0.5, size: 100, dlspeed: 0, eta: 8640000 },
        { hash: "BBB222", name: "Serie.S01E02", state: "missingFiles", progress: 0.2, size: 100, dlspeed: 0, eta: 8640000 },
        { hash: "CCC333", name: "Sain", state: "downloading", progress: 0.2, size: 100, dlspeed: 10, eta: 100 },
      ]));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((ok) => qbit.listen(0, "127.0.0.1", () => ok()));
  const qurl = `http://127.0.0.1:${(qbit.address() as AddressInfo).port}`;
  const radarr = await faux({ "GET /api/v3/queue": { corps: { records: [{ downloadId: "AAA111", movieId: 9, movie: { title: "Film Perdu" } }] } } });
  const sonarr = await faux({ "GET /api/v3/queue": { corps: { records: [{ downloadId: "BBB222", episodeId: 55, seriesId: 7, series: { title: "Sillage" }, episode: { seasonNumber: 1, episodeNumber: 2 } }] } } });
  const app = buildServer({ QBIT_URL: qurl, QBIT_USER: "u", QBIT_PASS: "p", RADARR_URL: radarr.url, SONARR_URL: sonarr.url, DATA_DIR: dossier() });
  const { items } = (await app.inject({ url: "/api/activite" })).json();
  const film = items.find((i: { hash: string }) => i.hash === "AAA111");
  const ep = items.find((i: { hash: string }) => i.hash === "BBB222");
  const sain = items.find((i: { hash: string }) => i.hash === "CCC333");
  assert.deepEqual(film.lien, { cible: "film", id: 9, titre: "Film Perdu" });
  assert.deepEqual(ep.lien, { cible: "episode", id: 55, titre: "Sillage · S01E02" });
  assert.equal(sain.lien, null);
  qbit.close();
  radarr.close();
  sonarr.close();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

type Handler = (url: string, req: http.IncomingMessage) => unknown;

/** Faux service HTTP : `handler` renvoie le JSON (ou une chaîne brute) pour une URL, ou undefined → 404. */
function fake(handler: Handler, extraHeaders: Record<string, string> = {}) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const out = handler(req.url ?? "", req);
    if (out === undefined) return void res.writeHead(404).end("{}");
    res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
    res.end(typeof out === "string" ? out : JSON.stringify(out));
  });
  return new Promise<{ url: string; seen: string[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        seen,
        close: () => srv.close(),
      }),
    ),
  );
}

const poster = (u: string) => [{ coverType: "poster", url: u }];

const MOVIES = [
  {
    id: 1, title: "Nuit Écarlate", year: 2026, hasFile: true, monitored: true, runtime: 118,
    overview: "Une enquêtrice…", genres: ["Thriller"], images: poster("/radarr/MediaCover/1/poster.jpg?lastWrite=1"),
    movieFile: { quality: { quality: { name: "Bluray-1080p" } } }, sizeOnDisk: 9_400_000_000,
    path: "/films/Nuit", studio: "Studio X", ratings: { tmdb: { value: 7.4 } },
  },
  { id: 2, title: "Sables d'Argent", year: 2024, hasFile: false, monitored: true, images: [], sizeOnDisk: 0 },
];
const SERIES = [
  {
    id: 7, title: "La Frontière", year: 2025, monitored: true, network: "Chaîne 1",
    statistics: { episodeCount: 10, episodeFileCount: 4, percentOfEpisodes: 40, sizeOnDisk: 5_000_000_000 },
    seasons: [
      { seasonNumber: 0, monitored: false, statistics: {} },
      { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 4, totalEpisodeCount: 10 } },
    ],
    images: poster("/MediaCover/7/poster.jpg?lastWrite=2"),
  },
];

function radarr() {
  return fake((url, req) => {
    if (req.headers["x-api-key"] !== "k-radarr") return undefined;
    if (url === "/api/v3/movie") return MOVIES;
    if (url === "/api/v3/movie/1") return MOVIES[0];
    if (url.startsWith("/api/v3/history")) {
      const importes = [
        { id: 11, eventType: "downloadFolderImported", sourceTitle: "Nuit.Ecarlate.2026.1080p", movieId: 1, date: "2026-10-05T10:00:00Z", movie: MOVIES[0],
          quality: { quality: { name: "WEBDL-1080p" } }, customFormatScore: 0, languages: [{ name: "English" }],
          data: { releaseGroup: "BYNDR", downloadClientName: "qBittorrent" } },
        { id: 10, eventType: "downloadFolderImported", movieId: 1, date: "2026-10-01T10:00:00Z", movie: MOVIES[0] },
      ];
      if (url.includes("eventType=3")) return { records: importes };
      return {
        records: [
          ...importes,
          { id: 12, eventType: "grabbed", sourceTitle: "Nuit.Ecarlate.2026.REPACK", movieId: 1, date: "2026-10-04T09:00:00Z", movie: MOVIES[0], customFormatScore: 15 },
          { id: 13, eventType: "movieFileDeleted", movieId: 2, date: "2026-10-03T09:00:00Z", movie: MOVIES[1] },
        ],
      };
    }
    if (url.startsWith("/api/v3/calendar"))
      return [{ id: 2, title: "Sables d'Argent", digitalRelease: "2026-10-09T00:00:00Z", hasFile: false, monitored: true }];
    return undefined;
  });
}
function sonarr() {
  return fake((url, req) => {
    if (req.headers["x-api-key"] !== "k-sonarr") return undefined;
    if (url === "/api/v3/series") return SERIES;
    if (url === "/api/v3/series/7") return SERIES[0];
    if (url.startsWith("/api/v3/history"))
      return {
        records: [
          {
            id: 21,
            eventType: url.includes("eventType=3") ? "downloadFolderImported" : "downloadFailed",
            sourceTitle: "La.Frontiere.S01E05",
            seriesId: 7,
            date: "2026-10-06T08:00:00Z",
            series: SERIES[0],
            episode: { seasonNumber: 1, episodeNumber: 5 },
          },
        ],
      };
    if (url.startsWith("/api/v3/calendar"))
      return [
        {
          seriesId: 7, title: "Pilote", seasonNumber: 2, episodeNumber: 1,
          airDateUtc: "2026-10-08T19:00:00Z", hasFile: false, monitored: true,
          series: { title: "La Frontière", images: poster("/MediaCover/7/poster.jpg?lastWrite=2") },
        },
      ];
    return undefined;
  });
}
function qbit() {
  return fake(
    (url) => {
      if (url === "/api/v2/auth/login") return "Ok.";
      if (url === "/api/v2/app/version") return "v5.0.0";
      if (url === "/api/v2/transfer/info") return { dl_info_speed: 13_000_000, up_info_speed: 1_800_000 };
      if (url === "/api/v2/torrents/info?filter=downloading")
        return [
          { name: "lent", dlspeed: 10, progress: 0.1, eta: 8_640_000 },
          { name: "Sillage.S03E04", dlspeed: 9000, progress: 0.64, eta: 34 },
        ];
      if (url.startsWith("/api/v2/torrents/info?filter=all"))
        return [
          { hash: "h1", name: "Sillage.S03E04", state: "downloading", progress: 0.64, dlspeed: 9000, eta: 34, size: 1000, downloaded: 640, category: "tv" },
          { hash: "h2", name: "Bloqué", state: "stalledDL", progress: 0.2, dlspeed: 0, eta: 8_640_000, size: 500, category: "movies" },
          { hash: "h3", name: "Fini", state: "uploading", progress: 1, dlspeed: 0, eta: 8_640_000, size: 700 },
        ];
      return undefined;
    },
    { "set-cookie": "SID=abc; HttpOnly" },
  );
}
function plex() {
  return fake((url) => {
    if (url === "/identity") return { MediaContainer: { version: "1.40" } };
    if (url === "/status/sessions")
      return {
        MediaContainer: {
          Metadata: [
            {
              title: "Pilote", grandparentTitle: "Foundation", parentIndex: 3, index: 5,
              User: { title: "moi" }, Player: { title: "iPhone", state: "playing" },
              Session: { location: "lan" }, Media: [{ videoResolution: "1080" }],
              grandparentThumb: "/library/metadata/9/thumb/1",
            },
            {
              title: "Film", User: { title: "ami" }, Player: { title: "TV", state: "paused" },
              Session: { location: "wan" }, TranscodeSession: { videoDecision: "transcode" },
            },
          ],
        },
      };
    return undefined;
  });
}

async function setup() {
  const [r, s, q, p] = await Promise.all([radarr(), sonarr(), qbit(), plex()]);
  const app = buildServer({
    RADARR_URL: r.url, RADARR_API_KEY: "k-radarr",
    SONARR_URL: s.url, SONARR_API_KEY: "k-sonarr",
    QBIT_URL: q.url, QBIT_USER: "u", QBIT_PASS: "p",
    PLEX_URL: p.url, PLEX_TOKEN: "t",
  });
  return { app, r, s, q, p, close: () => [r, s, q, p].forEach((x) => x.close()) };
}

test("santé : la version qBittorrent n'a pas de « v » en double", async () => {
  const t = await setup();
  const { services } = (await t.app.inject({ url: "/api/health" })).json();
  const qb = services.find((x: { id: string }) => x.id === "qbittorrent");
  assert.equal(qb.ok, true);
  assert.equal(qb.version, "5.0.0");
  t.close();
});

test("accueil : compteurs, vitesse qBittorrent et flux Plex", async () => {
  const t = await setup();
  const a = (await t.app.inject({ url: "/api/accueil" })).json();
  assert.deepEqual(a.films, { ok: true, total: 2, disponibles: 1, tailleOctets: 9_400_000_000 });
  assert.deepEqual(a.series, {
    ok: true, total: 1, episodes: 4, episodesTotal: 10, tailleOctets: 5_000_000_000,
  });
  assert.equal(a.qbit.telechargement, 13_000_000);
  assert.equal(a.qbit.actifs, 2);
  assert.deepEqual(a.qbit.principal, { nom: "Sillage.S03E04", progression: 0.64, resteSec: 34 });
  assert.equal(a.plex.lectures.length, 2);
  assert.equal(a.plex.lectures[0].titre, "Foundation · S03E05");
  assert.equal(a.plex.lectures[0].local, true);
  assert.equal(a.plex.lectures[0].affiche, "/image/plex/library/metadata/9/thumb/1");
  assert.equal(a.plex.lectures[1].affiche, null);
  assert.equal(a.plex.lectures[1].transcode, true);
  assert.equal(a.plex.lectures[1].local, false);
  t.close();
});

test("accueil : service absent omis, service en panne signalé sans tout casser", async () => {
  const app = buildServer({ RADARR_URL: "http://127.0.0.1:1", RADARR_API_KEY: "x" });
  const a = (await app.inject({ url: "/api/accueil" })).json();
  assert.equal(a.films.ok, false);
  assert.equal(a.series, undefined);
  assert.equal(a.plex, undefined);
});

test("bibliothèque : films et séries normalisés, triés, sans clé", async () => {
  const t = await setup();
  const res = await t.app.inject({ url: "/api/bibliotheque" });
  assert.ok(!res.body.includes("k-radarr"));
  const { items, erreurs } = res.json();
  assert.deepEqual(erreurs, []);
  assert.deepEqual(items.map((i: { titre: string }) => i.titre), ["La Frontière", "Nuit Écarlate", "Sables d'Argent"]);
  const nuit = items.find((i: { id: number; type: string }) => i.type === "film" && i.id === 1);
  assert.equal(nuit.etat, "complet");
  assert.equal(nuit.qualite, "Bluray-1080p");
  assert.equal(nuit.affiche, "/image/radarr/MediaCover/1/poster.jpg?lastWrite=1");
  assert.equal(items.find((i: { type: string }) => i.type === "serie").etat, "partiel");
  assert.equal(items.find((i: { id: number; type: string }) => i.type === "film" && i.id === 2).etat, "manquant");
  t.close();
});

test("bibliothèque : un service en panne n'empêche pas l'autre", async () => {
  const r = await radarr();
  const app = buildServer({
    RADARR_URL: r.url, RADARR_API_KEY: "k-radarr",
    SONARR_URL: "http://127.0.0.1:1", SONARR_API_KEY: "x",
  });
  const body = (await app.inject({ url: "/api/bibliotheque" })).json();
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.erreurs, ["Sonarr injoignable"]);
  r.close();
});

test("détail : film, série, et paramètres invalides refusés", async () => {
  const t = await setup();
  const f = (await t.app.inject({ url: "/api/detail/film/1" })).json();
  assert.equal(f.titre, "Nuit Écarlate");
  assert.equal(f.tailleOctets, 9_400_000_000);
  assert.deepEqual(f.note, { valeur: 7.4, votes: null, source: "tmdb" });
  assert.equal(f.studio, "Studio X");
  const s = (await t.app.inject({ url: "/api/detail/serie/7" })).json();
  assert.equal(s.saisons.length, 1); // la saison 0 (hors-séries) est ignorée
  assert.deepEqual(s.saisons[0], { numero: 1, episodes: 4, total: 10, suivi: true });
  assert.equal((await t.app.inject({ url: "/api/detail/film/1abc" })).statusCode, 400);
  assert.equal((await t.app.inject({ url: "/api/detail/film/..%2Fx" })).statusCode, 400);
  assert.equal((await t.app.inject({ url: "/api/detail/musique/1" })).statusCode, 400);
  t.close();
});

test("calendrier : fusionne films et épisodes, trie par date, valide la date", async () => {
  const t = await setup();
  const res = await t.app.inject({ url: "/api/calendrier?debut=2026-10-05&jours=7" });
  const { items } = res.json();
  assert.deepEqual(items.map((i: { titre: string }) => i.titre), ["La Frontière", "Sables d'Argent"]);
  assert.equal(items[0].sousTitre, "S02E01");
  assert.equal(items[0].heure, true);
  assert.equal(items[1].sousTitre, "Sortie numérique");
  assert.equal(items[1].heure, false);
  assert.ok(t.r.seen.includes("GET /api/v3/calendar?start=2026-10-05&end=2026-10-11"));
  assert.equal((await t.app.inject({ url: "/api/calendrier?debut=pas-une-date" })).statusCode, 400);
  t.close();
});

test("derniers téléchargements : fusionnés, un par titre, du plus récent au plus ancien", async () => {
  const t = await setup();
  const { items, erreurs } = (await t.app.inject({ url: "/api/telechargements" })).json();
  assert.deepEqual(erreurs, []);
  assert.deepEqual(items.map((i: { titre: string }) => i.titre), ["La Frontière", "Nuit Écarlate"]); // le film une seule fois
  assert.equal(items[0].sousTitre, "S01E05");
  assert.equal(items[1].date, "2026-10-05T10:00:00Z");
  assert.equal(items[1].affiche, "/image/radarr/MediaCover/1/poster.jpg?lastWrite=1");
  assert.ok(t.r.seen.some((u) => u.includes("eventType=3") && u.includes("includeMovie=true")));
  t.close();
});

test("historique : Radarr et Sonarr fusionnés, états français, détails de la release", async () => {
  const t = await setup();
  const { items, erreurs } = (await t.app.inject({ url: "/api/historique" })).json();
  assert.deepEqual(erreurs, []);
  assert.deepEqual(
    items.map((i: { id: string }) => i.id),
    ["sonarr-21", "radarr-11", "radarr-12", "radarr-13", "radarr-10"], // du plus récent au plus ancien
  );
  assert.deepEqual(items.map((i: { etat: { libelle: string } }) => i.etat.libelle), ["Échec", "Importé", "Récupéré", "Supprimé", "Importé"]);
  const imp = items.find((i: { id: string }) => i.id === "radarr-11");
  assert.equal(imp.titre, "Nuit Écarlate");
  assert.equal(imp.release, "Nuit.Ecarlate.2026.1080p");
  assert.equal(imp.qualite, "WEBDL-1080p");
  assert.equal(imp.score, 0);
  assert.equal(imp.langue, "English");
  assert.equal(imp.groupe, "BYNDR");
  assert.equal(imp.client, "qBittorrent");
  assert.equal(imp.mediaId, 1);
  assert.equal(imp.affiche, "/image/radarr/MediaCover/1/poster.jpg?lastWrite=1");
  const grab = items.find((i: { id: string }) => i.id === "radarr-12");
  assert.equal(grab.score, 15);
  assert.equal(grab.client, null);
  assert.equal(items[0].sousTitre, "S01E05");
  assert.equal(items[0].type, "serie");
  t.close();
});

test("historique : un service en panne n'empêche pas l'autre", async () => {
  const r = await radarr();
  const app = buildServer({ RADARR_URL: r.url, RADARR_API_KEY: "k-radarr", SONARR_URL: "http://127.0.0.1:1", SONARR_API_KEY: "x" });
  const body = (await app.inject({ url: "/api/historique" })).json();
  assert.equal(body.items.length, 4);
  assert.deepEqual(body.erreurs, ["Sonarr injoignable"]);
  r.close();
});

test("activité : file qBittorrent sans les torrents terminés, états en français", async () => {
  const t = await setup();
  const a = (await t.app.inject({ url: "/api/activite" })).json();
  assert.deepEqual(a.items.map((i: { nom: string }) => i.nom), ["Sillage.S03E04", "Bloqué"]);
  assert.equal(a.items[0].etat.libelle, "Téléchargement");
  assert.equal(a.items[0].resteSec, 34);
  assert.equal(a.items[1].etat.libelle, "En attente de pairs");
  assert.equal(a.items[1].etat.attention, true);
  assert.equal(a.items[1].resteSec, null);
  assert.equal(a.telechargement, 13_000_000);
  t.close();
  const vide = buildServer({});
  assert.equal((await vide.inject({ url: "/api/activite" })).statusCode, 404);
});

test("jeton d'accès : les nouvelles routes sont protégées aussi", async () => {
  const app = buildServer({ ACCESS_TOKEN: "abc" });
  for (const url of [
    "/api/accueil", "/api/bibliotheque", "/api/detail/film/1", "/api/calendrier",
    "/api/telechargements", "/api/historique", "/api/activite", "/api/image/radarr/MediaCover/1/poster.jpg",
  ]) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
  }
});

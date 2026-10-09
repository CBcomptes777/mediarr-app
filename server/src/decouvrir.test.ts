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

type Reponse = { statut?: number; corps: unknown };
interface Faux {
  url: string;
  close: () => void;
  vus: string[];
  posts: unknown[];
}
function faux(routes: Record<string, Reponse | ((corps: unknown) => Reponse)>): Promise<Faux> {
  const vus: string[] = [];
  const posts: unknown[] = [];
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
      if (req.method === "POST") posts.push(json);
      const r = routes[`${req.method} ${(req.url ?? "").split("?")[0]}`];
      if (r === undefined) return void res.writeHead(404).end("{}");
      const rep = typeof r === "function" ? r(json) : r;
      res.writeHead(rep.statut ?? 200, { "content-type": "application/json" }).end(JSON.stringify(rep.corps));
    });
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), vus, posts })),
  );
}

const film = (id: number, titre: string, o: Record<string, unknown> = {}) => ({
  id, mediaType: "movie", title: titre, releaseDate: "2024-05-01", posterPath: `/p${id}.jpg`, voteAverage: 7.46, overview: "Résumé", ...o,
});
const serie = (id: number, nom: string, o: Record<string, unknown> = {}) => ({
  id, mediaType: "tv", name: nom, firstAirDate: "2022-02-18", posterPath: `/s${id}.jpg`, voteAverage: 8.7, overview: "Résumé série", ...o,
});

// ---------- rangées et statuts croisés ----------

test("rangées : personnes ignorées, affiche relayée, note arrondie, statut croisé avec Overseerr ET la bibliothèque", async () => {
  const overseerr = await faux({
    "GET /api/v1/discover/trending": { corps: { page: 1, totalPages: 7, results: [
      film(1, "Disponible", { mediaInfo: { status: 5 } }),
      film(2, "Partiel", { mediaInfo: { status: 4 } }),
      film(3, "Demandé", { mediaInfo: { status: 2 } }),
      film(4, "En traitement", { mediaInfo: { status: 3 } }),
      film(5, "Inconnu côté Overseerr", { mediaInfo: { status: 1 } }),
      film(6, "Dans Radarr avec fichier"),
      film(7, "Dans Radarr sans fichier"),
      film(8, "Rien du tout"),
      serie(20, "Série Sonarr tmdb"),
      serie(21, "Série Sonarr tvdb", { mediaInfo: { status: 1, tvdbId: 5555 } }),
      serie(22, "Série partielle"),
      { id: 99, mediaType: "person", name: "Acteur" },
    ] } },
  });
  const radarr = await faux({ "GET /api/v3/movie": { corps: [{ id: 1, tmdbId: 6, hasFile: true }, { id: 2, tmdbId: 7, hasFile: false }] } });
  const sonarr = await faux({ "GET /api/v3/series": { corps: [
    { id: 1, tmdbId: 20, tvdbId: 1, statistics: { episodeCount: 10, episodeFileCount: 10 } },
    { id: 2, tmdbId: 0, tvdbId: 5555, statistics: { episodeCount: 8, episodeFileCount: 0 } },
    { id: 3, tmdbId: 22, tvdbId: 3, statistics: { episodeCount: 8, episodeFileCount: 3 } },
  ] } });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, RADARR_URL: radarr.url, SONARR_URL: sonarr.url, DATA_DIR: dossier() });
  const r = (await app.inject({ url: "/api/decouvrir/liste?rangee=tendances" })).json();
  assert.equal(r.pages, 7);
  assert.equal(r.items.length, 11, "la personne est ignorée");
  const statut = (titre: string) => r.items.find((i: { titre: string }) => i.titre === titre).statut;
  assert.equal(statut("Disponible"), "disponible");
  assert.equal(statut("Partiel"), "partiel");
  assert.equal(statut("Demandé"), "demande");
  assert.equal(statut("En traitement"), "demande");
  assert.equal(statut("Inconnu côté Overseerr"), null);
  assert.equal(statut("Dans Radarr avec fichier"), "disponible");
  assert.equal(statut("Dans Radarr sans fichier"), "bibliotheque");
  assert.equal(statut("Rien du tout"), null);
  assert.equal(statut("Série Sonarr tmdb"), "disponible");
  assert.equal(statut("Série Sonarr tvdb"), "bibliotheque", "reconnue par son identifiant TVDB");
  assert.equal(statut("Série partielle"), "partiel");
  const d = r.items[0];
  assert.equal(d.type, "film");
  assert.equal(d.annee, 2024);
  assert.equal(d.note, 7.5);
  assert.match(d.affiche, /^\/image-externe\?u=/);
  assert.ok(decodeURIComponent(d.affiche).includes("image.tmdb.org/t/p/w342/p1.jpg"));
  assert.ok(overseerr.vus.includes("GET /api/v1/discover/trending?page=1&language=fr"));
  overseerr.close(); radarr.close(); sonarr.close();
});

test("rangées : chaque rangée appelle la bonne route Overseerr ; paramètres invalides refusés ; Radarr éteint n'empêche rien", async () => {
  const overseerr = await faux({
    "GET /api/v1/discover/movies": { corps: { page: 1, totalPages: 1, results: [{ id: 1, title: "Sans mediaType", releaseDate: "2020-01-01" }] } },
    "GET /api/v1/discover/tv": { corps: { page: 2, totalPages: 3, results: [{ id: 2, name: "Série sans mediaType", firstAirDate: "2021-01-01" }] } },
    "GET /api/v1/discover/movies/upcoming": { corps: { page: 1, totalPages: 1, results: [] } },
    "GET /api/v1/discover/tv/upcoming": { corps: { page: 1, totalPages: 1, results: [] } },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, RADARR_URL: "http://127.0.0.1:1", DATA_DIR: dossier() });
  const films = (await app.inject({ url: "/api/decouvrir/liste?rangee=films&page=1" })).json();
  assert.equal(films.items[0].type, "film", "le type vient de la rangée quand mediaType manque");
  const series = (await app.inject({ url: "/api/decouvrir/liste?rangee=series&page=2" })).json();
  assert.equal(series.items[0].type, "serie");
  assert.equal(series.page, 2);
  for (const rangee of ["films-avenir", "series-avenir"]) assert.equal((await app.inject({ url: `/api/decouvrir/liste?rangee=${rangee}` })).statusCode, 200);
  assert.ok(overseerr.vus.includes("GET /api/v1/discover/movies/upcoming?page=1&language=fr"));
  assert.ok(overseerr.vus.includes("GET /api/v1/discover/tv?page=2&language=fr"));

  for (const url of ["/api/decouvrir/liste?rangee=bidon", "/api/decouvrir/liste", "/api/decouvrir/liste?type=film&genre=abc", "/api/decouvrir/liste?type=film&annee=1850", "/api/decouvrir/liste?type=livre"]) {
    assert.equal((await app.inject({ url })).statusCode, 400, url);
  }
  overseerr.close();
});

test("liste filtrée : genre + année transmis à Overseerr (films : dates de sortie, séries : dates de diffusion)", async () => {
  const overseerr = await faux({
    "GET /api/v1/discover/movies": { corps: { page: 1, totalPages: 1, results: [film(1, "Drame 2024")] } },
    "GET /api/v1/discover/tv": { corps: { page: 1, totalPages: 1, results: [] } },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, DATA_DIR: dossier() });
  const f = (await app.inject({ url: "/api/decouvrir/liste?type=film&genre=18&annee=2024" })).json();
  assert.equal(f.items.length, 1);
  assert.ok(overseerr.vus.includes("GET /api/v1/discover/movies?page=1&language=fr&genre=18&primaryReleaseDateGte=2024-01-01&primaryReleaseDateLte=2024-12-31"), overseerr.vus.join(" | "));
  await app.inject({ url: "/api/decouvrir/liste?type=serie&annee=2023" });
  assert.ok(overseerr.vus.includes("GET /api/v1/discover/tv?page=1&language=fr&firstAirDateGte=2023-01-01&firstAirDateLte=2023-12-31"));
  overseerr.close();
});

test("genres et recherche", async () => {
  const overseerr = await faux({
    "GET /api/v1/genres/movie": { corps: [{ id: 18, name: "Drame" }, { id: 28, name: "Action" }] },
    "GET /api/v1/genres/tv": { corps: [{ id: 10759, name: "Action & Aventure" }] },
    "GET /api/v1/search": { corps: { page: 1, totalPages: 1, results: [film(1, "Delta"), { id: 5, mediaType: "person", name: "Delta Person" }] } },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, DATA_DIR: dossier() });
  const g = (await app.inject({ url: "/api/decouvrir/genres" })).json();
  assert.deepEqual(g.films, [{ id: 18, nom: "Drame" }, { id: 28, nom: "Action" }]);
  assert.deepEqual(g.series, [{ id: 10759, nom: "Action & Aventure" }]);
  const s = (await app.inject({ url: "/api/decouvrir/recherche?q=delta%20partie" })).json();
  assert.equal(s.items.length, 1);
  assert.ok(overseerr.vus.includes("GET /api/v1/search?query=delta%20partie&page=1&language=fr"));
  assert.equal((await app.inject({ url: "/api/decouvrir/recherche?q=d" })).statusCode, 400);
  overseerr.close();
});

// ---------- fiche ----------

test("fiche d'une série : distribution, bande-annonce, saisons avec leur statut (disponible / demandée)", async () => {
  const overseerr = await faux({
    "GET /api/v1/tv/20": { corps: {
      name: "Sillage", firstAirDate: "2022-02-18", overview: "Synopsis", voteAverage: 8.7, posterPath: "/s.jpg", genres: [{ id: 1, name: "Drame" }],
      credits: { cast: [{ name: "Adam Scott", character: "Mark", profilePath: "/a.jpg" }] },
      relatedVideos: [{ site: "YouTube", type: "Teaser", key: "teaser123" }, { site: "YouTube", type: "Trailer", key: "abc_DEF-123" }, { site: "Vimeo", type: "Trailer", key: "v1" }],
      seasons: [{ seasonNumber: 0, episodeCount: 3 }, { seasonNumber: 1, episodeCount: 9 }, { seasonNumber: 2, episodeCount: 10 }, { seasonNumber: 3, episodeCount: 10 }],
      mediaInfo: { status: 4, seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 1 }], requests: [{ status: 1, seasons: [{ seasonNumber: 3 }] }, { status: 3, seasons: [{ seasonNumber: 2 }] }] },
    } },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, DATA_DIR: dossier() });
  const f = (await app.inject({ url: "/api/decouvrir/fiche/serie/20" })).json();
  assert.equal(f.titre, "Sillage");
  assert.equal(f.annee, 2022);
  assert.deepEqual(f.genres, ["Drame"]);
  assert.equal(f.distribution[0].nom, "Adam Scott");
  assert.equal(f.distribution[0].role, "Mark");
  assert.equal(f.bandeAnnonce, "https://www.youtube.com/watch?v=abc_DEF-123");
  assert.equal(f.statut, "partiel");
  assert.deepEqual(f.saisons, [
    { numero: 1, episodes: 9, statut: "disponible" },
    { numero: 2, episodes: 10, statut: null },
    { numero: 3, episodes: 10, statut: "demande" },
  ]);
  assert.equal((await app.inject({ url: "/api/decouvrir/fiche/serie/abc" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/decouvrir/fiche/livre/1" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/decouvrir/fiche/film/404" })).statusCode, 404);
  overseerr.close();
});

// ---------- demande ----------

test("demande d'un film : POST /request {movie, mediaId}, protégée, puis le même film déjà demandé est refusé sans rien envoyer", async () => {
  let demande = false;
  const overseerr = await faux({
    "GET /api/v1/movie/1": () => ({ corps: { title: "Nouveau", releaseDate: "2024-01-01", mediaInfo: demande ? { status: 2 } : undefined } }),
    "POST /api/v1/request": () => {
      demande = true;
      return { statut: 201, corps: { id: 1 } };
    },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, ACCESS_TOKEN: "jeton-app-12345", DATA_DIR: dossier() });
  const auth = { ...MARQUE, authorization: "Bearer jeton-app-12345" };
  const corps = JSON.stringify({ type: "film", tmdbId: 1 });
  assert.equal((await app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: { authorization: "Bearer jeton-app-12345" }, payload: corps })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: MARQUE, payload: corps })).statusCode, 401);
  assert.equal(overseerr.posts.length, 0);

  const ok = await app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: auth, payload: corps });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().titre, "Nouveau");
  assert.deepEqual(overseerr.posts[0], { mediaType: "movie", mediaId: 1, is4k: false });

  const doublon = await app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: auth, payload: corps });
  assert.equal(doublon.statusCode, 409);
  assert.match(doublon.json().error, /déjà demandé/);
  assert.equal(overseerr.posts.length, 1, "aucun second POST");
  overseerr.close();
});

test("demande : film déjà disponible ou dans la bibliothèque refusé ; Overseerr qui répond 409 ou 403 expliqué", async () => {
  const overseerr = await faux({
    "GET /api/v1/movie/1": { corps: { title: "Déjà là", mediaInfo: { status: 5 } } },
    "GET /api/v1/movie/2": { corps: { title: "Dans Radarr" } },
    "GET /api/v1/movie/3": { corps: { title: "Course" } },
    "GET /api/v1/movie/4": { corps: { title: "Sans droit" } },
    "POST /api/v1/request": (b) => ((b as { mediaId: number }).mediaId === 3 ? { statut: 409, corps: { message: "Request for this media already exists." } } : { statut: 403, corps: {} }),
  });
  const radarr = await faux({ "GET /api/v3/movie": { corps: [{ id: 1, tmdbId: 2, hasFile: false }] } });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, RADARR_URL: radarr.url, DATA_DIR: dossier() });
  const demander = (b: unknown) => app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: MARQUE, payload: JSON.stringify(b) });
  const dispo = await demander({ type: "film", tmdbId: 1 });
  assert.equal(dispo.statusCode, 409);
  assert.match(dispo.json().error, /déjà disponible/);
  const lib = await demander({ type: "film", tmdbId: 2 });
  assert.equal(lib.statusCode, 409);
  assert.match(lib.json().error, /déjà dans la bibliothèque/);
  assert.equal(overseerr.posts.length, 0);
  const course = await demander({ type: "film", tmdbId: 3 });
  assert.equal(course.statusCode, 409);
  assert.match(course.json().error, /déjà demandé/);
  const droit = await demander({ type: "film", tmdbId: 4 });
  assert.equal(droit.statusCode, 403);
  assert.match(droit.json().error, /pas le droit/);
  for (const b of [{ type: "livre", tmdbId: 1 }, { type: "film", tmdbId: -1 }, { type: "film" }, { type: "serie", tmdbId: 20 }, { type: "serie", tmdbId: 20, saisons: [0, "x", -1] }]) {
    assert.equal((await demander(b)).statusCode, 400, JSON.stringify(b));
  }
  overseerr.close(); radarr.close();
});

test("demande d'une série : seules les saisons libres sont envoyées ; toutes déjà prises → refus", async () => {
  const overseerr = await faux({
    "GET /api/v1/tv/20": { corps: {
      name: "Sillage", firstAirDate: "2022-02-18",
      seasons: [{ seasonNumber: 1, episodeCount: 9 }, { seasonNumber: 2, episodeCount: 10 }, { seasonNumber: 3, episodeCount: 10 }],
      mediaInfo: { status: 4, seasons: [{ seasonNumber: 1, status: 5 }], requests: [{ status: 2, seasons: [{ seasonNumber: 2 }] }] },
    } },
    "POST /api/v1/request": { statut: 201, corps: { id: 9 } },
  });
  const app = buildServer({ OVERSEERR_URL: overseerr.url, DATA_DIR: dossier() });
  const demander = (saisons: number[]) => app.inject({ method: "POST", url: "/api/decouvrir/demander", headers: MARQUE, payload: JSON.stringify({ type: "serie", tmdbId: 20, saisons }) });
  const ok = await demander([1, 2, 3]);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().saisons, [3], "la saison disponible et la saison demandée sont écartées");
  assert.deepEqual(overseerr.posts[0], { mediaType: "tv", mediaId: 20, is4k: false, seasons: [3] });
  const rien = await demander([1, 2]);
  assert.equal(rien.statusCode, 409);
  assert.match(rien.json().error, /déjà disponibles ou demandées/);
  assert.equal(overseerr.posts.length, 1);
  overseerr.close();
});

test("Overseerr absent → 404 ; Overseerr éteint → 502 sans faire planter le serveur", async () => {
  const sans = buildServer({ DATA_DIR: dossier() });
  for (const url of ["/api/decouvrir/liste?rangee=tendances", "/api/decouvrir/genres", "/api/decouvrir/recherche?q=delta", "/api/decouvrir/fiche/film/1"]) {
    assert.equal((await sans.inject({ url })).statusCode, 404, url);
  }
  assert.equal((await sans.inject({ method: "POST", url: "/api/decouvrir/demander", headers: MARQUE, payload: JSON.stringify({ type: "film", tmdbId: 1 }) })).statusCode, 404);
  const eteint = buildServer({ OVERSEERR_URL: "http://127.0.0.1:1", DATA_DIR: dossier() });
  const r = await eteint.inject({ url: "/api/decouvrir/liste?rangee=tendances" });
  assert.equal(r.statusCode, 502);
  assert.equal((await eteint.inject({ url: "/api/health" })).statusCode, 200);
});

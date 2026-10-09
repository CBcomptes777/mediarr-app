import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };

interface Requete {
  method: string;
  url: string;
  body: unknown;
  cle?: string;
}
type Reponse = { status?: number; json?: unknown; texte?: string } | undefined;

function fake(handler: (r: Requete) => Reponse) {
  const recues: Requete[] = [];
  const srv = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      let body: unknown = undefined;
      try {
        body = brut ? JSON.parse(brut) : undefined;
      } catch {
        body = brut;
      }
      const r = { method: req.method ?? "", url: req.url ?? "", body, cle: req.headers["x-api-key"] as string | undefined };
      recues.push(r);
      const rep = handler(r);
      if (!rep) return void res.writeHead(404).end("{}");
      res.writeHead(rep.status ?? 200, { "content-type": "application/json" });
      res.end(rep.texte ?? JSON.stringify(rep.json ?? {}));
    });
  });
  return new Promise<{ url: string; recues: Requete[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, recues, close: () => srv.close() }),
    ),
  );
}

const TMDB = "https://image.tmdb.org/t/p/original/abc.jpg";
let films: unknown[] = [];

function radarr() {
  films = [];
  return fake((r) => {
    if (r.cle !== "kr") return { status: 401 };
    const u = r.url;
    if (r.method === "GET") {
      if (u.startsWith("/api/v3/movie/lookup/tmdb?tmdbId=100")) return { json: { title: "Nuit Écarlate", year: 2026, tmdbId: 100, id: 0 } };
      if (u.startsWith("/api/v3/movie/lookup/tmdb?tmdbId=101")) return { json: { title: "Déjà là", tmdbId: 101, id: 5 } };
      if (u.startsWith("/api/v3/movie/lookup/tmdb?tmdbId=999")) return { json: { title: "Doublon", tmdbId: 999, id: 0 } };
      if (u.startsWith("/api/v3/movie/lookup?term=")) {
        return {
          json: [
            { title: "Nuit Écarlate", year: 2026, tmdbId: 100, id: 0, overview: "Une enquêtrice…", genres: ["Thriller"], studio: "Studio X", digitalRelease: "2026-09-01T00:00:00Z", ratings: { imdb: { value: 7.8, votes: 5400 }, tmdb: { value: 7.1 } }, images: [{ coverType: "poster", remoteUrl: TMDB }] },
            { title: "Déjà là", year: 2020, tmdbId: 101, id: 5, images: [{ coverType: "poster", remoteUrl: "https://evil.example/p.jpg" }] },
            { title: "Sans identifiant", id: 0 },
          ],
        };
      }
      if (u === "/api/v3/rootfolder") return { json: [{ path: "/films", freeSpace: 5e11, accessible: true }, { path: "/ko", accessible: false }] };
      if (u === "/api/v3/qualityprofile") return { json: [{ id: 1, name: "HD-1080p" }, { id: 2, name: "Any" }] };
      if (u === "/api/v3/movie") return { json: films };
      if (u === "/api/v3/movie/1")
        return {
          json: {
            id: 1, title: "Film", hasFile: true, ratings: { imdb: { value: 7.4, votes: 1200 }, tmdb: { value: 7.1 } },
            movieFile: { quality: { quality: { id: 3, name: "WEBDL-1080p", source: "web", resolution: 1080 } }, size: 4e9, languages: [{ name: "English" }], releaseGroup: "OLD", sceneName: "Film.2026.1080p.WEB-DL-OLD" },
          },
        };
      if (u === "/api/v3/movie/2") return { json: { id: 2, title: "Sans fichier", hasFile: false, ratings: { tmdb: { value: 6.5 } } } };
      if (u.startsWith("/api/v3/release?movieId="))
        return {
          json: [
            { guid: "g-rejet", indexerId: 3, title: "Film.2026.CAM", indexer: "Tracker A", protocol: "torrent", seeders: 90, leechers: 2, size: 2e9, ageMinutes: 90, quality: { quality: { name: "CAM" } }, rejected: true, rejections: ["Quality for release is not wanted in profile", "Something unexpected"], customFormatScore: -100, languages: [{ name: "English" }] },
            { guid: "g-ok", indexerId: 4, title: "Film.2026.1080p", indexer: "Tracker B", protocol: "torrent", seeders: 12, leechers: 1, size: 8e9, ageHours: 5, quality: { quality: { name: "WEBDL-1080p", source: "web", resolution: 1080 } }, rejected: false, rejections: [], customFormatScore: 10 },
            { guid: "g-usenet", indexerId: 5, title: "Film.2026.NZB", indexer: "NZB", protocol: "usenet", size: 7e9, age: 2, quality: { quality: { name: "Remux-2160p", source: "bluray", resolution: 2160 } } },
            { guid: "g-meme", indexerId: 6, title: "Film.2026.1080p.WEB-DL-OLD", indexer: "Tracker C", protocol: "torrent", seeders: 5, size: 4e9, age: 1, quality: { quality: { name: "WEBDL-1080p", source: "web", resolution: 1080 } } },
            { guid: "g-basse", indexerId: 7, title: "Film.2026.720p.HDTV", indexer: "Tracker D", protocol: "torrent", seeders: 200, size: 2e9, age: 1, quality: { quality: { name: "HDTV-720p", source: "television", resolution: 720 } } },
            { title: "sans guid" },
          ],
        };
    }
    if (r.method === "POST" && u === "/api/v3/movie") {
      const b = r.body as { tmdbId?: number };
      if (b.tmdbId === 999) return { status: 400, texte: '[{"errorMessage":"This movie has already been added"}]' };
      films = [{ id: 42, title: "Nuit Écarlate", hasFile: false }];
      return { status: 201, json: { id: 42, title: "Nuit Écarlate" } };
    }
    if (r.method === "POST" && u === "/api/v3/release") {
      if ((r.body as { guid?: string }).guid === "expire") return { status: 404 };
      return { json: {} };
    }
    return undefined;
  });
}

function sonarr() {
  return fake((r) => {
    if (r.cle !== "ks") return { status: 401 };
    const u = r.url;
    if (r.method === "GET") {
      if (u.startsWith("/api/v3/series/lookup?term=tvdb%3A200"))
        return { json: [{ title: "La Frontière", year: 2025, tvdbId: 200, id: 0, network: "Chaîne 1", seriesType: "anime" }] };
      if (u.startsWith("/api/v3/series/lookup?term="))
        return { json: [{ title: "La Frontière", year: 2025, tvdbId: 200, id: 0, network: "Chaîne 1", firstAired: "2025-03-02", ratings: { value: 8.1, votes: 300 }, images: [{ coverType: "poster", remoteUrl: "https://artworks.thetvdb.com/banners/p.jpg" }] }] };
      if (u === "/api/v3/rootfolder") return { json: [{ path: "/series", freeSpace: 1e12 }] };
      if (u === "/api/v3/qualityprofile") return { json: [{ id: 7, name: "HD-1080p" }] };
      if (u.startsWith("/api/v3/episode?seriesId=7"))
        return {
          json: [
            { id: 71, seasonNumber: 1, episodeNumber: 2, title: "Deux", hasFile: false, monitored: true, airDateUtc: "2026-10-08T19:00:00Z" },
            { id: 70, seasonNumber: 1, episodeNumber: 1, title: "Un", hasFile: true, monitored: true, airDate: "2026-10-01" },
            { id: 90, seasonNumber: 0, episodeNumber: 1, title: "Spécial", hasFile: false, monitored: false },
          ],
        };
      if (u === "/api/v3/episode/70")
        return { json: { id: 70, hasFile: true, episodeFile: { quality: { quality: { name: "HDTV-720p", source: "television", resolution: 720 } }, size: 1e9, language: { name: "Français" }, releaseGroup: "GRP", relativePath: "S01/Serie.S01E01.720p.HDTV-GRP.mkv" } } };
      if (u.startsWith("/api/v3/release?episodeId=70"))
        return { json: [{ guid: "s-1", indexerId: 1, title: "Serie.S01E01", indexer: "T", protocol: "torrent", seeders: 3, size: 1e9 }] };
    }
    if (r.method === "POST" && u === "/api/v3/series") return { status: 201, json: { id: 8, title: "La Frontière" } };
    if (r.method === "POST" && u === "/api/v3/release") return { json: {} };
    return undefined;
  });
}

async function setup() {
  const [r, s] = await Promise.all([radarr(), sonarr()]);
  const app = buildServer(
    { RADARR_URL: r.url, RADARR_API_KEY: "kr", SONARR_URL: s.url, SONARR_API_KEY: "ks" },
    {
      fetchExterne: (async () =>
        new Response(Buffer.from("89504e47", "hex"), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch,
    },
  );
  return { app, r, s, close: () => (r.close(), s.close()) };
}

const post = (app: ReturnType<typeof buildServer>, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: MARQUE, payload: JSON.stringify(payload) });

test("recherche : films et séries, déjà ajouté signalé, affiches via le serveur et sites autorisés seulement", async () => {
  const t = await setup();
  const res = await t.app.inject({ url: "/api/recherche?q=nuit" });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes("kr") || !res.body.includes('"kr"'), "aucune clé dans la réponse");
  const { items, erreurs } = res.json();
  assert.deepEqual(erreurs, []);
  assert.deepEqual(items.map((i: { titre: string }) => i.titre), ["Nuit Écarlate", "Déjà là", "La Frontière"]); // l'entrée sans id est écartée
  const film = items[0];
  assert.equal(film.type, "film");
  assert.equal(film.externeId, 100);
  assert.equal(film.dansBibliotheque, false);
  assert.equal(film.detail, "Studio X");
  assert.equal(film.affiche, `/image-externe?u=${encodeURIComponent("https://image.tmdb.org/t/p/w342/abc.jpg")}`);
  assert.deepEqual(film.note, { valeur: 7.8, votes: 5400, source: "imdb" });
  assert.equal(film.sortie, "2026-09-01T00:00:00Z");
  assert.equal(items[1].note, null, "pas de note → null, jamais 0");
  assert.equal(items[1].sortie, "2020-01-01", "à défaut : le 1er janvier de l'année");
  assert.deepEqual(items[2].note, { valeur: 8.1, votes: 300, source: "note" }, "série : jamais étiquetée IMDb");
  assert.equal(items[2].sortie, "2025-03-02");
  assert.equal(items[1].dansBibliotheque, true);
  assert.equal(items[1].mediaId, 5);
  assert.equal(items[1].affiche, null, "un site hors liste blanche n'est jamais relayé");
  assert.equal(items[2].type, "serie");
  assert.equal(items[2].externeId, 200);
  // Filtre par service
  const seulementSeries = (await t.app.inject({ url: "/api/recherche?q=nuit&type=serie" })).json();
  assert.deepEqual(seulementSeries.items.map((i: { type: string }) => i.type), ["serie"]);
  t.close();
});

test("recherche : terme trop court ou trop long refusé, service absent → 404, panne partielle signalée", async () => {
  const t = await setup();
  assert.equal((await t.app.inject({ url: "/api/recherche?q=a" })).statusCode, 400);
  assert.equal((await t.app.inject({ url: `/api/recherche?q=${"x".repeat(101)}` })).statusCode, 400);
  assert.equal((await buildServer({}).inject({ url: "/api/recherche?q=nuit" })).statusCode, 404);
  const r = await radarr();
  const app = buildServer({ RADARR_URL: r.url, RADARR_API_KEY: "kr", SONARR_URL: "http://127.0.0.1:1", SONARR_API_KEY: "x" });
  const body = (await app.inject({ url: "/api/recherche?q=nuit" })).json();
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.erreurs, ["Sonarr injoignable"]);
  r.close();
  t.close();
});

test("options d'ajout : dossiers accessibles et profils de qualité", async () => {
  const t = await setup();
  const o = (await t.app.inject({ url: "/api/ajout/options/film" })).json();
  assert.deepEqual(o.racines, [{ chemin: "/films", libreOctets: 5e11 }]); // le dossier inaccessible est écarté
  assert.deepEqual(o.profils, [{ id: 1, nom: "HD-1080p" }, { id: 2, nom: "Any" }]);
  assert.equal((await t.app.inject({ url: "/api/ajout/options/musique" })).statusCode, 400);
  t.close();
});

test("ajout d'un film : charge construite côté serveur, recherche immédiate, bibliothèque à jour tout de suite", async () => {
  const t = await setup();
  assert.equal((await t.app.inject({ url: "/api/bibliotheque" })).json().items.length, 0); // met la liste en mémoire
  const res = await post(t.app, "/api/ajout", { type: "film", externeId: 100, racine: "/films", profil: 1, suivi: true, recherche: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, id: 42, titre: "Nuit Écarlate" });
  const envoye = t.r.recues.find((x) => x.method === "POST" && x.url === "/api/v3/movie")!.body as Record<string, any>;
  assert.equal(envoye.rootFolderPath, "/films");
  assert.equal(envoye.qualityProfileId, 1);
  assert.equal(envoye.monitored, true);
  assert.equal(envoye.title, "Nuit Écarlate", "la fiche vient du service, pas du téléphone");
  assert.deepEqual(envoye.addOptions, { monitor: "movieOnly", searchForMovie: true });
  const apres = (await t.app.inject({ url: "/api/bibliotheque" })).json();
  assert.deepEqual(apres.items.map((i: { titre: string }) => i.titre), ["Nuit Écarlate"], "la mémoire des listes a été vidée");
  t.close();
});

test("ajout d'une série : suivi désactivé et sans recherche", async () => {
  const t = await setup();
  const res = await post(t.app, "/api/ajout", { type: "serie", externeId: 200, racine: "/series", profil: 7, suivi: false, recherche: false });
  assert.equal(res.statusCode, 200);
  const envoye = t.s.recues.find((x) => x.method === "POST" && x.url === "/api/v3/series")!.body as Record<string, any>;
  assert.equal(envoye.monitored, false);
  assert.equal(envoye.seriesType, "anime", "le type de série trouvé par le service est conservé");
  assert.deepEqual(envoye.addOptions, { monitor: "none", searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false });
  t.close();
});

test("ajout : dossier ou profil inventé, demande mal formée, déjà présent : rien n'est créé", async () => {
  const t = await setup();
  const base = { type: "film", externeId: 100, racine: "/films", profil: 1, suivi: true, recherche: false };
  assert.equal((await post(t.app, "/api/ajout", { ...base, racine: "/etc" })).statusCode, 400);
  assert.equal((await post(t.app, "/api/ajout", { ...base, racine: "/ko" })).statusCode, 400);
  assert.equal((await post(t.app, "/api/ajout", { ...base, profil: 99 })).statusCode, 400);
  assert.equal((await post(t.app, "/api/ajout", { ...base, externeId: "100" })).statusCode, 400);
  assert.equal((await post(t.app, "/api/ajout", { ...base, suivi: "oui" })).statusCode, 400);
  assert.equal((await post(t.app, "/api/ajout", { ...base, type: "musique" })).statusCode, 400);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/ajout", headers: MARQUE, payload: "pas du json" })).statusCode, 400);
  const dejaLa = await post(t.app, "/api/ajout", { ...base, externeId: 101 });
  assert.equal(dejaLa.statusCode, 409);
  assert.equal(dejaLa.json().error, "Déjà dans la bibliothèque");
  const doublon = await post(t.app, "/api/ajout", { ...base, externeId: 999 });
  assert.equal(doublon.statusCode, 409, "le refus « already been added » du service est traduit");
  assert.equal(t.r.recues.filter((x) => x.method === "POST" && x.url === "/api/v3/movie").length, 1, "seul le doublon est parti, refusé");
  assert.equal(
    (await t.app.inject({ method: "POST", url: "/api/ajout", payload: JSON.stringify(base) })).statusCode,
    403,
    "sans X-Requested-With",
  );
  t.close();
});

test("épisodes d'une série : groupés par saison et triés", async () => {
  const t = await setup();
  const { saisons } = (await t.app.inject({ url: "/api/episodes/7" })).json();
  assert.deepEqual(saisons.map((s: { numero: number }) => s.numero), [0, 1]);
  assert.deepEqual(saisons[1].episodes.map((e: { numero: number }) => e.numero), [1, 2]);
  assert.deepEqual(saisons[1].episodes[0], { id: 70, numero: 1, titre: "Un", diffusion: "2026-10-01", fichier: true, suivi: true });
  assert.equal((await t.app.inject({ url: "/api/episodes/7abc" })).statusCode, 400);
  t.close();
});

test("releases d'un film : état du titre, fichier actuel, badges, raisons en français, meilleur choix", async () => {
  const t = await setup();
  const res = await t.app.inject({ url: "/api/releases/film/1" });
  assert.ok(!res.body.includes('"kr"'));
  const { titre, items } = res.json();
  assert.equal(titre.statut, "present");
  assert.deepEqual(titre.fichier, { qualite: "WEBDL-1080p", rang: 10805, tailleOctets: 4e9, langues: ["English"], groupe: "OLD", nom: "Film.2026.1080p.WEB-DL-OLD" });
  assert.deepEqual(titre.note, { valeur: 7.4, votes: 1200, source: "imdb" });
  const par = Object.fromEntries(items.map((i: { guid: string }) => [i.guid, i]));
  assert.equal(items.length, 5, "la release sans guid est écartée");
  // Meilleur choix : la seule non rejetée qui améliore le fichier actuel (Remux 2160p), en tête de liste.
  assert.equal(items[0].guid, "g-usenet");
  assert.equal(par["g-usenet"].meilleurChoix, true);
  assert.equal(par["g-usenet"].miseANiveau, true);
  assert.equal(items.filter((i: { meilleurChoix: boolean }) => i.meilleurChoix).length, 1);
  assert.equal(par["g-meme"].dejaTelecharge, true, "même release que le fichier actuel");
  assert.equal(par["g-meme"].miseANiveau, false);
  assert.equal(par["g-ok"].miseANiveau, false, "même qualité ≠ mise à niveau");
  assert.equal(par["g-ok"].inferieure, false);
  assert.equal(par["g-basse"].inferieure, true);
  assert.equal(par["g-rejet"].rejete, true);
  assert.deepEqual(par["g-rejet"].raisons, ["Qualité non souhaitée dans le profil", "Rejetée par le service"]);
  assert.equal(items.at(-1).guid, "g-rejet", "les rejetées en dernier");
  const ok = par["g-ok"];
  assert.equal(ok.indexeur, "Tracker B");
  assert.equal(ok.seeders, 12);
  assert.equal(ok.ageMinutes, 300);
  assert.equal(par["g-usenet"].protocole, "usenet");
  assert.equal(par["g-usenet"].seeders, null);
  assert.equal(par["g-usenet"].ageMinutes, 2880);
  t.close();
});

test("releases d'un film sans fichier : tout candidat non rejeté peut être le meilleur choix", async () => {
  const t = await setup();
  const r = (await t.app.inject({ url: "/api/releases/film/2" })).json();
  assert.equal(r.titre.statut, "sans_fichier");
  assert.equal(r.titre.note.source, "tmdb", "sans IMDb : TMDB, étiqueté comme tel");
  assert.equal(r.items.filter((i: { meilleurChoix: boolean }) => i.meilleurChoix).length, 1);
  assert.equal(r.items.find((i: { meilleurChoix: boolean }) => i.meilleurChoix).guid, "g-usenet", "meilleure qualité d'abord");
  t.close();
});

test("releases : film absent de la bibliothèque (404) ou service muet → état honnête, la liste reste utilisable", async () => {
  const t = await setup();
  const absent = (await t.app.inject({ url: "/api/releases/film/3" })).json();
  assert.equal(absent.titre.statut, "absent");
  assert.ok(Array.isArray(absent.items));
  t.close();
});

test("releases d'un épisode, paramètres invalides refusés", async () => {
  const t = await setup();
  const { items } = (await t.app.inject({ url: "/api/releases/episode/70" })).json();
  assert.equal(items[0].guid, "s-1");
  assert.ok(t.s.recues.some((x) => x.url === "/api/v3/release?episodeId=70"));
  const e = (await t.app.inject({ url: "/api/releases/episode/70" })).json();
  assert.equal(e.titre.statut, "present");
  assert.deepEqual(e.titre.fichier.langues, ["Français"]);
  assert.equal(e.titre.fichier.groupe, "GRP");
  assert.equal(e.titre.fichier.nom, "Serie.S01E01.720p.HDTV-GRP.mkv");
  assert.equal((await t.app.inject({ url: "/api/releases/episode/70;x" })).statusCode, 400);
  assert.equal((await t.app.inject({ url: "/api/releases/saison/70" })).statusCode, 400);
  t.close();
});

test("téléchargement d'une release : guid et indexeur transmis, résultat expiré expliqué", async () => {
  const t = await setup();
  const ok = await post(t.app, "/api/releases/film", { guid: "g-ok", indexerId: 4 });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(t.r.recues.find((x) => x.method === "POST" && x.url === "/api/v3/release")!.body, { guid: "g-ok", indexerId: 4 });
  const expire = await post(t.app, "/api/releases/film", { guid: "expire", indexerId: 4 });
  assert.equal(expire.statusCode, 410);
  assert.match(expire.json().error, /expiré/);
  assert.equal((await post(t.app, "/api/releases/film", { guid: "", indexerId: 4 })).statusCode, 400);
  assert.equal((await post(t.app, "/api/releases/film", { guid: "x", indexerId: "4" })).statusCode, 400);
  assert.equal((await post(t.app, "/api/releases/film", { guid: "x".repeat(501), indexerId: 4 })).statusCode, 400);
  assert.equal((await post(t.app, "/api/releases/musique", { guid: "x", indexerId: 4 })).statusCode, 400);
  const sonarr = await post(t.app, "/api/releases/episode", { guid: "s-1", indexerId: 1 });
  assert.equal(sonarr.statusCode, 200);
  assert.ok(t.s.recues.some((x) => x.method === "POST" && x.url === "/api/v3/release"));
  t.close();
});

test("affiches externes : liste blanche, https seulement, réponse image obligatoire, cache", async () => {
  let appels = 0;
  let redirect: string | undefined;
  const app = buildServer(
    {},
    {
      fetchExterne: (async (_u: unknown, init?: RequestInit) => {
        appels++;
        redirect = init?.redirect;
        return new Response(Buffer.from("89504e47", "hex"), { headers: { "content-type": "image/jpeg" } });
      }) as unknown as typeof fetch,
    },
  );
  const get = (u: string) => app.inject({ url: `/api/image-externe?u=${encodeURIComponent(u)}` });
  for (const mauvaise of [
    "https://evil.example/p.jpg",
    "http://image.tmdb.org/t/p/w342/a.jpg",
    "https://image.tmdb.org.evil.example/a.jpg",
    "https://user:pw@image.tmdb.org/a.jpg",
    "https://image.tmdb.org:8443/a.jpg",
    "file:///etc/passwd",
    "pas une adresse",
    "",
  ]) {
    assert.equal((await get(mauvaise)).statusCode, 400, mauvaise);
  }
  assert.equal(appels, 0, "rien n'a été demandé sur le réseau");
  const a = await get("https://image.tmdb.org/t/p/w342/a.jpg");
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers["content-type"], "image/jpeg");
  assert.equal(redirect, "error", "pas de redirection suivie");
  await get("https://image.tmdb.org/t/p/w342/a.jpg");
  assert.equal(appels, 1, "la 2e demande vient du cache");

  const html = buildServer({}, { fetchExterne: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
  assert.equal((await html.inject({ url: `/api/image-externe?u=${encodeURIComponent("https://image.tmdb.org/a.jpg")}` })).statusCode, 502);
  const enorme = buildServer({}, { fetchExterne: (async () => new Response(Buffer.alloc(3 * 1024 * 1024 + 1), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch });
  assert.equal((await enorme.inject({ url: `/api/image-externe?u=${encodeURIComponent("https://image.tmdb.org/a.jpg")}` })).statusCode, 502);
});

test("jeton d'accès exigé sur recherche, options, épisodes, releases et affiches externes", async () => {
  const app = buildServer({ ACCESS_TOKEN: "abc" });
  for (const url of ["/api/recherche?q=nuit", "/api/ajout/options/film", "/api/episodes/7", "/api/releases/film/1", "/api/image-externe?u=x"]) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
  }
});

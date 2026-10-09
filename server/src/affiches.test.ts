import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "./server.js";

const CLE = "cle-secrete-radarr";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const TMDB = "https://image.tmdb.org/t/p/original/xyz.jpg";

type Mode = "entete" | "parametre" | "panne" | "absent";
interface Vue {
  url: string;
  entetes: Record<string, string | string[] | undefined>;
}

/**
 * Faux Radarr. /MediaCover se comporte selon `mode` :
 *  - entete : accepte la clé en en-tête X-Api-Key ;
 *  - parametre : n'accepte QUE ?apikey= (l'en-tête est ignoré → 401, comme certaines installations) ;
 *  - panne : répond 500 ; absent : répond 404.
 */
function fakeRadarr(mode: Mode, extra?: (url: string) => unknown) {
  const vues: Vue[] = [];
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    vues.push({ url, entetes: req.headers });
    if (url.startsWith("/MediaCover/")) {
      const cleEntete = req.headers["x-api-key"] === CLE;
      const cleParam = new URL(url, "http://x").searchParams.get("apikey") === CLE;
      if (mode === "panne") return void res.writeHead(500).end();
      if (mode === "absent") return void res.writeHead(404).end();
      if (mode === "entete" && !cleEntete) return void res.writeHead(401).end();
      if (mode === "parametre" && !cleParam) return void res.writeHead(401).end();
      return void res.writeHead(200, { "content-type": "image/jpeg" }).end(PNG);
    }
    if (req.headers["x-api-key"] !== CLE) return void res.writeHead(401).end();
    const o = extra?.(url);
    if (o === undefined) return void res.writeHead(404).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  });
  return new Promise<{ url: string; vues: Vue[]; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, vues, close: () => srv.close() }),
    ),
  );
}

const fiche649 = { id: 649, title: "Film", images: [{ coverType: "poster", remoteUrl: TMDB }] };

function serveur(r: { url: string }, journal: string[], fetchExterne?: typeof fetch) {
  return buildServer({ RADARR_URL: r.url, RADARR_API_KEY: CLE }, { journal: (m) => journal.push(m), fetchExterne });
}

test("affiche : la clé en en-tête suffit quand le service l'accepte pour /MediaCover", async () => {
  const r = await fakeRadarr("entete");
  const journal: string[] = [];
  const res = await serveur(r, journal).inject({ url: "/api/image/radarr/MediaCover/649/poster.jpg?lastWrite=638&w=250" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.deepEqual(journal, []);
  // Le chemin est à la racine (pas sous /api/v3) et lastWrite est conservé.
  assert.equal(r.vues[0].url, "/MediaCover/649/poster-250.jpg?lastWrite=638");
  assert.equal(r.vues[0].entetes["x-api-key"], CLE);
  r.close();
});

test("affiche : le service refuse l'en-tête (401) → deuxième essai avec ?apikey=, échec journalisé sans la clé", async () => {
  const r = await fakeRadarr("parametre");
  const journal: string[] = [];
  const res = await serveur(r, journal).inject({ url: "/api/image/radarr/MediaCover/649/poster.jpg?lastWrite=638" });
  assert.equal(res.statusCode, 200, "l'image est servie grâce au deuxième essai");
  assert.deepEqual(
    r.vues.map((v) => v.url.split("?")[0] + (v.url.includes("apikey=") ? " +apikey" : "")),
    ["/MediaCover/649/poster.jpg", "/MediaCover/649/poster.jpg +apikey"],
  );
  assert.ok(r.vues[1].url.includes("lastWrite=638"), "lastWrite est conservé");
  assert.equal(journal.length, 1);
  assert.match(journal[0], /radarr \/MediaCover\/649\/poster\.jpg → HTTP 401 \(clé en-tête\)/);
  assert.ok(!journal.join("\n").includes(CLE), "la clé n'apparaît jamais dans le journal");
  assert.ok(!res.body.includes(CLE) && !JSON.stringify(res.headers).includes(CLE));
  r.close();
});

test("affiche : service en panne → repli sur l'affiche distante (liste blanche), version réduite TMDB", async () => {
  const r = await fakeRadarr("panne", (u) => (u === "/api/v3/movie/649" ? fiche649 : undefined));
  const journal: string[] = [];
  const demandes: string[] = [];
  const app = serveur(r, journal, (async (u: URL) => {
    demandes.push(String(u));
    return new Response(PNG, { headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch);
  const res = await app.inject({ url: "/api/image/radarr/MediaCover/649/poster.jpg?w=250" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, PNG);
  assert.deepEqual(demandes, ["https://image.tmdb.org/t/p/w342/xyz.jpg"]);
  assert.ok(journal.length >= 1 && journal.every((l) => l.includes("HTTP 500")));
  assert.ok(!journal.join("\n").includes(CLE));
  r.close();
});

test("affiche : ni locale ni distante → 404/502 propre, rien d'inventé", async () => {
  const r = await fakeRadarr("absent", (u) => (u === "/api/v3/movie/649" ? { id: 649, images: [] } : undefined));
  const journal: string[] = [];
  const app = serveur(r, journal, (async () => {
    throw new Error("ne doit pas être appelé");
  }) as unknown as typeof fetch);
  const res = await app.inject({ url: "/api/image/radarr/MediaCover/649/poster.jpg" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "Image indisponible" });
  r.close();
});

// ---- Aucune liste ne renvoie « affiche: null » quand le service connaît le média ----

function listes() {
  const films = [
    { id: 1, title: "Url locale avec urlBase", year: 2020, hasFile: true, images: [{ coverType: "poster", url: "/radarr/MediaCover/1/poster.jpg?lastWrite=1", remoteUrl: TMDB }] },
    { id: 2, title: "Adresse distante seule", year: 2021, hasFile: false, images: [{ coverType: "poster", url: "", remoteUrl: TMDB }] },
    { id: 3, title: "Aucune image dans la réponse", year: 2022, hasFile: false, images: [] },
    { id: 4, title: "Casse différente", year: 2023, hasFile: false, images: [{ coverType: "Poster", url: "/MediaCover/4/poster.jpg" }] },
  ];
  return fakeRadarr("entete", (u) => {
    if (u === "/api/v3/movie") return films;
    if (u === "/api/v3/movie/3") return films[2];
    if (u.startsWith("/api/v3/calendar")) return [{ ...films[2], digitalRelease: new Date().toISOString() }];
    if (u.startsWith("/api/v3/history"))
      return {
        records: [
          { id: 9, eventType: "downloadFolderImported", movieId: 3, date: "2026-10-05T10:00:00Z", movie: films[2] },
          { id: 8, eventType: "grabbed", movieId: 2, date: "2026-10-04T10:00:00Z", movie: films[1] },
        ],
      };
    return undefined;
  });
}

test("affiches : bibliothèque, détail, calendrier, téléchargements et historique n'en renvoient jamais null", async () => {
  const r = await listes();
  const s = await (async () => {
    const vues: string[] = [];
    const srv = http.createServer((req, res) => {
      vues.push(req.url ?? "");
      const u = req.url ?? "";
      const o =
        u === "/api/v3/series"
          ? [{ id: 7, title: "Série", images: [{ coverType: "banner", url: "/MediaCover/7/banner.jpg" }, { coverType: "poster", url: "/MediaCover/7/poster.jpg?lastWrite=2" }, { coverType: "fanart", url: "/MediaCover/7/fanart.jpg" }, { coverType: "clearlogo", url: "/MediaCover/7/clearlogo.png" }] }]
          : u.startsWith("/api/v3/episode")
            ? [{ id: 70, seasonNumber: 1, episodeNumber: 1, title: "Un", hasFile: true }]
            : u.startsWith("/api/v3/history")
              ? { records: [{ id: 5, eventType: "downloadFolderImported", seriesId: 7, date: "2026-10-06T08:00:00Z", series: { id: 7, title: "Série", images: [] }, episode: { seasonNumber: 1, episodeNumber: 1 } }] }
              : u.startsWith("/api/v3/calendar")
                ? [{ seriesId: 7, title: "Pilote", seasonNumber: 1, episodeNumber: 2, airDateUtc: new Date().toISOString(), series: { title: "Série", images: [] } }]
                : undefined;
      if (req.headers["x-api-key"] !== "cle-sonarr" || o === undefined) return void res.writeHead(404).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    });
    return new Promise<{ url: string; close: () => void }>((ok) =>
      srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })),
    );
  })();
  const app = buildServer({ RADARR_URL: r.url, RADARR_API_KEY: CLE, SONARR_URL: s.url, SONARR_API_KEY: "cle-sonarr" });

  const get = async (url: string) => (await app.inject({ url })).json();
  const sansAffiche = (liste: { affiche: string | null; titre: string }[]) =>
    liste.filter((i) => !i.affiche || !i.affiche.startsWith("/image")).map((i) => i.titre);

  const biblio = (await get("/api/bibliotheque")).items;
  assert.equal(biblio.length, 5);
  assert.deepEqual(sansAffiche(biblio), []);
  const parTitre = Object.fromEntries(biblio.map((i: { titre: string; affiche: string }) => [i.titre, i.affiche]));
  assert.equal(parTitre["Url locale avec urlBase"], "/image/radarr/MediaCover/1/poster.jpg?lastWrite=1");
  assert.equal(parTitre["Adresse distante seule"], `/image-externe?u=${encodeURIComponent("https://image.tmdb.org/t/p/w342/xyz.jpg")}`);
  assert.equal(parTitre["Aucune image dans la réponse"], "/image/radarr/MediaCover/3/poster.jpg");
  assert.equal(parTitre["Casse différente"], "/image/radarr/MediaCover/4/poster.jpg");
  assert.equal(parTitre["Série"], "/image/sonarr/MediaCover/7/poster.jpg?lastWrite=2", "le poster, pas la bannière ni le logo");

  assert.ok((await get("/api/detail/film/3")).affiche.startsWith("/image/radarr/MediaCover/3/"));
  assert.ok((await get("/api/detail/film/3")).fond.startsWith("/image/radarr/MediaCover/3/fanart"));
  const cal = (await get("/api/calendrier?jours=2")).items;
  assert.equal(cal.length, 2);
  assert.deepEqual(sansAffiche(cal), []);
  const dl = (await get("/api/telechargements")).items;
  assert.ok(dl.length >= 2);
  assert.deepEqual(sansAffiche(dl), []);
  const hist = (await get("/api/historique")).items;
  assert.equal(hist.length, 3);
  assert.deepEqual(sansAffiche(hist), []);
  assert.equal((await get("/api/episodes/7")).affiche, "/image/sonarr/MediaCover/7/poster.jpg");

  r.close();
  s.close();
});

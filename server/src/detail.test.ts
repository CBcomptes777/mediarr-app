import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";

const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-dt-"));
const TMDB = (n: string) => `https://image.tmdb.org/t/p/original/${n}.jpg`;

const FILMS = [
  { id: 1, title: "Saga 2", year: 2012, hasFile: true, collection: { title: "La Grande Saga", tmdbId: 10 }, images: [{ coverType: "poster", url: "/MediaCover/1/poster.jpg" }] },
  { id: 2, title: "Saga 1", year: 2008, hasFile: false, collection: { title: "La Grande Saga", tmdbId: 10 }, images: [] },
  { id: 3, title: "Saga 3", year: 2016, hasFile: true, collection: { title: "La Grande Saga", tmdbId: 10 }, images: [] },
  { id: 4, title: "Autre saga", year: 2010, collection: { title: "Autre", tmdbId: 11 }, images: [] },
  { id: 5, title: "Film seul", year: 2020, images: [] },
];

const CREDITS = [
  { personName: "Alice Martin", character: "Léa", type: "cast", order: 1, images: [{ coverType: "headshot", remoteUrl: TMDB("alice") }] },
  { personName: "Bob Durand", character: "Max", type: "cast", order: 0, images: [{ coverType: "headshot", remoteUrl: "https://evil.example/bob.jpg" }] },
  { personName: "Chloé Roy", character: "", type: "cast", order: 2, images: [] },
  { personName: "Dan Leroy", type: "crew", job: "Producer", department: "Production" },
  { personName: "Eva Petit", type: "crew", job: "Director", department: "Directing" },
  { personName: "Eva Petit", type: "crew", job: "Director", department: "Directing" }, // doublon
  { personName: "Fred Noir", type: "crew", job: "Gaffer", department: "Lighting" }, // poste non retenu
  { personName: "Gina Blanc", type: "crew", job: "Screenplay", department: "Writing" },
];

function fake(options: { listeEnPanne?: boolean } = {}) {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "";
    const json = (o: unknown, statut = 200) => void res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.headers["x-api-key"] !== "k") return json({}, 401);
    if (url === "/api/v3/movie") return options.listeEnPanne ? json({}, 500) : json(FILMS);
    const m = url.match(/^\/api\/v3\/movie\/(\d+)$/);
    if (m) {
      const f = FILMS.find((x) => x.id === Number(m[1]));
      return f ? json(f) : json({}, 404);
    }
    if (url === "/api/v3/credit?movieId=1") return json(CREDITS);
    if (url === "/api/v3/credit?movieId=9") return json({}, 500);
    json({}, 404);
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })),
  );
}

const env = (url: string, extra: Record<string, string> = {}) => ({ RADARR_URL: url, RADARR_API_KEY: "k", DATA_DIR: dossier(), ...extra });

test("détail d'un film : sa saga = les autres films de la collection présents dans la bibliothèque, par année", async () => {
  const f = await fake();
  const d = (await buildServer(env(f.url)).inject({ url: "/api/detail/film/1" })).json();
  assert.equal(d.collection.titre, "La Grande Saga");
  assert.deepEqual(d.collection.films.map((x: { titre: string }) => x.titre), ["Saga 1", "Saga 2", "Saga 3"], "triés par année, l'autre saga exclue");
  assert.deepEqual(d.collection.films.map((x: { etat: string }) => x.etat), ["manquant", "complet", "complet"]);
  assert.equal(d.collection.films[1].affiche, "/image/radarr/MediaCover/1/poster.jpg");
  assert.ok(d.collection.films.every((x: { affiche: string }) => x.affiche.startsWith("/image/")));
  f.close();
});

test("détail : pas de collection → null ; liste indisponible → le nom de la saga est gardé", async () => {
  const f = await fake();
  const app = buildServer(env(f.url));
  assert.equal((await app.inject({ url: "/api/detail/film/5" })).json().collection, null);
  f.close();
  const g = await fake({ listeEnPanne: true });
  const d = (await buildServer(env(g.url)).inject({ url: "/api/detail/film/1" })).json();
  assert.equal(d.collection.titre, "La Grande Saga");
  assert.deepEqual(d.collection.films, []);
  g.close();
});

test("distribution : acteurs dans l'ordre (12 au plus), photos sur sites autorisés seulement, équipe en français sans doublon", async () => {
  const f = await fake();
  const app = buildServer(env(f.url));
  const res = await app.inject({ url: "/api/detail/film/1/distribution" });
  assert.ok(!res.body.includes('"k"'));
  const d = res.json();
  assert.deepEqual(d.acteurs.map((a: { nom: string }) => a.nom), ["Bob Durand", "Alice Martin", "Chloé Roy"], "triés par ordre de générique");
  assert.equal(d.acteurs[0].photo, null, "site hors liste blanche : pas de photo");
  assert.equal(d.acteurs[1].photo, `/image-externe?u=${encodeURIComponent("https://image.tmdb.org/t/p/w342/alice.jpg")}`);
  assert.equal(d.acteurs[2].role, null, "rôle vide → null");
  assert.deepEqual(d.equipe, [
    { nom: "Eva Petit", poste: "Réalisateur" },
    { nom: "Gina Blanc", poste: "Scénario" },
    { nom: "Dan Leroy", poste: "Producteur" },
  ]);
  f.close();
});

test("distribution : identifiant invalide → 400, Radarr absent → 404, erreur du service → 502, jeton exigé", async () => {
  const f = await fake();
  const app = buildServer(env(f.url));
  assert.equal((await app.inject({ url: "/api/detail/film/1abc/distribution" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/detail/film/9/distribution" })).statusCode, 502);
  assert.equal((await buildServer({ DATA_DIR: dossier() }).inject({ url: "/api/detail/film/1/distribution" })).statusCode, 404);
  assert.equal((await buildServer(env(f.url, { ACCESS_TOKEN: "abc" })).inject({ url: "/api/detail/film/1/distribution" })).statusCode, 401);
  f.close();
});

test("distribution : plus de 12 acteurs → les 12 premiers du générique", async () => {
  const beaucoup = Array.from({ length: 20 }, (_, i) => ({ personName: `Acteur ${String(i).padStart(2, "0")}`, character: `Rôle ${i}`, type: "cast", order: 19 - i, images: [] }));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url?.startsWith("/api/v3/credit") ? beaucoup : {}));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const d = (await buildServer({ RADARR_URL: url, RADARR_API_KEY: "k", DATA_DIR: dossier() }).inject({ url: "/api/detail/film/1/distribution" })).json();
  assert.equal(d.acteurs.length, 12);
  assert.equal(d.acteurs[0].nom, "Acteur 19");
  srv.close();
});

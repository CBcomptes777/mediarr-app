import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { cheminAutorise, empreinteMagnet, empreinteTorrent, libelleSource, normaliserChemin } from "./torrents.js";

const MARQUE = { "x-requested-with": "mediarr", "content-type": "application/json" };
const dossier = () => mkdtempSync(join(tmpdir(), "mediarr-"));
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const MAGNET = (h: string, extra = "") => `magnet:?xt=urn:btih:${h}&dn=Mon+Film${extra}`;

/** Un petit .torrent valide, et l'empreinte attendue (sha1 du dictionnaire « info »). */
function faireTorrent(nom = "a") {
  const info = Buffer.concat([Buffer.from(`d6:lengthi5e4:name${nom.length}:${nom}12:piece lengthi16384e6:pieces20:`), Buffer.alloc(20, 7), Buffer.from("e")]);
  const fichier = Buffer.concat([Buffer.from("d8:announce21:http://tracker.test/a4:info"), info, Buffer.from("e")]);
  return { fichier, empreinte: createHash("sha1").update(info).digest("hex") };
}

interface Appel {
  methode: string;
  chemin: string;
  corps: URLSearchParams | null;
  formulaire: Record<string, string | string[]> | null;
  fichiers: { champ: string; nom: string; octets: number }[];
}

/** Faux qBittorrent complet : session, sync par différences, ajout multipart, commandes, v4 ou v5. */
function fauxQbit(opts: { v4?: boolean; echecAjout?: "fails" | "415" } = {}) {
  const appels: Appel[] = [];
  const m = {
    sid: "S1",
    logins: 0,
    rid: 0,
    torrents: new Map<string, Record<string, unknown>>(),
    dirty: new Set<string>(),
    etatSale: false,
    removed: new Set<string>(),
    categories: { Films: { name: "Films", savePath: "/downloads/films" } } as Record<string, unknown>,
    serverState: { dl_info_speed: 1000, up_info_speed: 200, dl_rate_limit: 0, up_rate_limit: 0, use_alt_speed_limits: false, free_space_on_disk: 5e11, connection_status: "connected" } as Record<string, unknown>,
    fichiers: [{ index: 0, name: "Dossier/a.mkv", size: 100, progress: 0.5, priority: 1 }, { index: 1, name: "Dossier/b.srt", size: 10, progress: 1, priority: 6 }],
  };
  const ajouter = (hash: string, o: Record<string, unknown> = {}) => {
    m.torrents.set(hash, { name: `Torrent ${hash.slice(0, 4)}`, state: "downloading", progress: 0.4, dlspeed: 500, upspeed: 0, eta: 100, size: 1e9, downloaded: 4e8, uploaded: 1e8, ratio: 0.25, category: "Films", tags: "hd, vu", tracker: "http://tracker.test:8080/announce?passkey=SECRET", added_on: 1_700_000_000, save_path: "/downloads/films", priority: 1, seq_dl: false, f_l_piece_prio: false, ...o });
    m.dirty.add(hash);
  };
  const srv = http.createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (c) => morceaux.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const brut = Buffer.concat(morceaux);
      const chemin = url.pathname;
      if (chemin === "/api/v2/auth/login") {
        m.logins++;
        return void res.writeHead(200, { "set-cookie": `SID=${m.sid}; HttpOnly` }).end("Ok.");
      }
      if (req.headers.cookie !== `SID=${m.sid}`) return void res.writeHead(403).end("Forbidden");
      const type = req.headers["content-type"] ?? "";
      let corps: URLSearchParams | null = null;
      let formulaire: Appel["formulaire"] = null;
      const fichiers: Appel["fichiers"] = [];
      if (req.method === "POST" && type.startsWith("application/x-www-form-urlencoded")) corps = new URLSearchParams(brut.toString());
      if (req.method === "POST" && type.startsWith("multipart/form-data")) {
        formulaire = {};
        const fd = await new Response(brut, { headers: { "content-type": type } }).formData();
        for (const [k, v] of fd.entries()) {
          if (typeof v === "string") formulaire[k] = v;
          else fichiers.push({ champ: k, nom: v.name, octets: v.size });
        }
      }
      appels.push({ methode: req.method ?? "", chemin: chemin + url.search, corps, formulaire, fichiers });
      const ok = (texte = "") => void res.writeHead(200, { "content-type": "text/plain" }).end(texte);
      const json = (o: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));

      if (chemin === "/api/v2/sync/maindata") {
        const demande = Number(url.searchParams.get("rid"));
        if (demande === 0 || demande !== m.rid) {
          m.rid++;
          m.dirty.clear();
          m.removed.clear();
          return json({ rid: m.rid, full_update: true, torrents: Object.fromEntries(m.torrents), categories: m.categories, tags: ["hd", "vu"], server_state: m.serverState });
        }
        const partiel = Object.fromEntries([...m.dirty].map((h) => [h, m.torrents.get(h)]));
        const retires = [...m.removed];
        m.dirty.clear();
        m.removed.clear();
        if (Object.keys(partiel).length === 0 && retires.length === 0 && !m.etatSale) return json({ rid: m.rid });
        m.etatSale = false;
        m.rid++;
        return json({ rid: m.rid, torrents: partiel, torrents_removed: retires, server_state: m.serverState });
      }
      if (chemin === "/api/v2/torrents/add") {
        if (opts.echecAjout === "415") return void res.writeHead(415).end("");
        if (opts.echecAjout === "fails") return ok("Fails.");
        for (const l of String(formulaire?.urls ?? "").split("\n").filter(Boolean)) {
          const h = /btih:([0-9a-f]{40})/i.exec(l)?.[1]?.toLowerCase();
          if (h) ajouter(h, { state: formulaire?.paused === "true" ? "stoppedDL" : "downloading" });
        }
        return ok("Ok.");
      }
      if (opts.v4 && /\/torrents\/(stop|start)$/.test(chemin)) return void res.writeHead(404).end();
      if (!opts.v4 && /\/torrents\/(pause|resume)$/.test(chemin)) return void res.writeHead(404).end();
      if (chemin === "/api/v2/torrents/delete") {
        for (const h of String(corps?.get("hashes")).split("|")) {
          m.torrents.delete(h);
          m.removed.add(h);
        }
        return ok();
      }
      if (chemin === "/api/v2/app/preferences") return json({ save_path: "/downloads" });
      if (chemin === "/api/v2/transfer/speedLimitsMode") return ok(m.serverState.use_alt_speed_limits ? "1" : "0");
      if (chemin === "/api/v2/transfer/toggleSpeedLimitsMode") {
        m.serverState.use_alt_speed_limits = !m.serverState.use_alt_speed_limits;
        m.etatSale = true;
        return ok();
      }
      if (chemin === "/api/v2/torrents/toggleSequentialDownload") {
        for (const h of String(corps?.get("hashes")).split("|")) {
          const t = m.torrents.get(h);
          if (t) {
            t.seq_dl = !t.seq_dl;
            m.dirty.add(h);
          }
        }
        return ok();
      }
      if (chemin === "/api/v2/torrents/properties") return json({ addition_date: 1_700_000_000, save_path: "/downloads/films", total_size: 1e9, total_downloaded: 4e8, total_uploaded: 1e8, share_ratio: 0.254, eta: 100, seeds: 3, seeds_total: 10, peers: 2, peers_total: 8, pieces_num: 100, pieces_have: 40, piece_size: 16384, created_by: "mktorrent", comment: "x" });
      if (chemin === "/api/v2/torrents/files") return json(m.fichiers);
      if (chemin === "/api/v2/torrents/trackers") return json([{ url: "https://tracker.test/announce/PASSKEY123?key=abc", status: 2, num_seeds: 10, num_peers: 3, num_downloaded: 5, msg: "" }, { url: "** [DHT] **", status: 2, num_seeds: 0, num_peers: 0, num_downloaded: 0, msg: "" }]);
      if (chemin === "/api/v2/sync/torrentPeers") return json({ peers: { "1.2.3.4:5555": { client: "qBittorrent/5.0", progress: 0.5, dl_speed: 100, up_speed: 50, country_code: "ca" } } });
      return ok();
    });
  });
  return new Promise<{ url: string; appels: Appel[]; m: typeof m; ajouter: typeof ajouter; close: () => void; vers: (chemin: string) => Appel[] }>((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        appels,
        m,
        ajouter,
        close: () => { srv.closeAllConnections(); srv.close(); },
        vers: (c) => appels.filter((a) => a.chemin.split("?")[0] === `/api/v2${c}`),
      }),
    ),
  );
}

async function monter(opts: Parameters<typeof fauxQbit>[0] = {}, env: Record<string, string> = {}) {
  const q = await fauxQbit(opts);
  const logs: string[] = [];
  const app = buildServer({ QBIT_URL: q.url, QBIT_USER: "u", QBIT_PASS: "p", DATA_DIR: dossier(), ...env }, { journal: (l) => logs.push(l) });
  const post = (url: string, corps: unknown) => app.inject({ method: "POST", url, headers: MARQUE, payload: JSON.stringify(corps) });
  return { q, app, logs, post };
}

// ---------- outils purs ----------

test("magnet : empreinte hexadécimale ou base32 ; fichier .torrent : sha1 du dictionnaire info ; le reste est refusé", () => {
  assert.equal(empreinteMagnet(MAGNET(H1.toUpperCase())), H1);
  assert.equal(empreinteMagnet("magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&dn=x")?.length, 40);
  assert.equal(empreinteMagnet("magnet:?dn=sans-xt"), null);
  assert.equal(empreinteMagnet("magnet:?xt=urn:btih:trop-court"), null);
  const t = faireTorrent("film");
  assert.equal(empreinteTorrent(t.fichier), t.empreinte);
  assert.equal(empreinteTorrent(Buffer.from("pas un torrent")), null);
  assert.equal(empreinteTorrent(Buffer.from("d3:foo3:bare")), null, "pas de dictionnaire info");
  assert.equal(empreinteTorrent(Buffer.from("d4:infod4:name1:a")), null, "tronqué");
});

test("chemins : absolus seulement, sans « .. », dans une racine autorisée (Windows insensible à la casse)", () => {
  assert.equal(normaliserChemin("/downloads//films/"), "/downloads/films");
  for (const mauvais of ["films", "../etc", "/a/../etc", "/a/./b", "", "/a\0b", "/a\nb", 12, null]) assert.equal(normaliserChemin(mauvais), null, String(mauvais));
  const racines = ["/downloads", "/media/films/"];
  assert.equal(cheminAutorise("/downloads", racines), "/downloads");
  assert.equal(cheminAutorise("/downloads/series/S1", racines), "/downloads/series/S1");
  assert.equal(cheminAutorise("/media/films/2024", racines), "/media/films/2024");
  for (const refuse of ["/etc", "/downloads-evil", "/downloadsx/a", "/", "/downloads/../etc", "relatif"]) assert.equal(cheminAutorise(refuse, racines), null, refuse);
  assert.equal(cheminAutorise("D:\\Films\\X", ["d:/films"]), "D:/Films/X");
  assert.equal(cheminAutorise("/n'importe/où", ["/"]), "/n'importe/où");
});

test("libellé d'une source : un magnet est tronqué (jamais ses trackers), une adresse perd sa query", () => {
  const l = libelleSource(MAGNET(H1, "&tr=http%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSECRET"));
  assert.match(l, /^magnet …aaaaaaaaaaaa$/);
  assert.doesNotMatch(l, /SECRET|tracker/);
  assert.equal(libelleSource("https://site.test/dl/x.torrent?key=SECRET"), "site.test/dl/x.torrent");
});

// ---------- état par différences ----------

test("état : liste normalisée (étiquettes, tracker sans secret), puis « inchangé », puis seulement les différences ; pas de cookie dans la réponse", async () => {
  const { q, app } = await monter();
  q.ajouter(H1);
  q.ajouter(H2, { state: "stalledUP", progress: 1 });
  const e1 = (await app.inject({ url: "/api/qbit/etat" })).json();
  assert.equal(e1.torrents.length, 2);
  const t = e1.torrents.find((x: { hash: string }) => x.hash === H1);
  assert.equal(t.nom, "Torrent aaaa");
  assert.deepEqual(t.etiquettes, ["hd", "vu"]);
  assert.equal(t.tracker, "tracker.test");
  assert.equal(t.etat.brut, "downloading");
  assert.equal(e1.torrents.find((x: { hash: string }) => x.hash === H2).etat.code, "termine");
  assert.deepEqual(e1.categories, [{ nom: "Films", chemin: "/downloads/films" }]);
  assert.deepEqual(e1.trackers, ["tracker.test"]);
  assert.equal(e1.global.vitesseDl, 1000);
  assert.equal(e1.global.alternatif, false);
  assert.ok(!JSON.stringify(e1).includes("SECRET") && !JSON.stringify(e1).includes("SID="));

  await new Promise((ok) => setTimeout(ok, 900));
  const e2 = (await app.inject({ url: `/api/qbit/etat?v=${e1.v}` })).json();
  assert.deepEqual(e2, { inchange: true, v: e1.v });

  q.ajouter(H1, { progress: 0.9 });
  q.m.removed.add(H2);
  q.m.torrents.delete(H2);
  await new Promise((ok) => setTimeout(ok, 900));
  const e3 = (await app.inject({ url: `/api/qbit/etat?v=${e1.v}` })).json();
  assert.equal(e3.torrents.length, 1);
  assert.equal(e3.torrents[0].progression, 0.9);
  assert.equal(e3.torrents[0].nom, "Torrent aaaa", "les champs non renvoyés par la différence sont conservés");
  const rids = q.vers("/sync/maindata").map((a) => a.chemin);
  assert.deepEqual(rids.map((r) => r.split("rid=")[1]), ["0", "1", "2"].slice(0, rids.length).map((_, i) => rids[i].split("rid=")[1]));
  assert.equal(rids[0], "/api/v2/sync/maindata?rid=0");
  assert.notEqual(rids[1], "/api/v2/sync/maindata?rid=0", "les lectures suivantes demandent les différences");
  q.close();
});

test("qBittorrent hors ligne → 502 sans faire planter ; non configuré → 404", async () => {
  const app = buildServer({ QBIT_URL: "http://127.0.0.1:1", QBIT_USER: "u", QBIT_PASS: "p", DATA_DIR: dossier() });
  assert.equal((await app.inject({ url: "/api/qbit/etat" })).statusCode, 502);
  assert.equal((await app.inject({ method: "POST", url: "/api/qbit/lot/pause", headers: MARQUE, payload: JSON.stringify({ hashes: [H1] }) })).statusCode, 502);
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  const sans = buildServer({ DATA_DIR: dossier() });
  assert.equal((await sans.inject({ url: "/api/qbit/etat" })).statusCode, 404);
  assert.equal((await sans.inject({ method: "POST", url: "/api/qbit/ajouter", headers: MARQUE, payload: "{}" })).statusCode, 404);
});

test("session expirée : reconnexion automatique, la requête aboutit", async () => {
  const { q, post } = await monter();
  q.ajouter(H1);
  assert.equal((await post("/api/qbit/lot/pause", { hashes: [H1] })).statusCode, 200);
  assert.equal(q.m.logins, 1);
  q.m.sid = "S2"; // qBittorrent a oublié notre session
  const r = await post("/api/qbit/lot/reprise", { hashes: [H1] });
  assert.equal(r.statusCode, 200);
  assert.equal(q.m.logins, 2);
  assert.equal(q.vers("/torrents/start").length, 1);
  q.close();
});

// ---------- protection ----------

test("routes d'écriture : jeton et X-Requested-With exigés ; rien n'atteint qBittorrent sans eux", async () => {
  const { q, app } = await monter({}, { ACCESS_TOKEN: "jeton-app-12345" });
  const corps = JSON.stringify({ hashes: [H1] });
  const urls = ["/api/qbit/lot/pause", "/api/qbit/lot/supprimer", "/api/qbit/ajouter", "/api/qbit/vitesse", `/api/qbit/torrent/${H1}/renommer`];
  for (const url of urls) {
    assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "Bearer jeton-app-12345" }, payload: corps })).statusCode, 403, url);
    assert.equal((await app.inject({ method: "POST", url, headers: MARQUE, payload: corps })).statusCode, 401, url);
  }
  assert.equal((await app.inject({ url: "/api/qbit/etat" })).statusCode, 401);
  assert.equal(q.appels.length, 0);
  q.close();
});

// ---------- ajout ----------

test("ajout de liens magnet : options transmises (catégorie, dossier, étiquettes, pause v4+v5, séquentiel, limites) ; magnet jamais en entier dans les logs", async () => {
  const { q, post, logs } = await monter();
  const r = await post("/api/qbit/ajouter", {
    liens: `${MAGNET(H1, "&tr=http%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSECRET")}\n\n${MAGNET(H2)}\n`,
    options: { categorie: "Films", chemin: "/downloads/films/2024", etiquettes: ["a", " b "], pause: true, sequentiel: true, premierDernier: true, sansVerification: true, limiteDl: 1000, limiteUp: 500 },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual({ ok: r.json().ok, ajoutes: r.json().ajoutes, doublons: r.json().doublons, echecs: r.json().echecs }, { ok: true, ajoutes: 2, doublons: [], echecs: [] });
  const add = q.vers("/torrents/add")[0];
  // (le formulaire multipart normalise les fins de ligne en CRLF)
  assert.equal(String(add.formulaire?.urls).replace(/\r\n/g, "\n"), `${MAGNET(H1, "&tr=http%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSECRET")}\n${MAGNET(H2)}`);
  assert.equal(add.formulaire?.category, "Films");
  assert.equal(add.formulaire?.savepath, "/downloads/films/2024");
  assert.equal(add.formulaire?.autoTMM, "false");
  assert.equal(add.formulaire?.tags, "a,b");
  assert.equal(add.formulaire?.paused, "true");
  assert.equal(add.formulaire?.stopped, "true");
  assert.equal(add.formulaire?.sequentialDownload, "true");
  assert.equal(add.formulaire?.firstLastPiecePrio, "true");
  assert.equal(add.formulaire?.skip_checking, "true");
  assert.equal(add.formulaire?.dlLimit, "1000");
  assert.equal(add.formulaire?.upLimit, "500");
  assert.ok(logs.some((l) => /ajout de 2 torrent/.test(l)));
  assert.ok(logs.every((l) => !/SECRET|tracker\.test|magnet:\?/.test(l)), `fuite dans les logs : ${logs.join(" | ")}`);
  q.close();
});

test("ajout d'un fichier .torrent (base64) : envoyé en multipart ; le même fichier une seconde fois = doublon (409)", async () => {
  const { q, post } = await monter();
  const t = faireTorrent("film");
  const corps = { fichiers: [{ nom: "Mon Film.torrent", donnees: t.fichier.toString("base64") }] };
  const r = await post("/api/qbit/ajouter", corps);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ajoutes, 1);
  const add = q.vers("/torrents/add")[0];
  assert.deepEqual(add.fichiers, [{ champ: "torrents", nom: "Mon Film.torrent", octets: t.fichier.length }]);
  // qBittorrent connaît ce torrent maintenant (on simule son apparition dans la liste)
  q.ajouter(t.empreinte);
  const dbl = await post("/api/qbit/ajouter", corps);
  assert.equal(dbl.statusCode, 409);
  assert.match(dbl.json().error, /Déjà dans qBittorrent : Mon Film\.torrent/);
  assert.equal(q.vers("/torrents/add").length, 1, "le doublon n'est pas renvoyé à qBittorrent");
  q.close();
});

test("doublons : magnet déjà présent, même magnet en base32 ou répété dans la demande ; les nouveaux passent", async () => {
  const { q, post } = await monter();
  q.ajouter(H1);
  const r = await post("/api/qbit/ajouter", { liens: [MAGNET(H1), MAGNET(H2), MAGNET(H2.toUpperCase())].join("\n") });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ajoutes, 1);
  assert.equal(r.json().doublons.length, 2);
  assert.equal(q.vers("/torrents/add")[0].formulaire?.urls, MAGNET(H2));
  q.close();
});

test("ajout refusé proprement : lien invalide, fichier invalide ou trop gros, trop de fichiers, rien de saisi", async () => {
  const { q, post } = await monter();
  const invalide = await post("/api/qbit/ajouter", { liens: "pas un lien\nmagnet:?dn=sans-empreinte\nftp://x/y.torrent" });
  assert.equal(invalide.statusCode, 400);
  assert.equal(invalide.json().echecs.length, 3);
  const fichier = await post("/api/qbit/ajouter", { fichiers: [{ nom: "x.torrent", donnees: Buffer.from("pas un torrent").toString("base64") }, { nom: "vide.torrent", donnees: "" }] });
  assert.equal(fichier.statusCode, 400);
  assert.match(fichier.json().error, /n'est pas un \.torrent valide/);
  const gros = await post("/api/qbit/ajouter", { fichiers: [{ nom: "gros.torrent", donnees: Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString("base64") }] });
  assert.equal(gros.statusCode, 400);
  assert.match(gros.json().error, /trop gros/);
  const trop = await post("/api/qbit/ajouter", { fichiers: Array.from({ length: 11 }, (_, i) => ({ nom: `${i}.torrent`, donnees: "AA==" })) });
  assert.equal(trop.statusCode, 400);
  assert.equal((await post("/api/qbit/ajouter", {})).statusCode, 400);
  assert.equal((await post("/api/qbit/ajouter", { liens: "   " })).statusCode, 400);
  assert.equal(q.vers("/torrents/add").length, 0);
  q.close();
});

test("qBittorrent refuse l'ajout (« Fails. » ou 415) : cause claire, sans magnet complet", async () => {
  const a = await monter({ echecAjout: "fails" });
  const r = await a.post("/api/qbit/ajouter", { liens: MAGNET(H1, "&tr=http%3A%2F%2Ftracker.test%2Fa%3Fpasskey%3DSECRET") });
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /qBittorrent a refusé : lien invalide ou torrent déjà présent/);
  assert.ok(!r.body.includes("SECRET") && !r.body.includes("tracker.test"));
  a.q.close();
  const b = await monter({ echecAjout: "415" });
  const t = faireTorrent("x");
  const r2 = await b.post("/api/qbit/ajouter", { fichiers: [{ nom: "x.torrent", donnees: t.fichier.toString("base64") }] });
  assert.equal(r2.statusCode, 502);
  assert.match(r2.json().error, /fichier \.torrent refusé/);
  b.q.close();
});

test("dossier de destination : refusé hors des racines (/etc, .., relatif), accepté dans /downloads ; racines réglables", async () => {
  const { q, post, app } = await monter();
  for (const chemin of ["/etc", "/downloads/../etc", "downloads", "/downloadsx", "/"]) {
    const r = await post("/api/qbit/ajouter", { liens: MAGNET(H1), options: { chemin } });
    assert.equal(r.statusCode, 400, chemin);
    assert.match(r.json().error, /Dossier de destination non autorisé/);
  }
  assert.equal(q.vers("/torrents/add").length, 0);
  assert.equal((await post("/api/qbit/ajouter", { liens: MAGNET(H1), options: { chemin: "/downloads/series" } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: "/api/qbit/dossiers" })).json(), { racines: ["/downloads", "/downloads/films"], reglees: false });
  await app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify({ reglages: { racinesQbit: ["/mnt/tank/", "relatif", "/a/../b"] } }) });
  assert.deepEqual((await app.inject({ url: "/api/qbit/dossiers" })).json(), { racines: ["/mnt/tank"], reglees: true });
  assert.equal((await post("/api/qbit/ajouter", { liens: MAGNET(H3), options: { chemin: "/downloads/x" } })).statusCode, 400);
  assert.equal((await post("/api/qbit/ajouter", { liens: MAGNET(H3), options: { chemin: "/mnt/tank/films" } })).statusCode, 200);
  q.close();
});

test("catégorie à l'ajout : nouvelle catégorie créée avec son dossier avant l'ajout", async () => {
  const { q, post } = await monter();
  const r = await post("/api/qbit/ajouter", { liens: MAGNET(H1), options: { categorie: "Docus", chemin: "/downloads/docus" } });
  assert.equal(r.statusCode, 200);
  const crees = q.vers("/torrents/createCategory");
  assert.equal(crees.length, 1);
  assert.equal(crees[0].corps?.get("category"), "Docus");
  assert.equal(crees[0].corps?.get("savePath"), "/downloads/docus");
  assert.equal((await post("/api/qbit/ajouter", { liens: MAGNET(H2), options: { categorie: "../mal" } })).statusCode, 400);
  q.close();
});

// ---------- actions ----------

test("pause / reprise : qBittorrent 5 (stop/start) et 4 (pause/resume) avec repli automatique mémorisé", async () => {
  const v5 = await monter();
  v5.q.ajouter(H1);
  await v5.post("/api/qbit/lot/pause", { hashes: [H1] });
  await v5.post("/api/qbit/lot/reprise", { hashes: [H1.toUpperCase(), H2] });
  assert.deepEqual(v5.q.appels.map((a) => a.chemin).filter((c) => /stop|start|pause|resume/.test(c)), ["/api/v2/torrents/stop", "/api/v2/torrents/start"]);
  assert.equal(v5.q.vers("/torrents/start")[0].corps?.get("hashes"), `${H1}|${H2}`);
  v5.q.close();

  const v4 = await monter({ v4: true });
  v4.q.ajouter(H1);
  const p = await v4.post("/api/qbit/lot/pause", { hashes: [H1] });
  assert.equal(p.statusCode, 200);
  await v4.post("/api/qbit/lot/reprise", { hashes: [H1] });
  await v4.post("/api/qbit/lot/pause", { hashes: [H1] });
  assert.deepEqual(v4.q.appels.map((a) => a.chemin).filter((c) => /stop|start|pause|resume/.test(c)), [
    "/api/v2/torrents/stop", "/api/v2/torrents/pause", // premier essai : stop absent → repli
    "/api/v2/torrents/resume", // le repli est retenu : plus d'essai inutile
    "/api/v2/torrents/pause",
  ]);
  v4.q.close();
});

test("forcer, revérifier, réannoncer, priorité (haut/bas/max/min), limites, étiquettes, déplacement, renommage", async () => {
  const { q, post } = await monter();
  q.ajouter(H1);
  const h = { hashes: [H1, H2] };
  for (const [url, extra] of [["forcer", {}], ["reverifier", {}], ["reannoncer", {}]] as const) assert.equal((await post(`/api/qbit/lot/${url}`, { ...h, ...extra })).statusCode, 200, url);
  assert.equal(q.vers("/torrents/setForceStart")[0].corps?.get("value"), "true");
  for (const [niveau, verbe] of [["haut", "increasePrio"], ["bas", "decreasePrio"], ["max", "topPrio"], ["min", "bottomPrio"]] as const) {
    assert.equal((await post("/api/qbit/lot/priorite", { ...h, niveau })).statusCode, 200);
    assert.equal(q.vers(`/torrents/${verbe}`).length, 1, verbe);
  }
  assert.equal((await post("/api/qbit/lot/priorite", { ...h, niveau: "bof" })).statusCode, 400);

  assert.equal((await post("/api/qbit/lot/limites", { ...h, dl: 100_000, up: 0 })).statusCode, 200);
  assert.equal(q.vers("/torrents/setDownloadLimit")[0].corps?.get("limit"), "100000");
  assert.equal(q.vers("/torrents/setUploadLimit")[0].corps?.get("limit"), "0");
  assert.equal((await post("/api/qbit/lot/limites", { ...h, dl: -5 })).statusCode, 400);
  assert.equal((await post("/api/qbit/lot/limites", h)).statusCode, 400);

  assert.equal((await post("/api/qbit/lot/etiquettes", { ...h, ajouter: ["4k", " vu "], retirer: ["hd"] })).statusCode, 200);
  assert.equal(q.vers("/torrents/addTags")[0].corps?.get("tags"), "4k,vu");
  assert.equal(q.vers("/torrents/removeTags")[0].corps?.get("tags"), "hd");
  assert.equal((await post("/api/qbit/lot/etiquettes", { ...h, ajouter: ["a,b"] })).statusCode, 400);
  assert.equal((await post("/api/qbit/lot/etiquettes", h)).statusCode, 400);

  assert.equal((await post("/api/qbit/lot/deplacer", { ...h, chemin: "/downloads/archives" })).statusCode, 200);
  assert.equal(q.vers("/torrents/setLocation")[0].corps?.get("location"), "/downloads/archives");
  assert.equal((await post("/api/qbit/lot/deplacer", { ...h, chemin: "/root" })).statusCode, 400);
  assert.equal(q.vers("/torrents/setLocation").length, 1);

  assert.equal((await post(`/api/qbit/torrent/${H1}/renommer`, { nom: "Nouveau nom" })).statusCode, 200);
  assert.equal(q.vers("/torrents/rename")[0].corps?.get("name"), "Nouveau nom");
  for (const nom of ["", "a/b", "x".repeat(201), "a\nb"]) assert.equal((await post(`/api/qbit/torrent/${H1}/renommer`, { nom })).statusCode, 400, JSON.stringify(nom));
  q.close();
});

test("empreintes : 40 ou 64 hex, jamais autre chose ; lot vide, trop grand ou mal formé refusé", async () => {
  const { q, post } = await monter();
  for (const hashes of [[], ["zzz"], ["a".repeat(39)], [`${H1};rm`], "abc", [123], Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(40, "0"))]) {
    assert.equal((await post("/api/qbit/lot/pause", { hashes })).statusCode, 400, JSON.stringify(hashes).slice(0, 40));
  }
  assert.equal((await post("/api/qbit/lot/pause", { hashes: ["b".repeat(64)] })).statusCode, 200);
  assert.equal((await post("/api/qbit/lot/pause", { hashes: [H1, H1.toUpperCase()] })).statusCode, 200);
  assert.equal(q.vers("/torrents/stop").length, 2);
  assert.equal(q.vers("/torrents/stop")[1].corps?.get("hashes"), H1, "doublons retirés");
  assert.equal((await post("/api/qbit/torrent/pas-un-hash/renommer", { nom: "x" })).statusCode, 400);
  q.close();
});

test("catégorie : existante, effacée (« »), inexistante refusée sauf si on la crée (dossier contrôlé)", async () => {
  const { q, post } = await monter();
  q.ajouter(H1);
  assert.equal((await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "Films" })).statusCode, 200);
  assert.equal(q.vers("/torrents/setCategory")[0].corps?.get("category"), "Films");
  assert.equal((await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "" })).statusCode, 200);
  assert.equal(q.vers("/torrents/setCategory")[1].corps?.get("category"), "");
  const inconnue = await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "Nouvelle" });
  assert.equal(inconnue.statusCode, 400);
  assert.match(inconnue.json().error, /n'existe pas/);
  assert.equal((await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "Nouvelle", creer: true, chemin: "/etc" })).statusCode, 400);
  assert.equal((await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "Nouvelle", creer: true, chemin: "/downloads/nouvelle" })).statusCode, 200);
  assert.equal(q.vers("/torrents/createCategory")[0].corps?.get("savePath"), "/downloads/nouvelle");
  assert.equal((await post("/api/qbit/lot/categorie", { hashes: [H1], categorie: "a/../b", creer: true })).statusCode, 400);
  q.close();
});

test("téléchargement séquentiel et premier/dernier morceau : on ne bascule que ce qui n'est pas déjà dans l'état voulu", async () => {
  const { q, post } = await monter();
  q.ajouter(H1, { seq_dl: true });
  q.ajouter(H2, { seq_dl: false });
  assert.equal((await post("/api/qbit/lot/sequentiel", { hashes: [H1, H2], actif: true })).statusCode, 200);
  assert.equal(q.vers("/torrents/toggleSequentialDownload")[0].corps?.get("hashes"), H2);
  await post("/api/qbit/lot/sequentiel", { hashes: [H1, H2], actif: true });
  assert.equal(q.vers("/torrents/toggleSequentialDownload").length, 1, "plus rien à basculer");
  assert.equal((await post("/api/qbit/lot/sequentiel", { hashes: [H1], actif: "oui" })).statusCode, 400);
  assert.equal((await post("/api/qbit/lot/premier-dernier", { hashes: [H1], actif: true })).statusCode, 200);
  assert.equal(q.vers("/torrents/toggleFirstLastPiecePrio")[0].corps?.get("hashes"), H1);
  q.close();
});

// ---------- suppression ----------

test("suppression : confirmation obligatoire (drapeau + nombre exact) ; avec ou sans fichiers ; lot expliqué ; Masquer la suppression la bloque", async () => {
  const { q, post, app } = await monter();
  for (const h of [H1, H2, H3]) q.ajouter(h);
  const sans = await post("/api/qbit/lot/supprimer", { hashes: [H1], fichiers: false });
  assert.equal(sans.statusCode, 400);
  assert.match(sans.json().error, /non confirmée/);
  assert.equal((await post("/api/qbit/lot/supprimer", { hashes: [H1, H2], fichiers: false, confirme: true, compteur: 1 })).statusCode, 400, "mauvais compteur");
  assert.equal((await post("/api/qbit/lot/supprimer", { hashes: [H1], fichiers: false, confirme: "oui", compteur: 1 })).statusCode, 400);
  assert.equal((await post("/api/qbit/lot/supprimer", { hashes: [H1], confirme: true, compteur: 1 })).statusCode, 400, "fichiers doit être précisé");
  assert.equal(q.vers("/torrents/delete").length, 0, "rien supprimé sans confirmation");

  assert.equal((await post("/api/qbit/lot/supprimer", { hashes: [H1], fichiers: false, confirme: true, compteur: 1 })).statusCode, 200);
  assert.equal(q.vers("/torrents/delete")[0].corps?.get("deleteFiles"), "false");
  assert.equal((await post("/api/qbit/lot/supprimer", { hashes: [H2, H3], fichiers: true, confirme: true, compteur: 2 })).statusCode, 200);
  assert.equal(q.vers("/torrents/delete")[1].corps?.get("deleteFiles"), "true");
  assert.equal(q.vers("/torrents/delete")[1].corps?.get("hashes"), `${H2}|${H3}`);
  assert.equal((await app.inject({ url: "/api/qbit/etat" })).json().torrents.length, 0);

  q.ajouter(H1);
  await app.inject({ method: "PUT", url: "/api/prefs", headers: MARQUE, payload: JSON.stringify({ reglages: { masquerSuppression: true } }) });
  const masquee = await post("/api/qbit/lot/supprimer", { hashes: [H1], fichiers: true, confirme: true, compteur: 1 });
  assert.equal(masquee.statusCode, 403);
  assert.equal(q.vers("/torrents/delete").length, 2);
  q.close();
});

// ---------- détails ----------

test("détails : général, fichiers, trackers (jamais le chemin ni la clé), pairs ; priorité des fichiers validée", async () => {
  const { q, app, post } = await monter();
  const g = (await app.inject({ url: `/api/qbit/torrent/${H1}/general` })).json();
  assert.equal(g.chemin, "/downloads/films");
  assert.equal(g.ratio, 0.25);
  assert.equal(g.hash, H1);
  assert.equal(g.seedsTotal, 10);
  assert.equal(g.piecesPresentes, 40);
  const f = (await app.inject({ url: `/api/qbit/torrent/${H1}/fichiers` })).json();
  assert.deepEqual(f.items.map((x: { nom: string; priorite: number }) => [x.nom, x.priorite]), [["Dossier/a.mkv", 1], ["Dossier/b.srt", 6]]);
  const t = (await app.inject({ url: `/api/qbit/torrent/${H1}/trackers` })).json();
  assert.equal(t.items[0].hote, "https://tracker.test");
  assert.equal(t.items[0].statut, "Fonctionne");
  assert.equal(t.items[0].seeds, 10);
  assert.ok(!JSON.stringify(t).includes("PASSKEY123") && !JSON.stringify(t).includes("abc"));
  assert.equal(t.items[1].hote, "** [DHT] **");
  const p = (await app.inject({ url: `/api/qbit/torrent/${H1}/pairs` })).json();
  assert.deepEqual(p.items[0], { adresse: "1.2.3.4:5555", client: "qBittorrent/5.0", progression: 0.5, vitesseDl: 100, vitesseUp: 50, pays: "CA" });
  assert.equal((await app.inject({ url: `/api/qbit/torrent/${H1}/inconnu` })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/qbit/torrent/nimporte/general" })).statusCode, 400);

  assert.equal((await post(`/api/qbit/torrent/${H1}/fichiers/priorite`, { ids: [0, 1], priorite: 0 })).statusCode, 200);
  const fp = q.vers("/torrents/filePrio")[0].corps!;
  assert.equal(fp.get("id"), "0|1");
  assert.equal(fp.get("priority"), "0");
  for (const mauvais of [{ ids: [], priorite: 1 }, { ids: [0], priorite: 3 }, { ids: [-1], priorite: 1 }, { ids: ["a"], priorite: 1 }]) {
    assert.equal((await post(`/api/qbit/torrent/${H1}/fichiers/priorite`, mauvais)).statusCode, 400, JSON.stringify(mauvais));
  }
  q.close();
});

// ---------- vitesses globales ----------

test("vitesses globales : limites validées ; mode alternatif (tortue) basculé seulement si nécessaire", async () => {
  const { q, app, post } = await monter();
  assert.equal((await post("/api/qbit/vitesse", { dl: 5_000_000, up: 1_000_000 })).statusCode, 200);
  assert.equal(q.vers("/transfer/setDownloadLimit")[0].corps?.get("limit"), "5000000");
  assert.equal(q.vers("/transfer/setUploadLimit")[0].corps?.get("limit"), "1000000");
  assert.equal((await post("/api/qbit/vitesse", { dl: -1 })).statusCode, 400);
  assert.equal((await post("/api/qbit/vitesse", {})).statusCode, 400);

  assert.equal((await post("/api/qbit/vitesse-alternative", { actif: true })).statusCode, 200);
  assert.equal(q.vers("/transfer/toggleSpeedLimitsMode").length, 1);
  await post("/api/qbit/vitesse-alternative", { actif: true });
  assert.equal(q.vers("/transfer/toggleSpeedLimitsMode").length, 1, "déjà actif : pas de bascule");
  assert.equal((await app.inject({ url: "/api/qbit/etat" })).json().global.alternatif, true);
  await post("/api/qbit/vitesse-alternative", { actif: false });
  assert.equal(q.vers("/transfer/toggleSpeedLimitsMode").length, 2);
  assert.equal((await post("/api/qbit/vitesse-alternative", { actif: "oui" })).statusCode, 400);
  q.close();
});

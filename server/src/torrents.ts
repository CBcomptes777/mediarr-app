// Contrôle complet de qBittorrent depuis l'app : état par différences, ajout (liens et fichiers .torrent), actions sur un ou
// plusieurs torrents, détails, vitesses globales. Toutes les routes d'écriture passent par la protection globale de /api
// (jeton + X-Requested-With). Le cookie de session qBittorrent reste ici ; les empreintes sont validées ; les dossiers de
// destination doivent être dans une racine autorisée ; les liens magnet ne sont jamais écrits en entier dans un message.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { lireJson } from "./ajout.js";
import { EtatQbit } from "./qbitEtat.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Empreinte d'un torrent : 40 caractères hexadécimaux (v1) ou 64 (v2). */
const HASH = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const MAX_FICHIER_OCTETS = 5 * 1024 * 1024;
const MAX_FICHIERS = 10;
const MAX_LIENS = 50;
const MAX_LOT = 500;

// ---------- outils ----------

/** « /films/ », « /films/../etc », « D:\\x » → forme normalisée, ou null si le chemin n'est pas acceptable. */
export function normaliserChemin(brut: unknown): string | null {
  if (typeof brut !== "string" || brut.length === 0 || brut.length > 400 || /[\0\r\n]/.test(brut)) return null;
  const c = brut.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!/^(\/|[a-zA-Z]:\/)/.test(c)) return null; // chemin absolu seulement
  if (c.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return c.length > 1 ? c.replace(/\/+$/, "") || "/" : c;
}

/** Le chemin est-il une racine autorisée ou un sous-dossier d'une racine ? */
export function cheminAutorise(chemin: unknown, racines: string[]): string | null {
  const c = normaliserChemin(chemin);
  if (!c) return null;
  for (const r of racines) {
    const racine = normaliserChemin(r);
    if (!racine) continue;
    const ci = /^[a-zA-Z]:/.test(racine); // Windows : insensible à la casse
    const a = ci ? c.toLowerCase() : c;
    const b = ci ? racine.toLowerCase() : racine;
    if (a === b || (b === "/" ? a.startsWith("/") : a.startsWith(`${b}/`))) return c;
  }
  return null;
}

/** Empreinte (minuscules, 40 hex) d'un lien magnet, ou null. Gère l'hexadécimal et le base32. */
export function empreinteMagnet(lien: string): string | null {
  const m = /[?&]xt=urn:btih:([^&]+)/i.exec(lien);
  if (!m) return null;
  const h = m[1];
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(h)) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = "";
    for (const ch of h.toLowerCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
    let hex = "";
    for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex.length === 40 ? hex : null;
  }
  return null;
}

/** Empreinte (sha1 du dictionnaire « info ») d'un fichier .torrent ; null si le fichier n'est pas un torrent. */
export function empreinteTorrent(buf: Buffer): string | null {
  if (buf.length < 10 || buf[0] !== 0x64 /* d */) return null;
  let i = 1;
  const lireEntier = (): number | null => {
    const fin = buf.indexOf(0x65, i + 1);
    if (fin < 0) return null;
    const n = Number(buf.subarray(i + 1, fin).toString("latin1"));
    i = fin + 1;
    return Number.isFinite(n) ? n : null;
  };
  /** Saute une valeur bencodée à partir de i ; renvoie false si le contenu est invalide. */
  const sauter = (profondeur = 0): boolean => {
    if (profondeur > 32 || i >= buf.length) return false;
    const c = buf[i];
    if (c === 0x69 /* i */) return lireEntier() !== null;
    if (c === 0x6c /* l */ || c === 0x64 /* d */) {
      i++;
      while (i < buf.length && buf[i] !== 0x65) {
        if (c === 0x64 && !sauterChaine()) return false;
        if (!sauter(profondeur + 1)) return false;
      }
      if (buf[i] !== 0x65) return false;
      i++;
      return true;
    }
    return sauterChaine();
  };
  const sauterChaine = (): boolean => {
    const deux = buf.indexOf(0x3a, i);
    if (deux < 0 || deux - i > 10) return false;
    const n = Number(buf.subarray(i, deux).toString("latin1"));
    if (!Number.isInteger(n) || n < 0 || deux + 1 + n > buf.length) return false;
    i = deux + 1 + n;
    return true;
  };
  while (i < buf.length && buf[i] !== 0x65) {
    const debutCle = i;
    if (!sauterChaine()) return null;
    const cle = buf.subarray(debutCle, i).toString("latin1");
    const debutValeur = i;
    if (!sauter()) return null;
    if (/^\d+:info$/.test(cle)) return createHash("sha1").update(buf.subarray(debutValeur, i)).digest("hex");
  }
  return null;
}

/** Libellé sûr d'une source pour un message : un magnet est tronqué (il peut contenir des adresses de trackers privées). */
export function libelleSource(source: string): string {
  if (/^magnet:/i.test(source)) {
    const h = empreinteMagnet(source);
    return h ? `magnet …${h.slice(0, 12)}` : "magnet invalide";
  }
  try {
    const u = new URL(source);
    return `${u.hostname}${u.pathname.length > 30 ? `${u.pathname.slice(0, 30)}…` : u.pathname}`; // jamais la query (clé personnelle)
  } catch {
    return source.slice(0, 40).replace(/[?#].*$/, "") + (source.length > 40 ? "…" : "");
  }
}

const nomFichierSur = (n: unknown) => str(n).replace(/[\\/\0\r\n]/g, "_").slice(0, 80) || "fichier.torrent";

export interface DepsTorrents {
  /** Requête authentifiée vers qBittorrent (session et reconnexion gérées par QbitSession). */
  requete: (chemin: string, init?: RequestInit) => Promise<Response>;
  configured: (id: ServiceId) => boolean;
  /** Dossiers déjà connus (racines Radarr / Sonarr) ; complétés par ceux de qBittorrent. */
  racinesConnues: () => Promise<string[]>;
  /** Racines choisies dans Réglages (vide = automatique). */
  racinesReglees: () => string[];
  suppressionMasquee: () => boolean;
  log?: (message: string) => void;
}

export function registerTorrents(app: FastifyInstance, d: DepsTorrents): { etat: EtatQbit } {
  const lireMaindata = async (rid: number): Promise<Obj> => {
    const res = await d.requete(`/api/v2/sync/maindata?rid=${rid}`);
    if (!res.ok) throw new Error(`qBittorrent : HTTP ${res.status}`);
    return (await res.json()) as Obj;
  };
  const etat = new EtatQbit(lireMaindata);

  const post = (chemin: string, params: Record<string, string>) =>
    d.requete(`/api/v2${chemin}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

  // qBittorrent 5 a renommé pause/resume en stop/start : on essaie le nom attendu puis l'autre, et on retient celui qui marche.
  let nomArret: "stop" | "pause" | null = null;
  async function pauseReprise(verbe: "arret" | "demarrage", hashes: string): Promise<Response> {
    const paires = { arret: ["stop", "pause"], demarrage: ["start", "resume"] } as const;
    const [nouveau, ancien] = paires[verbe];
    const ordre = nomArret === "pause" ? [ancien, nouveau] : [nouveau, ancien];
    let res = await post(`/torrents/${ordre[0]}`, { hashes });
    if (res.status === 404) {
      res = await post(`/torrents/${ordre[1]}`, { hashes });
      if (res.ok) nomArret = ordre[1] === ancien ? "pause" : "stop";
    } else if (res.ok) {
      nomArret = ordre[0] === nouveau ? "stop" : "pause";
    }
    return res;
  }

  let cacheRacines: { at: number; valeur: string[] } | null = null;
  async function racinesAutorisees(): Promise<string[]> {
    const reglees = d.racinesReglees();
    if (reglees.length > 0) return reglees;
    if (cacheRacines && Date.now() - cacheRacines.at < 60_000) return cacheRacines.valeur;
    const liste = new Set<string>(await d.racinesConnues().catch(() => []));
    try {
      const p = (await (await d.requete("/api/v2/app/preferences")).json()) as Obj;
      if (str(p.save_path)) liste.add(str(p.save_path));
    } catch {
      /* préférences illisibles : on garde le reste */
    }
    for (const c of etat.cheminsCategories()) liste.add(c);
    const valeur = [...liste].filter((r) => normaliserChemin(r) !== null);
    cacheRacines = { at: Date.now(), valeur };
    return valeur;
  }

  const indisponible = (reply: FastifyReply) => reply.code(404).send({ error: "qBittorrent n'est pas configuré" });
  const echec = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ error: e instanceof Error ? e.message : "qBittorrent injoignable" });

  /** Route protégée par la configuration, avec gestion d'erreur commune. */
  function route(methode: "GET" | "POST", url: string, h: (req: any, reply: FastifyReply) => Promise<unknown>, opts: { bodyLimit?: number } = {}) {
    app.route({
      method: methode,
      url,
      ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
      handler: async (req, reply) => {
        if (!d.configured("qbittorrent")) return indisponible(reply);
        try {
          return await h(req, reply);
        } catch (e) {
          return echec(reply, e);
        }
      },
    });
  }

  const empreintesDe = (b: Obj | null): string[] | null => {
    const l = b?.hashes;
    if (!Array.isArray(l) || l.length === 0 || l.length > MAX_LOT) return null;
    if (!l.every((h) => typeof h === "string" && HASH.test(h))) return null;
    return [...new Set(l.map((h: string) => h.toLowerCase()))];
  };
  const liste = (hashes: string[]) => hashes.join("|");
  const reponseHttp = (res: Response, reply: FastifyReply, contexte = "") => {
    if (res.status === 409) return reply.code(409).send({ error: "La file d'attente n'est pas activée dans qBittorrent (Options → BitTorrent)." });
    if (!res.ok) return reply.code(502).send({ error: `qBittorrent${contexte ? ` (${contexte})` : ""} : HTTP ${res.status}` });
    return { ok: true };
  };

  // ---------- lecture ----------

  route("GET", "/api/qbit/etat", async (req) => {
    await etat.rafraichir();
    const v = Number((req.query as { v?: string }).v);
    if (Number.isInteger(v) && v === etat.version) return { inchange: true, v };
    return etat.instantane();
  });

  route("GET", "/api/qbit/dossiers", async () => {
    await etat.rafraichir();
    return { racines: await racinesAutorisees(), reglees: d.racinesReglees().length > 0 };
  });

  route("GET", "/api/qbit/torrent/:hash/:onglet", async (req, reply) => {
    const { hash, onglet } = req.params as { hash: string; onglet: string };
    if (!HASH.test(hash)) return reply.code(400).send({ error: "Torrent invalide" });
    const lire = async (chemin: string) => {
      const res = await d.requete(`/api/v2${chemin}`);
      if (res.status === 404) throw new Error("Ce torrent n'existe plus dans qBittorrent");
      if (!res.ok) throw new Error(`qBittorrent : HTTP ${res.status}`);
      return res.json() as Promise<Obj>;
    };
    if (onglet === "general") {
      const p = await lire(`/torrents/properties?hash=${hash}`);
      return {
        ajouteLe: num(p.addition_date) > 0 ? new Date(num(p.addition_date) * 1000).toISOString() : null,
        termineLe: num(p.completion_date) > 0 ? new Date(num(p.completion_date) * 1000).toISOString() : null,
        chemin: str(p.save_path),
        tailleOctets: num(p.total_size),
        telechargesOctets: num(p.total_downloaded),
        partagesOctets: num(p.total_uploaded),
        ratio: Math.round(num(p.share_ratio) * 100) / 100,
        resteSec: num(p.eta) >= 8_640_000 ? null : num(p.eta),
        tempsActifSec: num(p.time_elapsed),
        tempsPartageSec: num(p.seeding_time),
        connexions: num(p.nb_connections),
        seeds: num(p.seeds),
        seedsTotal: num(p.seeds_total),
        pairs: num(p.peers),
        pairsTotal: num(p.peers_total),
        piecesTotal: num(p.pieces_num),
        piecesPresentes: num(p.pieces_have),
        taillePieceOctets: num(p.piece_size),
        creePar: str(p.created_by) || null,
        commentaire: str(p.comment).slice(0, 300) || null,
        hash: hash.toLowerCase(),
      };
    }
    if (onglet === "fichiers") {
      const f = (await lire(`/torrents/files?hash=${hash}`)) as unknown as Obj[];
      return {
        items: (Array.isArray(f) ? f : []).map((x, i) => ({
          index: Number.isInteger(x.index) ? (x.index as number) : i,
          nom: str(x.name),
          tailleOctets: num(x.size),
          progression: num(x.progress),
          priorite: num(x.priority),
        })),
      };
    }
    if (onglet === "trackers") {
      const t = (await lire(`/torrents/trackers?hash=${hash}`)) as unknown as Obj[];
      return {
        items: (Array.isArray(t) ? t : []).map((x) => {
          const url = str(x.url);
          let hote = url;
          try {
            const u = new URL(url);
            hote = `${u.protocol}//${u.host}`; // jamais le chemin ni la query : la clé personnelle du tracker y est souvent
          } catch {
            /* « ** [DHT] ** » et autres pseudo-trackers : tels quels */
          }
          return {
            hote: hote.slice(0, 120),
            statut: ({ 0: "Désactivé", 1: "Pas encore contacté", 2: "Fonctionne", 3: "Mise à jour…", 4: "Ne fonctionne pas" } as Record<number, string>)[num(x.status)] ?? "Inconnu",
            fonctionne: num(x.status) === 2,
            seeds: Math.max(0, num(x.num_seeds)),
            pairs: Math.max(0, num(x.num_peers)),
            telechargements: Math.max(0, num(x.num_downloaded)),
            message: str(x.msg).replace(/https?:\/\/\S+/g, "…").slice(0, 200),
          };
        }),
      };
    }
    if (onglet === "pairs") {
      const p = await lire(`/sync/torrentPeers?hash=${hash}&rid=0`);
      return {
        items: Object.entries((p.peers ?? {}) as Obj).slice(0, 200).map(([adresse, x]) => ({
          adresse,
          client: str((x as Obj).client).slice(0, 60),
          progression: num((x as Obj).progress),
          vitesseDl: num((x as Obj).dl_speed),
          vitesseUp: num((x as Obj).up_speed),
          pays: str((x as Obj).country_code).toUpperCase() || null,
        })),
      };
    }
    return reply.code(404).send({ error: "Onglet inconnu" });
  });

  // ---------- actions sur des torrents (un ou plusieurs) ----------

  const lot = (chemin: string, corps: (b: Obj, hashes: string[]) => Promise<Response | { erreur: string }>) =>
    route("POST", `/api/qbit/lot/${chemin}`, async (req, reply) => {
      const b = lireJson(req.body);
      const hashes = empreintesDe(b);
      if (!b || !hashes) return reply.code(400).send({ error: "Sélection de torrents invalide" });
      const res = await corps(b, hashes);
      if ("erreur" in res) return reply.code(400).send({ error: res.erreur });
      await etat.rafraichir(true).catch(() => {});
      return reponseHttp(res, reply, chemin);
    });

  lot("pause", (_b, h) => pauseReprise("arret", liste(h)));
  lot("reprise", (_b, h) => pauseReprise("demarrage", liste(h)));
  lot("forcer", (_b, h) => post("/torrents/setForceStart", { hashes: liste(h), value: "true" }));
  lot("reverifier", (_b, h) => post("/torrents/recheck", { hashes: liste(h) }));
  lot("reannoncer", (_b, h) => post("/torrents/reannounce", { hashes: liste(h) }));
  lot("priorite", async (b, h) => {
    const verbe = ({ haut: "increasePrio", bas: "decreasePrio", max: "topPrio", min: "bottomPrio" } as Record<string, string>)[str(b.niveau)];
    if (!verbe) return { erreur: "Priorité invalide" };
    return post(`/torrents/${verbe}`, { hashes: liste(h) });
  });

  // Interrupteurs : qBittorrent ne sait que « basculer » ; on ne bascule que ceux qui ne sont pas déjà dans l'état voulu.
  for (const [nom, champ, commande] of [
    ["sequentiel", "seq_dl", "toggleSequentialDownload"],
    ["premier-dernier", "f_l_piece_prio", "toggleFirstLastPiecePrio"],
  ] as const) {
    lot(nom, async (b, h) => {
      if (typeof b.actif !== "boolean") return { erreur: "Valeur invalide" };
      await etat.rafraichir(true);
      const abasculer = h.filter((x) => (etat.brut(x)?.[champ] === true) !== b.actif);
      if (abasculer.length === 0) return new Response(null, { status: 200 });
      return post(`/torrents/${commande}`, { hashes: liste(abasculer) });
    });
  }

  lot("categorie", async (b, h) => {
    const cat = typeof b.categorie === "string" ? b.categorie.trim() : null;
    if (cat === null || cat.length > 100 || /[\0\r\n]|(^|\/)\.\.(\/|$)/.test(cat)) return { erreur: "Catégorie invalide" };
    await etat.rafraichir();
    if (cat !== "" && !etat.nomsCategories().includes(cat)) {
      if (b.creer !== true) return { erreur: "Cette catégorie n'existe pas" };
      const chemin = b.chemin === undefined || b.chemin === "" ? "" : cheminAutorise(b.chemin, await racinesAutorisees());
      if (chemin === null) return { erreur: "Dossier non autorisé" };
      await post("/torrents/createCategory", { category: cat, savePath: chemin });
    }
    return post("/torrents/setCategory", { hashes: liste(h), category: cat });
  });

  lot("etiquettes", async (b, h) => {
    const propre = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean) : []);
    const ajouter = propre(b.ajouter);
    const retirer = propre(b.retirer);
    if ([...ajouter, ...retirer].some((t) => t.length > 50 || /[,\0\r\n]/.test(t)) || ajouter.length + retirer.length === 0) return { erreur: "Étiquettes invalides" };
    let res: Response = new Response(null, { status: 200 });
    if (ajouter.length) res = await post("/torrents/addTags", { hashes: liste(h), tags: ajouter.join(",") });
    if (res.ok && retirer.length) res = await post("/torrents/removeTags", { hashes: liste(h), tags: retirer.join(",") });
    return res;
  });

  lot("limites", async (b, h) => {
    const ok = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000_000);
    if (!ok(b.dl) || !ok(b.up) || (b.dl === undefined && b.up === undefined)) return { erreur: "Limite invalide" };
    let res: Response = new Response(null, { status: 200 });
    if (b.dl !== undefined) res = await post("/torrents/setDownloadLimit", { hashes: liste(h), limit: String(b.dl) });
    if (res.ok && b.up !== undefined) res = await post("/torrents/setUploadLimit", { hashes: liste(h), limit: String(b.up) });
    return res;
  });

  lot("deplacer", async (b, h) => {
    const chemin = cheminAutorise(b.chemin, await racinesAutorisees());
    if (!chemin) return { erreur: "Dossier non autorisé : il doit être dans une des racines connues (Réglages → Avancé)." };
    return post("/torrents/setLocation", { hashes: liste(h), location: chemin });
  });

  // Suppression : confirmation OBLIGATOIRE côté serveur aussi (drapeau + nombre exact de torrents), et réglage « Masquer la suppression ».
  route("POST", "/api/qbit/lot/supprimer", async (req, reply) => {
    const b = lireJson(req.body);
    const hashes = empreintesDe(b);
    if (!b || !hashes || typeof b.fichiers !== "boolean") return reply.code(400).send({ error: "Demande invalide" });
    if (d.suppressionMasquee()) return reply.code(403).send({ error: "La suppression est masquée dans les Réglages." });
    if (b.confirme !== true || b.compteur !== hashes.length) {
      return reply.code(400).send({ error: "Suppression non confirmée : le nombre de torrents à supprimer doit être confirmé." });
    }
    const res = await post("/torrents/delete", { hashes: liste(hashes), deleteFiles: b.fichiers ? "true" : "false" });
    await etat.rafraichir(true).catch(() => {});
    return reponseHttp(res, reply, "suppression");
  });

  route("POST", "/api/qbit/torrent/:hash/renommer", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const b = lireJson(req.body);
    const nom = typeof b?.nom === "string" ? b.nom.trim() : "";
    if (!HASH.test(hash) || nom.length === 0 || nom.length > 200 || /[\0\r\n/\\]/.test(nom)) return reply.code(400).send({ error: "Nom invalide" });
    const res = await post("/torrents/rename", { hash, name: nom });
    await etat.rafraichir(true).catch(() => {});
    if (res.status === 409) return reply.code(409).send({ error: "Torrent introuvable" });
    return reponseHttp(res, reply, "renommage");
  });

  route("POST", "/api/qbit/torrent/:hash/fichiers/priorite", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const b = lireJson(req.body);
    const ids = b?.ids;
    if (!HASH.test(hash) || !Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every((i) => Number.isInteger(i) && i >= 0 && i < 100_000) || ![0, 1, 6, 7].includes(b?.priorite as number)) {
      return reply.code(400).send({ error: "Demande invalide" });
    }
    return reponseHttp(await post("/torrents/filePrio", { hash, id: ids.join("|"), priority: String(b!.priorite) }), reply, "fichiers");
  });

  // ---------- vitesses globales ----------

  route("POST", "/api/qbit/vitesse", async (req, reply) => {
    const b = lireJson(req.body);
    const ok = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000_000);
    if (!b || !ok(b.dl) || !ok(b.up) || (b.dl === undefined && b.up === undefined)) return reply.code(400).send({ error: "Limite invalide" });
    let res: Response = new Response(null, { status: 200 });
    if (b.dl !== undefined) res = await post("/transfer/setDownloadLimit", { limit: String(b.dl) });
    if (res.ok && b.up !== undefined) res = await post("/transfer/setUploadLimit", { limit: String(b.up) });
    await etat.rafraichir(true).catch(() => {});
    return reponseHttp(res, reply, "vitesse");
  });

  route("POST", "/api/qbit/vitesse-alternative", async (req, reply) => {
    const b = lireJson(req.body);
    if (!b || typeof b.actif !== "boolean") return reply.code(400).send({ error: "Valeur invalide" });
    const actuel = (await (await d.requete("/api/v2/transfer/speedLimitsMode")).text()).trim() === "1";
    if (actuel !== b.actif) {
      const res = await post("/transfer/toggleSpeedLimitsMode", {});
      if (!res.ok) return reponseHttp(res, reply, "vitesse alternative");
    }
    await etat.rafraichir(true).catch(() => {});
    return { ok: true, alternatif: b.actif };
  });

  // ---------- ajout ----------

  route(
    "POST",
    "/api/qbit/ajouter",
    async (req, reply) => {
      const b = lireJson(req.body);
      if (!b) return reply.code(400).send({ error: "Demande invalide" });
      const o = (typeof b.options === "object" && b.options ? b.options : {}) as Obj;

      // 1) sources
      const echecs: { source: string; cause: string }[] = [];
      const liens: { lien: string; empreinte: string | null }[] = [];
      for (const brut of (typeof b.liens === "string" ? b.liens : "").split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean).slice(0, MAX_LIENS)) {
        if (/^magnet:\?/i.test(brut)) {
          const empreinte = empreinteMagnet(brut);
          if (!empreinte) echecs.push({ source: libelleSource(brut), cause: "Lien magnet invalide (pas d'empreinte btih)" });
          else liens.push({ lien: brut, empreinte });
        } else if (/^https?:\/\//i.test(brut) && brut.length <= 2000) {
          liens.push({ lien: brut, empreinte: null });
        } else {
          echecs.push({ source: libelleSource(brut), cause: "Ce n'est ni un lien magnet ni une adresse http(s)" });
        }
      }
      const fichiers: { nom: string; contenu: Buffer; empreinte: string }[] = [];
      const bruts = Array.isArray(b.fichiers) ? (b.fichiers as Obj[]) : [];
      if (bruts.length > MAX_FICHIERS) return reply.code(400).send({ error: `${MAX_FICHIERS} fichiers .torrent au plus à la fois` });
      for (const f of bruts) {
        const nom = nomFichierSur(f?.nom);
        const donnees = typeof f?.donnees === "string" ? f.donnees : "";
        if (donnees.length > Math.ceil((MAX_FICHIER_OCTETS * 4) / 3) + 8) {
          echecs.push({ source: nom, cause: "Fichier trop gros (5 Mo au plus)" });
          continue;
        }
        const contenu = Buffer.from(donnees, "base64");
        if (contenu.length === 0 || contenu.length > MAX_FICHIER_OCTETS) {
          echecs.push({ source: nom, cause: contenu.length === 0 ? "Fichier vide" : "Fichier trop gros (5 Mo au plus)" });
          continue;
        }
        const empreinte = empreinteTorrent(contenu);
        if (!empreinte) echecs.push({ source: nom, cause: "Ce fichier n'est pas un .torrent valide" });
        else fichiers.push({ nom, contenu, empreinte });
      }
      if (liens.length + fichiers.length + echecs.length === 0) return reply.code(400).send({ error: "Colle un lien ou choisis un fichier .torrent." });

      // 2) options validées
      await etat.rafraichir().catch(() => {}); // les dossiers des catégories existantes comptent parmi les racines autorisées
      const racines = await racinesAutorisees();
      let chemin: string | undefined;
      if (o.chemin !== undefined && o.chemin !== "") {
        const c = cheminAutorise(o.chemin, racines);
        if (!c) return reply.code(400).send({ error: "Dossier de destination non autorisé : il doit être dans une des racines connues (Réglages → Avancé)." });
        chemin = c;
      }
      const categorie = typeof o.categorie === "string" ? o.categorie.trim() : "";
      if (categorie.length > 100 || /[\0\r\n]|(^|\/)\.\.(\/|$)/.test(categorie)) return reply.code(400).send({ error: "Catégorie invalide" });
      const etiquettes = (Array.isArray(o.etiquettes) ? o.etiquettes : []).filter((t: unknown): t is string => typeof t === "string").map((t: string) => t.trim()).filter(Boolean);
      if (etiquettes.length > 20 || etiquettes.some((t: string) => t.length > 50 || /[,\0\r\n]/.test(t))) return reply.code(400).send({ error: "Étiquettes invalides" });
      const limite = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000_000 ? (v as number) : NaN);
      const dl = limite(o.limiteDl);
      const up = limite(o.limiteUp);
      if (Number.isNaN(dl) || Number.isNaN(up)) return reply.code(400).send({ error: "Limite de vitesse invalide" });

      // 3) doublons (déjà dans qBittorrent, ou répétés dans la demande)
      await etat.rafraichir(true).catch(() => {});
      const vus = new Set<string>();
      const doublons: string[] = [];
      const aEnvoyerLiens = liens.filter((l) => {
        if (l.empreinte && (etat.contient(l.empreinte) || vus.has(l.empreinte))) {
          doublons.push(libelleSource(l.lien));
          return false;
        }
        if (l.empreinte) vus.add(l.empreinte);
        return true;
      });
      const aEnvoyerFichiers = fichiers.filter((f) => {
        if (etat.contient(f.empreinte) || vus.has(f.empreinte)) {
          doublons.push(f.nom);
          return false;
        }
        vus.add(f.empreinte);
        return true;
      });

      let ajoutes = 0;
      if (aEnvoyerLiens.length + aEnvoyerFichiers.length > 0) {
        if (categorie && !etat.nomsCategories().includes(categorie)) {
          await post("/torrents/createCategory", { category: categorie, savePath: chemin ?? "" }).catch(() => {});
        }
        const form = new FormData();
        if (aEnvoyerLiens.length) form.set("urls", aEnvoyerLiens.map((l) => l.lien).join("\n"));
        for (const f of aEnvoyerFichiers) form.append("torrents", new Blob([new Uint8Array(f.contenu)], { type: "application/x-bittorrent" }), f.nom);
        if (categorie) form.set("category", categorie);
        if (chemin) {
          form.set("savepath", chemin);
          form.set("autoTMM", "false");
        }
        if (etiquettes.length) form.set("tags", etiquettes.join(","));
        // qBittorrent 5 dit « stopped », les versions 4 « paused » : on envoie les deux.
        if (o.pause === true) {
          form.set("paused", "true");
          form.set("stopped", "true");
        }
        if (o.sequentiel === true) form.set("sequentialDownload", "true");
        if (o.premierDernier === true) form.set("firstLastPiecePrio", "true");
        if (o.sansVerification === true) form.set("skip_checking", "true");
        if (dl !== undefined) form.set("dlLimit", String(dl));
        if (up !== undefined) form.set("upLimit", String(up));
        const total = aEnvoyerLiens.length + aEnvoyerFichiers.length;
        d.log?.(`[qbit] ajout de ${total} torrent(s) : ${[...aEnvoyerLiens.map((l) => libelleSource(l.lien)), ...aEnvoyerFichiers.map((f) => f.nom)].join(", ").slice(0, 300)}`);
        const res = await d.requete("/api/v2/torrents/add", { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
        const texte = (await res.text().catch(() => "")).trim();
        if (res.ok && !/^fails\.?$/i.test(texte)) ajoutes = total;
        else {
          const cause =
            res.status === 415 ? "fichier .torrent refusé par qBittorrent"
            : res.status === 403 ? "accès refusé par qBittorrent"
            : /^fails/i.test(texte) ? "qBittorrent a refusé : lien invalide ou torrent déjà présent"
            : `qBittorrent a répondu HTTP ${res.status}`;
          for (const l of aEnvoyerLiens) echecs.push({ source: libelleSource(l.lien), cause });
          for (const f of aEnvoyerFichiers) echecs.push({ source: f.nom, cause });
        }
        await etat.rafraichir(true).catch(() => {});
      }

      const resume = { ok: ajoutes > 0, ajoutes, doublons, echecs };
      if (ajoutes > 0) return resume;
      if (doublons.length > 0 && echecs.length === 0) return reply.code(409).send({ ...resume, error: `Déjà dans qBittorrent : ${doublons.join(", ")}` });
      return reply.code(echecs.some((e) => /qBittorrent/.test(e.cause)) ? 502 : 400).send({ ...resume, error: echecs.map((e) => `${e.source} : ${e.cause}`).join(" ; ") || "Rien n'a été ajouté" });
    },
    { bodyLimit: 40 * 1024 * 1024 },
  );

  return { etat };
}

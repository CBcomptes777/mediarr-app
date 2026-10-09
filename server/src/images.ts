// Relais d'images : le téléphone ne parle qu'à Mediarr. Les affiches Radarr/Sonarr (MediaCover)
// et Plex demandent la clé ou le jeton du service, qui reste ici côté serveur.
import type { FastifyInstance } from "fastify";
import type { ServiceId } from "./services.js";

export interface OptionsRaw {
  accept?: string;
  /** Délai maximum de la requête (15 s par défaut). */
  timeoutMs?: number;
  /** Annule la requête vers le service (ex. l'utilisateur a fermé la feuille). */
  signal?: AbortSignal;
  /** Met aussi la clé API dans l'adresse (?apikey=) : certains services l'exigent pour /MediaCover. */
  cleEnQuery?: boolean;
  /** Chemin à la racine du service (les images ne sont pas sous /api/v3). */
  racine?: boolean;
}
export type GetRaw = (id: ServiceId, path: string, opts?: OptionsRaw) => Promise<Response>;

const SERVICES_IMAGES = new Set<ServiceId>(["radarr", "sonarr", "plex"]);
/** Seuls ces préfixes sont relayés : jamais l'API du service, seulement ses images. */
const PREFIXES: Partial<Record<ServiceId, string[]>> = {
  radarr: ["MediaCover/"],
  sonarr: ["MediaCover/"],
  plex: ["library/metadata/"],
};
// Affiches des résultats de recherche : elles ne sont pas encore chez Radarr/Sonarr, on les prend sur les
// sites que ces services utilisent. Liste blanche stricte : le serveur ne va jamais ailleurs.
const HOTES_EXTERNES = new Set([
  "image.tmdb.org",
  "artworks.thetvdb.com",
  "thetvdb.com",
  "www.thetvdb.com",
  "assets.fanart.tv",
]);
const MAX_EXTERNE = 3 * 1024 * 1024;

function urlAutorisee(brut: string): URL | null {
  try {
    const u = new URL(brut);
    const ok =
      u.protocol === "https:" && HOTES_EXTERNES.has(u.hostname) && !u.username && !u.password && !u.port;
    return ok ? u : null;
  } catch {
    return null;
  }
}

/** Chemin Mediarr (/image-externe?u=…) pour une affiche distante autorisée, sinon null. */
export function externe(url: string): string | null {
  const u = urlAutorisee(url);
  if (!u) return null;
  // TMDB sert l'affiche « original » (plusieurs Mo) : une taille de liste suffit.
  const s = u.hostname === "image.tmdb.org" ? u.toString().replace("/t/p/original/", "/t/p/w342/") : u.toString();
  return `/image-externe?u=${encodeURIComponent(s)}`;
}

const IMAGE: OptionsRaw = { accept: "image/*", racine: true };
const TAILLES = new Set(["250", "500"]);
const TTL_MS = 24 * 3600 * 1000;
const MAX_OCTETS = 64 * 1024 * 1024;

interface Entree {
  buf: Buffer;
  type: string;
  at: number;
}

/** Cache mémoire simple (le plus ancien sort en premier) pour ne pas redemander 600 affiches au NAS. */
export class CacheImages {
  private map = new Map<string, Entree>();
  private octets = 0;

  get(cle: string): Entree | undefined {
    const e = this.map.get(cle);
    if (!e) return undefined;
    if (Date.now() - e.at > TTL_MS) {
      this.delete(cle);
      return undefined;
    }
    return e;
  }

  set(cle: string, e: Entree) {
    if (e.buf.length > MAX_OCTETS / 4) return; // une image énorme ne vaut pas le coup d'être gardée
    this.delete(cle);
    this.map.set(cle, e);
    this.octets += e.buf.length;
    for (const [k] of this.map) {
      if (this.octets <= MAX_OCTETS) break;
      this.delete(k);
    }
  }

  private delete(cle: string) {
    const e = this.map.get(cle);
    if (e) this.octets -= e.buf.length;
    this.map.delete(cle);
  }
}

export interface DepsImages {
  /** Récupération des affiches externes (remplaçable dans les tests : le réseau n'est pas disponible). */
  fetchExterne?: typeof fetch;
  /** Adresse distante (TMDB, TheTVDB) de l'affiche d'un média, quand le service ne sert pas la sienne. */
  secours?: (service: ServiceId, mediaId: number) => Promise<string | null>;
  /** Où écrire les échecs (jamais de clé : seulement service, chemin sans paramètres et statut). */
  journal?: (message: string) => void;
}

export function registerImages(
  app: FastifyInstance,
  getRaw: GetRaw,
  configured: (id: ServiceId) => boolean,
  deps: DepsImages = {},
) {
  const fetchExterne = deps.fetchExterne ?? fetch;
  let cache = new CacheImages();

  // Chaque échec n'est écrit qu'une fois (service + chemin + statut) : pas de flot de lignes pour 600 affiches.
  const dejaVus = new Set<string>();
  const journal = (id: string, chemin: string, statut: number, mode: string) => {
    const ligne = `[images] ${id} /${chemin} → ${statut ? `HTTP ${statut}` : "pas de réponse"} (clé ${mode})`;
    if (dejaVus.size > 500 || dejaVus.has(ligne)) return;
    dejaVus.add(ligne);
    (deps.journal ?? ((m: string) => console.warn(m)))(ligne);
  };

  /** Télécharge une affiche sur un site de la liste blanche. */
  async function chargerExterne(u: URL): Promise<{ buf: Buffer; type: string } | { statut: number }> {
    try {
      const res = await fetchExterne(u, {
        headers: { Accept: "image/*" },
        redirect: "error", // une redirection pourrait mener hors de la liste blanche
        signal: AbortSignal.timeout(10000),
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) return { statut: res.status === 404 ? 404 : 502 };
      if (!type.startsWith("image/")) return { statut: 502 };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_EXTERNE) return { statut: 502 };
      return { buf, type };
    } catch {
      return { statut: 502 };
    }
  }

  const reduireTmdb = (u: URL) =>
    u.hostname === "image.tmdb.org" ? new URL(u.toString().replace("/t/p/original/", "/t/p/w342/")) : u;

  app.get("/api/image-externe", async (req, reply) => {
    const u = urlAutorisee((req.query as { u?: string }).u ?? "");
    if (!u) return reply.code(400).send({ error: "Adresse non autorisée" });
    const cle = `ext:${u.toString()}`;
    const garde = cache.get(cle);
    if (garde) {
      return reply.header("content-type", garde.type).header("cache-control", "private, max-age=86400").send(garde.buf);
    }
    const r = await chargerExterne(u);
    if ("statut" in r) return reply.code(r.statut).send({ error: "Image indisponible" });
    cache.set(cle, { buf: r.buf, type: r.type, at: Date.now() });
    return reply.header("content-type", r.type).header("cache-control", "private, max-age=86400").send(r.buf);
  });

  app.get("/api/image/:service/*", async (req, reply) => {
    const { service, "*": rest } = req.params as { service: string; "*": string };
    const id = service as ServiceId;
    if (!SERVICES_IMAGES.has(id) || !configured(id)) {
      return reply.code(404).send({ error: "Service inconnu ou non configuré" });
    }
    let chemin: string;
    try {
      chemin = decodeURIComponent(rest);
    } catch {
      return reply.code(400).send({ error: "Chemin invalide" });
    }
    if (
      chemin.split("/").some((s) => s === ".." || s === ".") ||
      chemin.includes("\\") ||
      !PREFIXES[id]!.some((p) => chemin.startsWith(p))
    ) {
      return reply.code(400).send({ error: "Chemin invalide" });
    }

    // On ne retransmet que lastWrite (invalide le cache quand l'affiche change) et w (taille).
    const q = req.query as { lastWrite?: string; w?: string };
    const lastWrite = q.lastWrite && /^[\w.:-]{1,40}$/.test(q.lastWrite) ? q.lastWrite : undefined;
    const w = q.w && TAILLES.has(q.w) ? q.w : undefined;
    const suffixe = lastWrite ? `?lastWrite=${encodeURIComponent(lastWrite)}` : "";
    const cle = `${id}:${chemin}${suffixe}:${w ?? ""}`;

    const garde = cache.get(cle);
    if (garde) {
      return reply
        .header("content-type", garde.type)
        .header("cache-control", "private, max-age=86400")
        .send(garde.buf);
    }

    /** Une adresse du service : clé en en-tête, puis (si refusé) clé en paramètre. */
    const essayer = async (cheminService: string): Promise<{ res?: Response; statut: number }> => {
      let statut = 0;
      for (const mode of ["en-tête", "paramètre"] as const) {
        if (mode === "paramètre" && id === "plex") break;
        try {
          const res = await getRaw(id, `/${cheminService}${suffixe}`, mode === "en-tête" ? IMAGE : { ...IMAGE, cleEnQuery: true });
          statut = res.status;
          if (res.ok) return { res, statut };
          journal(id, cheminService, res.status, mode);
          if (res.status === 404) break; // l'image n'existe pas : inutile d'insister
        } catch {
          journal(id, cheminService, 0, mode);
        }
      }
      return { statut };
    };

    // Radarr/Sonarr fabriquent des versions réduites (poster-250.jpg) : plus légères pour une liste.
    const reduite = w && id !== "plex" ? chemin.replace(/\.jpg$/i, `-${w}.jpg`) : undefined;
    let essai = reduite && reduite !== chemin ? await essayer(reduite) : { statut: 0 };
    if (!essai.res) essai = await essayer(chemin);

    if (essai.res) {
      const type = essai.res.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) {
        const buf = Buffer.from(await essai.res.arrayBuffer());
        cache.set(cle, { buf, type, at: Date.now() });
        return reply.header("content-type", type).header("cache-control", "private, max-age=86400").send(buf);
      }
      journal(id, chemin, essai.statut, "type de réponse inattendu");
    }

    // Dernier recours : l'affiche distante du média (TMDB / TheTVDB), si le service la connaît.
    const m = id !== "plex" ? chemin.match(/^MediaCover\/(\d+)\/poster/) : null;
    if (m && deps.secours) {
      const url = await deps.secours(id, Number(m[1])).catch(() => null);
      const u = url ? urlAutorisee(url) : null;
      if (u) {
        const r = await chargerExterne(reduireTmdb(u));
        if (!("statut" in r)) {
          cache.set(cle, { buf: r.buf, type: r.type, at: Date.now() });
          return reply.header("content-type", r.type).header("cache-control", "private, max-age=86400").send(r.buf);
        }
      }
    }
    return reply.code(essai.statut === 404 ? 404 : 502).send({ error: "Image indisponible" });
  });

  return { vider: () => (cache = new CacheImages()) };
}

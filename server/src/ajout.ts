// Étape C : chercher un film ou une série à ajouter (lookup Radarr/Sonarr) et l'ajouter.
// Le serveur revalide tout : le dossier racine et le profil doivent exister chez le service,
// le titre est relu chez le service (on n'envoie jamais ce que le téléphone prétend).
import type { FastifyInstance } from "fastify";
import { externe } from "./images.js";
import { noteMedia, type GetJson } from "./lecture.js";
import type { ServiceId } from "./services.js";

export type Ecrire = (
  id: ServiceId,
  methode: "POST" | "PUT",
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
) => Promise<Response>;

type Obj = Record<string, any>;
type TypeMedia = "film" | "serie";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SERVICE: Record<TypeMedia, "radarr" | "sonarr"> = { film: "radarr", serie: "sonarr" };
const LIBELLE: Record<TypeMedia, string> = { film: "Radarr", serie: "Sonarr" };

/** Corps JSON d'une requête (le serveur garde les corps bruts) ; null si absent ou invalide. */
export function lireJson(body: unknown): Obj | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const v = JSON.parse(body.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

function resultat(type: TypeMedia, r: Obj) {
  const film = type === "film";
  const posters = Array.isArray(r.images) ? r.images.filter((i: Obj) => i?.coverType === "poster") : [];
  const url = str(posters[0]?.remoteUrl) || str(r.remotePoster);
  const id = num(r.id);
  return {
    type,
    titre: str(r.title),
    annee: num(r.year) || null,
    synopsis: str(r.overview),
    genres: Array.isArray(r.genres) ? r.genres.map(String) : [],
    affiche: externe(url),
    externeId: film ? num(r.tmdbId) : num(r.tvdbId),
    dansBibliotheque: id > 0,
    mediaId: id > 0 ? id : null,
    detail: film ? str(r.studio) || null : str(r.network) || null,
    note: noteMedia(film, r),
    // Pour le tri par date : sortie du film, première diffusion de la série, sinon le 1er janvier de l'année.
    sortie:
      (film ? str(r.digitalRelease) || str(r.physicalRelease) || str(r.inCinemas) : str(r.firstAired)) ||
      (num(r.year) ? `${num(r.year)}-01-01` : null),
  };
}

export function registerAjout(
  app: FastifyInstance,
  getJson: GetJson,
  ecrire: Ecrire,
  configured: (id: ServiceId) => boolean,
  viderListes: () => void,
) {
  // Recherche : ?q=titre&type=tout|film|serie
  app.get("/api/recherche", async (req, reply) => {
    const q = req.query as { q?: string; type?: string };
    const terme = (q.q ?? "").trim();
    if (terme.length < 2 || terme.length > 100) {
      return reply.code(400).send({ error: "Saisis au moins 2 caractères" });
    }
    const types: TypeMedia[] =
      q.type === "film" ? ["film"] : q.type === "serie" ? ["serie"] : ["film", "serie"];
    const actifs = types.filter((t) => configured(SERVICE[t]));
    if (actifs.length === 0) return reply.code(404).send({ error: "Service non configuré" });

    const reponses = await Promise.allSettled(
      actifs.map((t) =>
        getJson(SERVICE[t], `${t === "film" ? "/movie" : "/series"}/lookup?term=${encodeURIComponent(terme)}`, {
          timeoutMs: 30000,
        }),
      ),
    );
    const items = reponses.flatMap((r, i) =>
      r.status === "fulfilled" && Array.isArray(r.value)
        ? (r.value as Obj[]).slice(0, 20).map((x) => resultat(actifs[i], x))
        : [],
    );
    return {
      items: items.filter((i) => i.externeId > 0 && i.titre),
      erreurs: reponses.flatMap((r, i) => (r.status === "rejected" ? [`${LIBELLE[actifs[i]]} injoignable`] : [])),
    };
  });

  /** Dossiers racine et profils de qualité du service : sert à la fois au formulaire et à la validation. */
  async function options(type: TypeMedia) {
    const service = SERVICE[type];
    const [racines, profils] = (await Promise.all([
      getJson(service, "/rootfolder"),
      getJson(service, "/qualityprofile"),
    ])) as [Obj[], Obj[]];
    return {
      racines: racines
        .filter((r) => r.accessible !== false && str(r.path))
        .map((r) => ({ chemin: str(r.path), libreOctets: num(r.freeSpace) })),
      profils: profils.map((p) => ({ id: num(p.id), nom: str(p.name) })),
    };
  }

  app.get("/api/ajout/options/:type", async (req, reply) => {
    const { type } = req.params as { type: string };
    if (type !== "film" && type !== "serie") return reply.code(400).send({ error: "Type invalide" });
    if (!configured(SERVICE[type])) return reply.code(404).send({ error: "Service non configuré" });
    try {
      return await options(type);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Service injoignable" });
    }
  });

  app.post("/api/ajout", async (req, reply) => {
    const b = lireJson(req.body);
    const type = b?.type;
    if (
      !b ||
      (type !== "film" && type !== "serie") ||
      !Number.isInteger(b.externeId) ||
      b.externeId <= 0 ||
      typeof b.racine !== "string" ||
      !Number.isInteger(b.profil) ||
      typeof b.suivi !== "boolean" ||
      typeof b.recherche !== "boolean"
    ) {
      return reply.code(400).send({ error: "Demande invalide" });
    }
    const service = SERVICE[type as TypeMedia];
    if (!configured(service)) return reply.code(404).send({ error: "Service non configuré" });
    const t = type as TypeMedia;
    const label = LIBELLE[t];

    try {
      const opt = await options(t);
      if (!opt.racines.some((r) => r.chemin === b.racine) || !opt.profils.some((p) => p.id === b.profil)) {
        return reply.code(400).send({ error: "Dossier racine ou profil de qualité invalide" });
      }

      // On relit la fiche chez le service : c'est elle qu'on ajoute, avec nos choix par-dessus.
      let fiche: Obj | undefined;
      if (t === "film") {
        const r = await getJson("radarr", `/movie/lookup/tmdb?tmdbId=${b.externeId}`, { timeoutMs: 30000 });
        fiche = (Array.isArray(r) ? r[0] : r) as Obj | undefined;
      } else {
        const r = (await getJson("sonarr", `/series/lookup?term=${encodeURIComponent(`tvdb:${b.externeId}`)}`, {
          timeoutMs: 30000,
        })) as Obj[];
        fiche = r.find((x) => num(x.tvdbId) === b.externeId);
      }
      if (!fiche || !str(fiche.title)) return reply.code(404).send({ error: "Titre introuvable chez le service" });
      if (num(fiche.id) > 0) return reply.code(409).send({ error: "Déjà dans la bibliothèque" });

      const charge =
        t === "film"
          ? {
              ...fiche,
              qualityProfileId: b.profil,
              rootFolderPath: b.racine,
              monitored: b.suivi,
              minimumAvailability: "released",
              addOptions: { monitor: "movieOnly", searchForMovie: b.recherche },
            }
          : {
              ...fiche,
              qualityProfileId: b.profil,
              rootFolderPath: b.racine,
              monitored: b.suivi,
              seasonFolder: true,
              seriesType: str(fiche.seriesType) || "standard",
              addOptions: {
                monitor: b.suivi ? "all" : "none",
                searchForMissingEpisodes: b.recherche,
                searchForCutoffUnmetEpisodes: false,
              },
            };

      const res = await ecrire(service, "POST", t === "film" ? "/movie" : "/series", charge, { timeoutMs: 30000 });
      if (!res.ok) {
        const texte = await res.text().catch(() => "");
        if (/already (been )?added|already exists|existe déjà/i.test(texte)) {
          return reply.code(409).send({ error: "Déjà dans la bibliothèque" });
        }
        return reply.code(502).send({ error: `${label} a refusé l'ajout (HTTP ${res.status})` });
      }
      const cree = (await res.json().catch(() => ({}))) as Obj;
      viderListes();
      return { ok: true, id: num(cree.id) || null, titre: str(cree.title) || str(fiche.title) };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : `${label} injoignable` });
    }
  });
}

// Demandes Overseerr : lister, approuver, refuser.
// Overseerr ne renvoie pas le titre dans une demande : on le demande à TMDB via Overseerr, et on le garde 1 h.
import type { FastifyInstance } from "fastify";
import type { Ecrire } from "./ajout.js";
import { externe } from "./images.js";
import type { GetJson } from "./lecture.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type StatutDemande = "en_attente" | "approuvee" | "refusee" | "echec" | "terminee" | "inconnu";

/** 1 en attente, 2 approuvée, 3 refusée, 4 en échec, 5 terminée (états de demande d'Overseerr). */
export function statutDemande(n: number): StatutDemande {
  return n === 1 ? "en_attente" : n === 2 ? "approuvee" : n === 3 ? "refusee" : n === 4 ? "echec" : n === 5 ? "terminee" : "inconnu";
}

const FILTRES: Record<string, string> = { attente: "pending", approuvees: "approved", refusees: "all", toutes: "all" };
const TTL_FICHE_MS = 3600_000;

export function registerDemandes(
  app: FastifyInstance,
  getJson: GetJson,
  ecrire: Ecrire,
  configured: (id: ServiceId) => boolean,
) {
  const fiches = new Map<string, { at: number; valeur: { titre: string; annee: number | null; affiche: string | null } }>();

  async function fiche(type: "film" | "serie", tmdbId: number) {
    const cle = `${type}:${tmdbId}`;
    const garde = fiches.get(cle);
    if (garde && Date.now() - garde.at < TTL_FICHE_MS) return garde.valeur;
    let valeur: { titre: string; annee: number | null; affiche: string | null };
    try {
      const f = (await getJson("overseerr", `/${type === "film" ? "movie" : "tv"}/${tmdbId}`)) as Obj;
      const date = str(type === "film" ? f.releaseDate : f.firstAirDate);
      valeur = {
        titre: str(type === "film" ? f.title : f.name) || `Titre inconnu (TMDB ${tmdbId})`,
        annee: Number(date.slice(0, 4)) || null,
        affiche: f.posterPath ? externe(`https://image.tmdb.org/t/p/w342${str(f.posterPath)}`) : null,
      };
    } catch {
      return { titre: `Titre inconnu (TMDB ${tmdbId})`, annee: null, affiche: null }; // pas mis en cache : on réessaiera
    }
    fiches.set(cle, { at: Date.now(), valeur });
    return valeur;
  }

  app.get("/api/demandes", async (req, reply) => {
    if (!configured("overseerr")) return reply.code(404).send({ error: "Overseerr n'est pas configuré" });
    const filtre = (req.query as { filtre?: string }).filtre ?? "attente";
    if (!(filtre in FILTRES)) return reply.code(400).send({ error: "Filtre invalide" });
    try {
      const rep = (await getJson(
        "overseerr",
        `/request?take=${filtre === "refusees" ? 100 : 40}&skip=0&filter=${FILTRES[filtre]}&sort=added`,
      )) as Obj;
      let brutes: Obj[] = rep.results ?? [];
      if (filtre === "refusees") brutes = brutes.filter((r) => num(r.status) === 3);

      const uniques = new Map<string, { type: "film" | "serie"; tmdbId: number }>();
      for (const r of brutes) {
        const type = r.type === "tv" ? "serie" : "film";
        const tmdbId = num(r.media?.tmdbId);
        if (tmdbId) uniques.set(`${type}:${tmdbId}`, { type, tmdbId });
      }
      // Cinq fiches à la fois : on ménage Overseerr.
      const details = new Map<string, Awaited<ReturnType<typeof fiche>>>();
      const liste = [...uniques.entries()];
      for (let i = 0; i < liste.length; i += 5) {
        await Promise.all(
          liste.slice(i, i + 5).map(async ([cle, v]) => details.set(cle, await fiche(v.type, v.tmdbId))),
        );
      }

      const items = brutes.map((r) => {
        const type = r.type === "tv" ? ("serie" as const) : ("film" as const);
        const d = details.get(`${type}:${num(r.media?.tmdbId)}`);
        const demandeur = r.requestedBy;
        return {
          id: num(r.id),
          statut: statutDemande(num(r.status)),
          type,
          titre: d?.titre ?? "Titre inconnu",
          annee: d?.annee ?? null,
          affiche: d?.affiche ?? null,
          demandeur: str(demandeur?.displayName) || str(demandeur?.username) || str(demandeur?.email) || "Inconnu",
          date: str(r.createdAt),
          saisons: Array.isArray(r.seasons) ? r.seasons.map((s: Obj) => num(s.seasonNumber)).filter((n: number) => n > 0) : [],
          quatreK: r.is4k === true,
        };
      });
      return { items };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Overseerr injoignable" });
    }
  });

  // Nombre de demandes en attente (pastille de l'accueil et des onglets).
  app.get("/api/demandes/compteur", async (_req, reply) => {
    if (!configured("overseerr")) return reply.code(404).send({ error: "Overseerr n'est pas configuré" });
    try {
      const c = (await getJson("overseerr", "/request/count")) as Obj;
      return { enAttente: num(c.pending) };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Overseerr injoignable" });
    }
  });

  for (const [action, chemin, verbe] of [
    ["approuver", "approve", "approuver"],
    ["refuser", "decline", "refuser"],
  ] as const) {
    app.post(`/api/demandes/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!/^\d{1,9}$/.test(id)) return reply.code(400).send({ error: "Demande invalide" });
      if (!configured("overseerr")) return reply.code(404).send({ error: "Overseerr n'est pas configuré" });
      try {
        const res = await ecrire("overseerr", "POST", `/request/${id}/${chemin}`, {});
        if (res.status === 404) return reply.code(404).send({ error: "Cette demande n'existe plus" });
        if (res.status === 403) return reply.code(403).send({ error: `Cette clé API n'a pas le droit de ${verbe} les demandes` });
        if (!res.ok) return reply.code(502).send({ error: `Overseerr a refusé (HTTP ${res.status})` });
        return { ok: true };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : "Overseerr injoignable" });
      }
    });
  }
}

// Actions qui modifient quelque chose chez un service (étape B : qBittorrent).
// Routes dédiées plutôt que le relais générique : on valide chaque paramètre et on ne
// laisse passer que ce que l'interface sait faire.
import type { FastifyInstance } from "fastify";
import type { ServiceId } from "./services.js";

export type QbitPost = (path: string, params: Record<string, string>) => Promise<Response>;

// Empreinte d'un torrent : 40 caractères hexadécimaux (v1) ou 64 (v2).
const HASH = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

export function registerActions(
  app: FastifyInstance,
  qbitPost: QbitPost,
  configured: (id: ServiceId) => boolean,
) {
  /** Envoie une commande qBittorrent. `alternative` : ancien nom de la commande (qBittorrent 4). */
  async function commande(
    chemin: string,
    params: Record<string, string>,
    alternative?: string,
  ): Promise<Response> {
    let res = await qbitPost(chemin, params);
    // qBittorrent 5 a renommé pause/resume en stop/start : on essaie l'autre nom si le premier n'existe pas.
    if (res.status === 404 && alternative) res = await qbitPost(alternative, params);
    return res;
  }

  function route(
    methode: "POST" | "DELETE",
    url: string,
    action: (hash: string, req: { query: Record<string, string> }) => Promise<Response>,
  ) {
    app.route({
      method: methode,
      url,
      handler: async (req, reply) => {
        if (!configured("qbittorrent")) {
          return reply.code(404).send({ error: "qBittorrent n'est pas configuré" });
        }
        const params = req.params as Record<string, string>;
        if (!HASH.test(params.hash ?? "")) return reply.code(400).send({ error: "Torrent invalide" });
        try {
          const res = await action(params.hash, { query: req.query as Record<string, string> });
          if (res.status === 409) {
            return reply.code(409).send({
              error: "La file d'attente n'est pas activée dans qBittorrent (Options → BitTorrent).",
            });
          }
          if (!res.ok) return reply.code(502).send({ error: `qBittorrent : HTTP ${res.status}` });
          return { ok: true };
        } catch (e) {
          return reply.code(502).send({ error: e instanceof Error ? e.message : "qBittorrent injoignable" });
        }
      },
    });
  }

  route("POST", "/api/activite/:hash/pause", (hashes) =>
    commande("/torrents/stop", { hashes }, "/torrents/pause"),
  );
  route("POST", "/api/activite/:hash/reprise", (hashes) =>
    commande("/torrents/start", { hashes }, "/torrents/resume"),
  );
  route("POST", "/api/activite/:hash/priorite/tete", (hashes) =>
    commande("/torrents/topPrio", { hashes }),
  );
  route("POST", "/api/activite/:hash/priorite/fin", (hashes) =>
    commande("/torrents/bottomPrio", { hashes }),
  );
  route("DELETE", "/api/activite/:hash", (hashes, { query }) =>
    commande("/torrents/delete", { hashes, deleteFiles: query.fichiers === "1" ? "true" : "false" }),
  );
}

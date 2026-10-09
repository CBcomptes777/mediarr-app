// Routes de l'écran Réglages → Notifications : état, journal des 50 dernières notifications et bouton « test ».
// Rien de ce qui permettrait de retrouver ou d'utiliser le serveur ntfy (adresse, sujet, jeton) n'est renvoyé.
import type { FastifyInstance } from "fastify";
import type { Surveillant } from "./surveillant.js";

export const MESSAGE_NTFY_ABSENT = "Notifications : définis NTFY_URL et NTFY_TOPIC";

export function registerNotifications(app: FastifyInstance, surveillant: Surveillant) {
  app.get("/api/notifications/etat", async () => ({
    configure: surveillant.actif,
    message: surveillant.actif ? null : MESSAGE_NTFY_ABSENT,
    ...surveillant.resume(),
  }));

  // Protégée comme toute route /api qui écrit : jeton d'accès + en-tête X-Requested-With.
  app.post("/api/notifications/test", async (_req, reply) => {
    if (!surveillant.actif) return reply.code(409).send({ error: MESSAGE_NTFY_ABSENT });
    const r = await surveillant.notifier("test", "Notification de test", "Si tu lis ceci, les notifications de Mediarr fonctionnent.", 3, ["bell"]);
    return r.ok ? { ok: true } : reply.code(502).send({ error: r.erreur ?? "Envoi impossible" });
  });
}

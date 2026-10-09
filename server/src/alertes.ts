// Bloc « Alertes » de l'accueil : regroupe les avertissements de plusieurs sources (santé de Prowlarr, puis le surveillant).
// Une source qui échoue ne fait pas disparaître les autres.
import type { FastifyInstance } from "fastify";
import type { AlerteApp } from "./prowlarr.js";

export type SourceAlertes = () => Promise<AlerteApp[]> | AlerteApp[];

export function registerAlertes(app: FastifyInstance, sources: SourceAlertes[]) {
  app.get("/api/alertes", async () => {
    const reponses = await Promise.allSettled(sources.map((s) => Promise.resolve().then(s)));
    const items = reponses.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const gravite = { critique: 0, erreur: 1, avertissement: 2 } as const;
    items.sort((a, b) => gravite[a.niveau] - gravite[b.niveau]);
    return { items };
  });
}

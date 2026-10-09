// Erreur d'un appel à un service (Radarr, Plex…) qui garde de quoi expliquer l'échec :
// la nature (réseau, accès refusé, réponse illisible, autre erreur HTTP), le code HTTP et un extrait du corps.
// L'extrait est purgé des secrets avant d'arriver ici (voir `journal.purger`).

export type NatureErreur = "reseau" | "refuse" | "illisible" | "http";

export class ErreurService extends Error {
  constructor(
    message: string,
    public nature: NatureErreur,
    public statut?: number,
    /** 200 premiers caractères de la réponse, sans secret. */
    public apercu?: string,
  ) {
    super(message);
    this.name = "ErreurService";
  }

  /** « HTTP 401 — <html>Unauthorized… » : le détail affiché sous le message. */
  get detail(): string {
    return [this.statut ? `HTTP ${this.statut}` : null, this.apercu].filter(Boolean).join(" — ");
  }
}

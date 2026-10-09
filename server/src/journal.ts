// Journal des connexions échouées par service, pour l'écran Réglages → Avancé.
// Règle absolue : aucune clé. On ne garde que le service, le chemin SANS paramètres, le statut et un message
// qu'on a purgé de tous les secrets connus (clés API, jeton, mot de passe).
import type { FastifyInstance } from "fastify";
import type { Env } from "./services.js";

export interface EntreeJournal {
  date: string;
  service: string;
  chemin: string;
  /** 0 = pas de réponse (service éteint, délai dépassé…). */
  statut: number;
  message: string;
  /** Combien de fois de suite (même service, chemin et statut, en moins d'une minute). */
  compteur: number;
}

const MAX = 200;

/** Les valeurs de toutes les variables qui ressemblent à un secret. */
function secretsDe(env: Env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|PASS|SECRET/i.test(k) && typeof v === "string" && v.trim().length >= 4)
    .map(([, v]) => v!.trim());
}

export class Journal {
  private entrees: EntreeJournal[] = [];
  constructor(private secrets: string[]) {}

  static depuis(env: Env) {
    return new Journal(secretsDe(env));
  }

  /** Remplace chaque secret connu (et sa forme encodée) par « *** ». */
  purger(texte: string): string {
    let t = texte;
    for (const s of this.secrets) {
      t = t.split(s).join("***");
      const enc = encodeURIComponent(s);
      if (enc !== s) t = t.split(enc).join("***");
    }
    return t;
  }

  ajouter(service: string, chemin: string, statut: number, message: string) {
    const propre = this.purger(chemin.split("?")[0]).slice(0, 200);
    const msg = this.purger(message).slice(0, 200);
    const dernier = this.entrees[0];
    const maintenant = Date.now();
    if (
      dernier &&
      dernier.service === service &&
      dernier.chemin === propre &&
      dernier.statut === statut &&
      maintenant - new Date(dernier.date).getTime() < 60_000
    ) {
      dernier.compteur++;
      dernier.date = new Date(maintenant).toISOString();
      return;
    }
    this.entrees.unshift({ date: new Date(maintenant).toISOString(), service, chemin: propre, statut, message: msg, compteur: 1 });
    if (this.entrees.length > MAX) this.entrees.length = MAX;
  }

  /** Une réponse HTTP vaut-elle d'être notée ? 404 et autres refus « normaux » non ; erreurs serveur et accès refusé oui. */
  static notable(statut: number): boolean {
    return statut >= 500 || statut === 401 || statut === 403 || statut === 408 || statut === 429;
  }

  lister(): EntreeJournal[] {
    return this.entrees;
  }

  vider() {
    this.entrees = [];
  }
}

/** Code d'erreur réseau (ECONNREFUSED…) : il peut être dans `cause`, ou dans les erreurs d'une AggregateError (Node 24). */
export function codeReseau(e: unknown, profondeur = 0): string | undefined {
  if (!e || typeof e !== "object" || profondeur > 4) return undefined;
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof o.code === "string") return o.code;
  for (const suite of [o.cause, ...(Array.isArray(o.errors) ? o.errors : [])]) {
    const c = codeReseau(suite, profondeur + 1);
    if (c) return c;
  }
  return undefined;
}

/** Cause d'une erreur réseau, en français : « connexion refusée », « délai dépassé »… (sinon le message tel quel). */
export function causeLisible(e: unknown): string {
  const code = codeReseau(e);
  const message = e instanceof Error ? e.message : "erreur inconnue";
  if (code === "ECONNREFUSED") return "connexion refusée";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "adresse introuvable";
  if (code === "ECONNRESET") return "connexion coupée";
  if (code === "ETIMEDOUT" || (e as Error)?.name === "TimeoutError" || /timeout|aborted/i.test(message)) return "délai dépassé";
  return message;
}

export function messageErreur(e: unknown): string {
  if (!(e instanceof Error)) return "Erreur inconnue";
  const code = codeReseau(e);
  if (e.name === "TimeoutError" || /timeout|aborted/i.test(e.message)) return "Délai dépassé";
  return code ? `${e.message} (${code})` : e.message;
}

export function registerJournal(app: FastifyInstance, journal: Journal) {
  app.get("/api/journal", async () => ({ items: journal.lister() }));
  app.delete("/api/journal", async () => {
    journal.vider();
    return { ok: true };
  });
}

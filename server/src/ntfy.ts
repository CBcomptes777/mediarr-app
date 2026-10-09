// Envoi de notifications à un serveur ntfy (https://docs.ntfy.sh/publish/).
// On publie en JSON à la racine du serveur : les accents du titre passent sans souci (les en-têtes HTTP, eux, sont limités
// à l'ASCII). Le jeton, le sujet (qui sert un peu de mot de passe sur ntfy) et l'adresse ne sortent jamais d'ici : ni dans les
// erreurs, ni dans les journaux, ni dans l'interface.
import type { Env } from "./services.js";

export interface ConfigNtfy {
  url: string;
  topic: string;
  token?: string;
}

export interface Notif {
  titre: string;
  message: string;
  /** 1 (minimale) à 5 (urgente). */
  priorite: 1 | 2 | 3 | 4 | 5;
  /** Codes d'émojis ntfy (« warning », « white_check_mark »…). */
  tags?: string[];
}

export type EnvoiNtfy = (n: Notif) => Promise<void>;

/** null quand NTFY_URL ou NTFY_TOPIC manque ou est invalide : la fonction est alors désactivée, sans erreur. */
export function configNtfy(env: Env): ConfigNtfy | null {
  const brut = env.NTFY_URL?.trim();
  const topic = env.NTFY_TOPIC?.trim();
  if (!brut || !topic || !/^[\w.-]{1,64}$/.test(topic)) return null;
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const token = env.NTFY_TOKEN?.trim();
  return { url: url.origin + url.pathname.replace(/\/+$/, ""), topic, ...(token ? { token } : {}) };
}

/** Retire de n'importe quel texte tout ce qui permettrait de retrouver le serveur ou d'y publier. */
export function purgerNtfy(texte: string, cfg: ConfigNtfy): string {
  let t = texte;
  for (const secret of [cfg.token, cfg.topic, cfg.url, new URL(cfg.url).host]) {
    if (secret && secret.length >= 3) t = t.split(secret).join("***");
  }
  return t;
}

export function creerEnvoiNtfy(cfg: ConfigNtfy, fetchImpl: typeof fetch = fetch, delaiMs = 10_000): EnvoiNtfy {
  return async (n) => {
    let res: Response;
    try {
      res = await fetchImpl(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify({ topic: cfg.topic, title: n.titre, message: n.message, priority: n.priorite, tags: n.tags ?? [] }),
        signal: AbortSignal.timeout(delaiMs),
      });
    } catch (e) {
      const brut = e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : "";
      const cause = /abort|timeout/i.test(brut) ? "délai dépassé" : /ECONNREFUSED|refused/i.test(brut) ? "connexion refusée" : "connexion impossible";
      throw new Error(`ntfy injoignable (${cause})`);
    }
    if (!res.ok) {
      const raison = res.status === 401 || res.status === 403 ? " : jeton refusé ou sujet protégé" : "";
      throw new Error(`ntfy a répondu HTTP ${res.status}${raison}`);
    }
  };
}

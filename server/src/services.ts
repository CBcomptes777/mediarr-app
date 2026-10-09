// Définition des services branchés. Seuls ceux dont l'URL est renseignée sont actifs.
// Les clés API restent ici, côté serveur : le téléphone ne les voit jamais.

export type ServiceId = "radarr" | "sonarr" | "overseerr" | "qbittorrent" | "plex" | "prowlarr" | "homarr";

export interface ServiceDef {
  id: ServiceId;
  label: string;
  baseUrl: string;
  /** Préfixe de l'API du service (ex. /api/v3 pour Radarr). */
  apiPrefix: string;
  /** Chemin (relatif au préfixe) utilisé pour tester que le service répond. */
  healthPath: string;
  /** Extrait un numéro de version de la réponse de santé, si possible. */
  version?: (body: unknown) => string | undefined;
}

export interface Env {
  [key: string]: string | undefined;
}

function clean(url: string | undefined): string | undefined {
  const v = url?.trim();
  if (!v) return undefined;
  return v.replace(/\/+$/, "");
}

export function loadServices(env: Env): ServiceDef[] {
  const defs: Array<ServiceDef | undefined> = [
    clean(env.RADARR_URL)
      ? {
          id: "radarr",
          label: "Radarr",
          baseUrl: clean(env.RADARR_URL)!,
          apiPrefix: "/api/v3",
          healthPath: "/system/status",
          version: (b) => (b as { version?: string })?.version,
        }
      : undefined,
    clean(env.SONARR_URL)
      ? {
          id: "sonarr",
          label: "Sonarr",
          baseUrl: clean(env.SONARR_URL)!,
          apiPrefix: "/api/v3",
          healthPath: "/system/status",
          version: (b) => (b as { version?: string })?.version,
        }
      : undefined,
    clean(env.OVERSEERR_URL)
      ? {
          id: "overseerr",
          label: "Overseerr",
          baseUrl: clean(env.OVERSEERR_URL)!,
          apiPrefix: "/api/v1",
          healthPath: "/status",
          version: (b) => (b as { version?: string })?.version,
        }
      : undefined,
    clean(env.QBIT_URL)
      ? {
          id: "qbittorrent",
          label: "qBittorrent",
          baseUrl: clean(env.QBIT_URL)!,
          apiPrefix: "/api/v2",
          healthPath: "/app/version",
        }
      : undefined,
    clean(env.PROWLARR_URL)
      ? {
          id: "prowlarr",
          label: "Prowlarr",
          baseUrl: clean(env.PROWLARR_URL)!,
          apiPrefix: "/api/v1",
          healthPath: "/system/status",
          version: (b) => (b as { version?: string })?.version,
        }
      : undefined,
    // Homarr : simple ping de la page d'accueil (aucune API utilisée, voir CLAUDE.md).
    clean(env.HOMARR_URL)
      ? {
          id: "homarr",
          label: "Homarr",
          baseUrl: clean(env.HOMARR_URL)!,
          apiPrefix: "",
          healthPath: "/",
        }
      : undefined,
    clean(env.PLEX_URL)
      ? {
          id: "plex",
          label: "Plex",
          baseUrl: clean(env.PLEX_URL)!,
          apiPrefix: "",
          healthPath: "/identity",
          version: (b) =>
            (b as { MediaContainer?: { version?: string } })?.MediaContainer?.version,
        }
      : undefined,
  ];
  return defs.filter((d): d is ServiceDef => d !== undefined);
}

/** En-têtes d'authentification propres à chaque service. */
export function authHeaders(id: ServiceId, env: Env): Record<string, string> {
  switch (id) {
    case "radarr":
      return env.RADARR_API_KEY ? { "X-Api-Key": env.RADARR_API_KEY } : {};
    case "sonarr":
      return env.SONARR_API_KEY ? { "X-Api-Key": env.SONARR_API_KEY } : {};
    case "overseerr":
      return env.OVERSEERR_API_KEY ? { "X-Api-Key": env.OVERSEERR_API_KEY } : {};
    case "prowlarr":
      return env.PROWLARR_API_KEY ? { "X-Api-Key": env.PROWLARR_API_KEY } : {};
    case "homarr":
      return {}; // Homarr : simple ping, aucune clé (voir CLAUDE.md)
    case "plex":
      return env.PLEX_TOKEN?.trim()
        ? { "X-Plex-Token": env.PLEX_TOKEN.trim(), Accept: "application/json" }
        : { Accept: "application/json" };
    case "qbittorrent":
      return {}; // gérée par session (cookie), voir qbit.ts
  }
}

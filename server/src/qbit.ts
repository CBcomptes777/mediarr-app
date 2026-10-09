// qBittorrent n'utilise pas de clé API : il ouvre une session (cookie SID).
// On se connecte une fois, on garde le cookie, et on se reconnecte si le service répond 403.

export class QbitSession {
  private cookie: string | undefined;

  constructor(
    private baseUrl: string,
    private user: string,
    private pass: string,
  ) {}

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // qBittorrent refuse les requêtes dont l'origine ne correspond pas à son hôte.
        Referer: this.baseUrl,
      },
      body: new URLSearchParams({ username: this.user, password: this.pass }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    const setCookie = res.headers.get("set-cookie");
    if (!res.ok || text.trim() !== "Ok." || !setCookie) {
      throw new Error("Connexion qBittorrent refusée (identifiants ?)");
    }
    this.cookie = setCookie.split(";")[0];
  }

  /** Fait une requête authentifiée, avec une reconnexion automatique si la session a expiré. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.cookie) await this.login();
    const doFetch = () =>
      fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Cookie: this.cookie!,
          Referer: this.baseUrl,
        },
        signal: init.signal ?? AbortSignal.timeout(8000),
      });
    let res = await doFetch();
    if (res.status === 403) {
      await this.login();
      res = await doFetch();
    }
    return res;
  }
}

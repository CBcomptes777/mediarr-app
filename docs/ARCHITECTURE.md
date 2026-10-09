# Architecture

Mediarr = a **Fastify (TypeScript) server** + a **React (Vite) web app** served by that server.

```
server/src
  server.ts          app assembly, security hooks, generic service access (getRaw / getJson / ecrire)
  services.ts        service definitions (URL, API key header) read from environment variables
  prefs.ts           settings stored in DATA_DIR/prefs.json (validated on every write)
  lecture.ts         library, calendar, home, history, details
  releases.ts        manual / interactive search and sending a release to the download client
  decouvrir.ts       Overseerr "Discover" and requests
  torrents.ts        qBittorrent control (+ qbitEtat.ts: state kept by diffs via sync/maindata)
  prowlarr.ts        indexers, tests, statistics, search
  surveillant.ts     background watcher + ntfy.ts client (notifications)
  webhooks.ts        incoming webhooks and their automatic configuration
web/src              screens (React), pure logic in *Logique.ts files (tested)
```

## Security model

- Every `/api` request needs `Authorization: Bearer <ACCESS_TOKEN>` when `ACCESS_TOKEN` is set.
- Every non-GET request needs `X-Requested-With: mediarr` (CSRF protection), except the three webhook
  receivers, which use their own `WEBHOOK_SECRET` (constant-time comparison).
- API keys and the qBittorrent session cookie never leave the server; images are relayed through an
  allow-list; error messages and logs are scrubbed of known secrets.
- Destructive qBittorrent actions need an explicit confirmation validated server-side.
- There is a single shared token and no user accounts: do not expose the app to the Internet.

## Tests

`cd server && npm test` runs every test (server and the pure web logic) against **fake HTTP services**.
No real Radarr / Sonarr / qBittorrent… is contacted, nothing is added, deleted or paused anywhere.

## Before using it with sensitive data

- Keep `.env` and the `/data` volume out of version control.
- Serve the app over HTTPS when it is reachable from outside your home network (VPN or reverse proxy).

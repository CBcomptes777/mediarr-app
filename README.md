# Mediarr

**Français** · [English](#english)

Tableau de bord web (PWA pensée pour l'iPhone) qui regroupe **Radarr, Sonarr, Overseerr, qBittorrent, Plex, Prowlarr** et un lien vers **Homarr** dans une seule interface, avec un style « verre » violet. Les clés API restent **uniquement sur le serveur** : le navigateur ne les voit jamais.

> ## ⚠️ Avertissement
> Mediarr est conçu pour un **usage personnel**, sur un réseau domestique. Il donne accès à des actions sensibles (suppression de torrents, ajout de médias, demandes…) avec **un seul jeton partagé** et aucun compte utilisateur.
> **Ne l'expose jamais directement sur Internet.** Pour y accéder à distance, passe par un VPN (Tailscale, WireGuard) ou un reverse proxy HTTPS avec authentification, et définis toujours `ACCESS_TOKEN`.
> Le logiciel est fourni « tel quel », sans garantie (voir [LICENSE](LICENSE)). Sauvegarde tes données avant d'essayer les fonctions qui modifient ou suppriment.

## Fonctionnalités

- **Accueil** à widgets (services, aperçu, derniers téléchargements, stockage, qBittorrent, Plex en lecture, prochaines sorties, alertes), réordonnables.
- **Bibliothèque** Radarr + Sonarr : recherche, filtres (statut, genre, décennie, qualité, langue, studio…), tri, filtres enregistrés.
- **Calendrier** : vues mois / semaine / liste, jours cliquables, filtres.
- **Recherche manuelle / interactive** (films, épisodes, saisons) avec filtres langue, indexeur, résolution, seeders, et envoi au client de téléchargement après confirmation.
- **Overseerr** : demandes (approuver / refuser) et **Découvrir** (tendances, populaires, à venir, genres, demande de titres).
- **qBittorrent** : ajout (magnet, URL, fichiers `.torrent`), pause / reprise, catégories, étiquettes, limites, déplacement, suppression avec confirmation, sélection multiple, détails (fichiers, trackers, pairs), vitesses globales.
- **Prowlarr** : état des indexeurs, tests, statistiques, recherche en lecture seule ou envoi d'un résultat.
- **Plex** : lectures en cours. **Homarr** : ping et lien.
- **Notifications [ntfy](https://ntfy.sh)** : disque presque plein, indexeur en échec, torrent bloqué, service hors ligne, résumé hebdomadaire.
- **Webhooks** entrants (Radarr, Sonarr, Overseerr), thèmes clair / sombre, couleur d'accent, installation comme app sur l'écran d'accueil.

## Installation

### Avec Docker Compose

```sh
git clone https://github.com/OWNER/mediarr.git && cd mediarr
cp .env.example .env        # puis remplis .env (voir « Variables »)
docker compose up -d --build
```

Ouvre `http://<ip-de-la-machine>:8080`. Par défaut, l'image est construite depuis les sources. Pour utiliser l'image publiée, commente `build: .` et décommente la ligne `image: ghcr.io/OWNER/mediarr:latest` (remplace `OWNER` par ton compte GitHub).

### Sur TrueNAS SCALE (application personnalisée)

1. *Apps → Discover Apps → Custom App* (ou *Install via YAML*).
2. **Image** : `ghcr.io/OWNER/mediarr:latest` (politique de téléchargement : *Always* pour recevoir les mises à jour).
3. **Port** : conteneur `8080` → port du NAS libre, par exemple `30080`.
4. **Stockage** : monte un dossier du pool sur `/data` (réglages de l'app). Le conteneur tourne avec l'utilisateur `node` (uid 1000) : ce dossier doit lui être inscriptible.
5. **Variables d'environnement** : celles de `.env.example` (au minimum `ACCESS_TOKEN` et l'URL + la clé de chaque service que tu utilises). Les URL sont celles **vues depuis le conteneur** : l'IP du NAS et le port de chaque application, pas `localhost`.
6. Lance, puis ouvre `http://<ip-du-nas>:30080`. Entre ton `ACCESS_TOKEN` à la première ouverture.

Équivalent en YAML :

```yaml
services:
  mediarr:
    image: ghcr.io/OWNER/mediarr:latest
    restart: unless-stopped
    ports:
      - "30080:8080"
    environment:
      ACCESS_TOKEN: "change-me-to-a-long-random-phrase"
      RADARR_URL: "http://192.168.1.10:7878"
      RADARR_API_KEY: "0123456789abcdef0123456789abcdef"
      # … autres services : voir .env.example
    volumes:
      - /mnt/POOL/mediarr:/data
```

> Sans volume sur `/data`, les réglages sont perdus quand le conteneur est recréé : un avertissement s'affiche dans Réglages.

## Variables

Toutes sont décrites dans [`.env.example`](.env.example). Une URL vide désactive le service.

| Variable | Rôle |
|---|---|
| `ACCESS_TOKEN` | Jeton exigé par l'app (recommandé) |
| `WEBHOOK_SECRET`, `MEDIARR_URL` | Webhooks entrants et leur configuration automatique |
| `DATA_DIR`, `PORT` | Dossier des réglages (`/data`), port d'écoute (`8080`) |
| `RADARR_URL`, `RADARR_API_KEY` | Radarr |
| `SONARR_URL`, `SONARR_API_KEY` | Sonarr |
| `OVERSEERR_URL`, `OVERSEERR_API_KEY` | Overseerr |
| `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` | qBittorrent (interface Web) |
| `PLEX_URL`, `PLEX_TOKEN` | Plex |
| `PROWLARR_URL`, `PROWLARR_API_KEY` | Prowlarr (facultatif) |
| `HOMARR_URL`, `HOMARR_OPEN_URL` | Homarr (facultatif) |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | Notifications ntfy (facultatif) |

### Notifications ntfy

Installe un serveur ntfy (image `binwiederhier/ntfy`, commande `serve`), abonne l'app ntfy de ton téléphone à un sujet long et aléatoire, puis renseigne `NTFY_URL` et `NTFY_TOPIC`. Réglages → Notifications permet de choisir les alertes, les seuils et d'envoyer un test. Sur iPhone, un ntfy auto-hébergé a besoin de `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` côté serveur ntfy pour les notifications en arrière-plan.

## Accès à distance avec Tailscale

1. Installe [Tailscale](https://tailscale.com) sur le serveur (application TrueNAS ou paquet) et sur ton téléphone, avec le même compte.
2. Ouvre Mediarr par l'adresse Tailscale du serveur (`http://100.x.y.z:30080` ou son nom `*.ts.net`), ou publie-le en HTTPS : `tailscale serve --bg 30080`.
3. Dans Réglages → Réseau, renseigne l'adresse « maison » et l'adresse Tailscale : l'app indique où tu es connecté et propose l'autre adresse si une coupure survient.

Ne configure **pas** de « Funnel » Tailscale (exposition publique) pour Mediarr.

## Mise à jour

- Image publiée : redéploie l'application (TrueNAS : *Update / Redeploy* avec *Always pull*), ou `docker compose pull && docker compose up -d`.
- Construction locale : `git pull && docker compose up -d --build`.
- Tes réglages (volume `/data`) sont conservés.

## Développement

```sh
cd server && npm ci && npm test && npm run build    # serveur (Fastify, TypeScript)
cd web && npm ci && npm run build                   # application web (React, Vite)
```

Les tests utilisent de faux services : aucun service réel n'est contacté. Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Licence

[MIT](LICENSE)

---

<a id="english"></a>

# Mediarr (English)

[Français](#mediarr) · **English**

A web dashboard (a PWA designed for the iPhone) that brings **Radarr, Sonarr, Overseerr, qBittorrent, Plex, Prowlarr** and a link to **Homarr** into a single purple "glass" interface. API keys stay **on the server only**: the browser never sees them. (The interface itself is in French.)

> ## ⚠️ Warning
> Mediarr is built for **personal use** on a home network. It exposes sensitive actions (deleting torrents, adding media, requests…) behind **a single shared token** and no user accounts.
> **Never expose it directly to the Internet.** For remote access use a VPN (Tailscale, WireGuard) or an HTTPS reverse proxy with authentication, and always set `ACCESS_TOKEN`.
> The software is provided "as is", without warranty (see [LICENSE](LICENSE)). Back up your data before trying features that modify or delete things.

## Features

- Widget-based **home** (services, overview, latest downloads, storage, qBittorrent, Plex now playing, upcoming releases, alerts), re-orderable.
- Radarr + Sonarr **library**: search, filters (status, genre, decade, quality, language, studio…), sorting, saved filters.
- **Calendar**: month / week / list views, clickable days, filters.
- **Manual / interactive search** (movies, episodes, seasons) with language, indexer, resolution and seeders filters, and sending to the download client after confirmation.
- **Overseerr**: requests (approve / decline) and **Discover** (trending, popular, upcoming, genres, requesting titles).
- **qBittorrent**: add (magnet, URL, `.torrent` files), pause / resume, categories, tags, limits, move, delete with confirmation, multi-select, details (files, trackers, peers), global speeds.
- **Prowlarr**: indexer status, tests, statistics, read-only search or sending a result.
- **Plex**: now playing. **Homarr**: ping and link.
- **[ntfy](https://ntfy.sh) notifications**: low disk space, failing indexer, stuck torrent, service offline, weekly summary.
- Incoming **webhooks** (Radarr, Sonarr, Overseerr), light / dark themes, accent colour, installable on the home screen.

## Installation

### Docker Compose

```sh
git clone https://github.com/OWNER/mediarr.git && cd mediarr
cp .env.example .env        # then edit .env (see "Variables")
docker compose up -d --build
```

Open `http://<machine-ip>:8080`. By default the image is built from source. To use the published image, comment out `build: .` and uncomment the `image: ghcr.io/OWNER/mediarr:latest` line (replace `OWNER` with your GitHub account).

### TrueNAS SCALE (Custom App)

1. *Apps → Discover Apps → Custom App* (or *Install via YAML*).
2. **Image**: `ghcr.io/OWNER/mediarr:latest` (pull policy *Always* to receive updates).
3. **Port**: container `8080` → a free NAS port, e.g. `30080`.
4. **Storage**: mount a pool dataset on `/data` (app settings). The container runs as user `node` (uid 1000): the folder must be writable by it.
5. **Environment variables**: those of `.env.example` (at least `ACCESS_TOKEN` and the URL + key of each service you use). URLs are the ones **seen from the container**: the NAS IP and each app's port, not `localhost`.
6. Start it and open `http://<nas-ip>:30080`. Enter your `ACCESS_TOKEN` on first launch.

YAML equivalent: see the example in the French section above.

> Without a volume on `/data`, settings are lost when the container is recreated; a warning is shown in Settings.

## Variables

All are documented in [`.env.example`](.env.example). An empty URL disables the service. See the table in the French section.

### ntfy notifications

Run a ntfy server (image `binwiederhier/ntfy`, command `serve`), subscribe your phone's ntfy app to a long random topic, then set `NTFY_URL` and `NTFY_TOPIC`. Settings → Notifications lets you choose alerts and thresholds and send a test. On iPhone, a self-hosted ntfy needs `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` on the ntfy server for background notifications.

## Remote access with Tailscale

1. Install [Tailscale](https://tailscale.com) on the server (TrueNAS app or package) and on your phone, with the same account.
2. Open Mediarr through the server's Tailscale address (`http://100.x.y.z:30080` or its `*.ts.net` name), or publish it over HTTPS: `tailscale serve --bg 30080`.
3. In Settings → Network, enter the "home" and Tailscale addresses: the app shows where you are connected and offers the other address if the connection drops.

Do **not** enable Tailscale "Funnel" (public exposure) for Mediarr.

## Updating

- Published image: redeploy the app (TrueNAS: *Update / Redeploy* with *Always pull*), or `docker compose pull && docker compose up -d`.
- Local build: `git pull && docker compose up -d --build`.
- Your settings (the `/data` volume) are kept.

## Development

```sh
cd server && npm ci && npm test && npm run build    # server (Fastify, TypeScript)
cd web && npm ci && npm run build                   # web app (React, Vite)
```

Tests use fake services: no real service is contacted. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)

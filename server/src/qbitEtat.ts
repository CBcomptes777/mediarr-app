// État de qBittorrent tenu à jour par différences (sync/maindata avec `rid`) : on ne redemande jamais toute la liste, ce qui
// ménage qBittorrent même avec des milliers de torrents et une app qui l'interroge toutes les 3 secondes.
import { etatTorrent, type EtatTorrent } from "./lecture.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Une lecture complète est redemandée de temps en temps, au cas où une différence aurait été manquée. */
const RELECTURE_COMPLETE_MS = 5 * 60_000;
/** Deux appels très rapprochés (plusieurs écrans, rafraîchissements) partagent la même lecture. */
const FRAICHEUR_MS = 800;

export class EtatQbit {
  private rid = 0;
  private torrents = new Map<string, Obj>();
  private categories = new Map<string, Obj>();
  private etiquettes = new Set<string>();
  private serveur: Obj = {};
  private dernier = 0;
  private derniereComplete = 0;
  private enCours: Promise<void> | null = null;
  /** Augmente à chaque changement : l'app peut répondre « rien de neuf » sans renvoyer la liste. */
  version = 0;

  constructor(
    private lire: (rid: number) => Promise<Obj>,
    private maintenant: () => number = () => Date.now(),
  ) {}

  /** Met à jour l'état (au plus une lecture à la fois). `forcer` : tout relire tout de suite (après une action). */
  rafraichir(forcer = false): Promise<void> {
    if (this.enCours) return this.enCours;
    const t = this.maintenant();
    if (!forcer && t - this.dernier < FRAICHEUR_MS) return Promise.resolve();
    this.enCours = (async () => {
      try {
        if (t - this.derniereComplete > RELECTURE_COMPLETE_MS) this.rid = 0;
        const d = await this.lire(this.rid);
        this.appliquer(d);
        this.dernier = this.maintenant();
      } catch (e) {
        this.rid = 0; // session perdue ou qBittorrent relancé : on repartira d'une lecture complète
        throw e;
      } finally {
        this.enCours = null;
      }
    })();
    return this.enCours;
  }

  appliquer(d: Obj): void {
    if (d.full_update === true || this.rid === 0) {
      this.torrents.clear();
      this.categories.clear();
      this.etiquettes.clear();
      this.serveur = {};
      this.derniereComplete = this.maintenant();
    }
    for (const [hash, partiel] of Object.entries((d.torrents ?? {}) as Obj)) {
      this.torrents.set(hash.toLowerCase(), { ...(this.torrents.get(hash.toLowerCase()) ?? {}), ...(partiel as Obj), hash: hash.toLowerCase() });
    }
    for (const hash of (d.torrents_removed ?? []) as string[]) this.torrents.delete(String(hash).toLowerCase());
    for (const [nom, c] of Object.entries((d.categories ?? {}) as Obj)) this.categories.set(nom, { ...(this.categories.get(nom) ?? {}), ...(c as Obj) });
    for (const nom of (d.categories_removed ?? []) as string[]) this.categories.delete(nom);
    for (const t of (d.tags ?? []) as string[]) this.etiquettes.add(t);
    for (const t of (d.tags_removed ?? []) as string[]) this.etiquettes.delete(t);
    this.serveur = { ...this.serveur, ...((d.server_state ?? {}) as Obj) };
    if (typeof d.rid === "number") this.rid = d.rid;
    // Rien de nouveau (qBittorrent ne renvoie alors que `rid`) : la version ne change pas, l'app n'a rien à redessiner.
    if (Object.keys(d).some((k) => k !== "rid")) this.version++;
  }

  /** Le torrent existe-t-il déjà (empreinte en minuscules) ? */
  contient(hash: string): boolean {
    return this.torrents.has(hash.toLowerCase());
  }
  brut(hash: string): Obj | undefined {
    return this.torrents.get(hash.toLowerCase());
  }
  nomsCategories(): string[] {
    return [...this.categories.keys()];
  }
  cheminsCategories(): string[] {
    return [...this.categories.values()].map((c) => str(c.savePath)).filter(Boolean);
  }

  instantane() {
    const hote = (url: string) => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    };
    const torrents = [...this.torrents.values()].map((t) => {
      const etat: EtatTorrent & { brut: string } = { ...etatTorrent(str(t.state)), brut: str(t.state) };
      return {
        hash: str(t.hash),
        nom: str(t.name),
        etat,
        progression: num(t.progress),
        vitesse: num(t.dlspeed),
        vitesseEnvoi: num(t.upspeed),
        resteSec: num(t.eta) >= 8_640_000 || num(t.eta) < 0 ? null : num(t.eta),
        tailleOctets: num(t.size) || num(t.total_size),
        telechargesOctets: num(t.downloaded) || Math.round(num(t.size) * num(t.progress)),
        televersesOctets: num(t.uploaded),
        ratio: Math.round(num(t.ratio) * 100) / 100,
        categorie: str(t.category),
        etiquettes: str(t.tags).split(",").map((x) => x.trim()).filter(Boolean),
        tracker: hote(str(t.tracker)),
        ajouteLe: num(t.added_on) > 0 ? new Date(num(t.added_on) * 1000).toISOString() : null,
        termineLe: num(t.completion_on) > 0 ? new Date(num(t.completion_on) * 1000).toISOString() : null,
        chemin: str(t.save_path),
        priorite: num(t.priority),
        sequentiel: t.seq_dl === true,
        premierDernier: t.f_l_piece_prio === true,
        forcer: t.force_start === true,
        limiteDl: Math.max(0, num(t.dl_limit)),
        limiteUp: Math.max(0, num(t.up_limit)),
        seeds: num(t.num_seeds),
        seedsTotal: num(t.num_complete),
        pairs: num(t.num_leechs),
        pairsTotal: num(t.num_incomplete),
      };
    });
    const s = this.serveur;
    return {
      v: this.version,
      torrents,
      categories: [...this.categories.entries()].map(([nom, c]) => ({ nom, chemin: str(c.savePath) })).sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
      etiquettes: [...this.etiquettes].sort((a, b) => a.localeCompare(b, "fr")),
      trackers: [...new Set(torrents.map((t) => t.tracker).filter(Boolean))].sort(),
      global: {
        vitesseDl: num(s.dl_info_speed),
        vitesseUp: num(s.up_info_speed),
        limiteDl: Math.max(0, num(s.dl_rate_limit)),
        limiteUp: Math.max(0, num(s.up_rate_limit)),
        alternatif: s.use_alt_speed_limits === true,
        libreOctets: typeof s.free_space_on_disk === "number" ? s.free_space_on_disk : null,
        connexion: str(s.connection_status) || null,
      },
    };
  }
}

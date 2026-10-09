// Surveillant : toutes les N minutes (2 par défaut), regarde l'état des services et envoie des notifications ntfy.
// Alertes : disque presque plein, indexeur Prowlarr en échec, torrent bloqué, service hors ligne ; + « résolu » à la fin du
// problème ; + un résumé chaque dimanche à 9 h (heure de Montréal).
// Règles anti-spam : une alerte identique n'est renvoyée qu'après 6 h tant que le problème dure (sauf si elle devient
// critique) ; au tout premier lancement (aucun état enregistré) on lit l'état sans rien envoyer ; l'état est gardé dans
// /data/surveillance.json. Une panne de ntfy ou d'un service ne fait jamais planter la boucle.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AlerteApp } from "./prowlarr.js";
import type { GetJson } from "./lecture.js";
import type { EnvoiNtfy } from "./ntfy.js";
import type { ReglagesNotifs, TypeNotif } from "./prefs.js";
import type { ServiceId } from "./services.js";

type Obj = Record<string, any>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const DELAI_RENVOI_MS = 6 * 3_600_000;
const MAX_JOURNAL = 50;
const GO = 1024 ** 3;

export interface EntreeNotif {
  date: string;
  type: TypeNotif | "test";
  titre: string;
  message: string;
  ok: boolean;
  /** Pourquoi l'envoi a échoué (déjà purgé de tout secret). */
  erreur?: string;
}

interface Actif {
  type: TypeNotif;
  titre: string;
  niveau: "normal" | "critique";
  /** Début du problème (ms). */
  depuis: number;
  dernierEnvoi: number | null;
  /** Une notification a-t-elle réellement été envoyée ? (sinon pas de message « résolu ») */
  annonce: boolean;
  /** Complément trouvé au moment d'annoncer (cause d'un indexeur…) ; "" = déjà cherché, rien trouvé. */
  detail?: string;
  /** Message de fin ; « %D » sera remplacé par la durée du problème. */
  resolu: { titre: string; message: string };
}

interface Etat {
  version: 1;
  /** Faux tant qu'une première lecture complète n'a pas eu lieu. */
  amorce: boolean;
  actifs: Record<string, Actif>;
  /** Problèmes vus mais pas encore assez anciens pour être annoncés : clé → premier instant vu (ms). */
  candidats: Record<string, number>;
  dernierResume: string | null;
  alertesSemaine: { date: number; titre: string }[];
  journal: EntreeNotif[];
  derniereLecture: string | null;
}

const etatVide = (): Etat => ({
  version: 1, amorce: false, actifs: {}, candidats: {}, dernierResume: null, alertesSemaine: [], journal: [], derniereLecture: null,
});

export interface Probleme {
  /** Clé stable, préfixée par le type : « disque:radarr:/films », « service:plex »… */
  cle: string;
  type: TypeNotif;
  niveau: "normal" | "critique";
  titre: string;
  message: (dureeMs: number, detail?: string) => string;
  /** Reçoit la durée déjà mise en forme (« 2 h 10 »). */
  resolu: (duree: string) => { titre: string; message: string };
  /** Début réel du problème s'il est connu (torrent : dernière activité). Sinon : la première fois qu'on l'a vu. */
  depuisConnu?: number;
  /** Le problème ne compte qu'après cette durée (service hors ligne > 5 min, torrent > 2 h). */
  minDepuisMs: number;
  /** Complément à chercher une seule fois, juste avant la première annonce. */
  enrichir?: () => Promise<string | undefined>;
}

interface Collecte {
  problemes: Probleme[];
  /** Préfixes de clés qu'on n'a pas pu lire (service injoignable) : leurs problèmes en cours ne sont ni résolus ni oubliés. */
  illisibles: string[];
}

export interface DepsSurveillant {
  getJson: GetJson;
  configured: (id: ServiceId) => boolean;
  /** Ping de chaque service configuré (Homarr exclu par l'appelant). */
  sante: () => Promise<{ id: string; label: string; ok: boolean }[]>;
  /** Cause d'un indexeur déjà connue, et test à la demande (une fois par épisode d'échec). */
  causeConnue: (idIndexeur: number) => string | null;
  causeParTest: (idIndexeur: number) => Promise<string | null>;
  /** null = ntfy non configuré : le surveillant ne fait rien. */
  envoyer: EnvoiNtfy | null;
  reglages: () => ReglagesNotifs;
  maintenant: () => number;
  /** Dossier où garder surveillance.json. */
  dossier: string;
  /** Retire les secrets d'un texte (par défaut : rien). */
  purger?: (texte: string) => string;
}

// ---------- mise en forme ----------

const fmtGo = (octets: number) =>
  octets >= 1024 * GO ? `${(octets / (1024 * GO)).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} To` : `${Math.round(octets / GO).toLocaleString("fr-FR")} Go`;

export function fmtDuree(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}`;
  return `${Math.floor(h / 24)} jours`;
}

/** Jour de la semaine (0 = dimanche), heure et date « AAAA-MM-JJ » à Montréal. */
export function instantMontreal(ms: number): { jour: number; heure: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montreal", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const jours = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { jour: jours.indexOf(p("weekday")), heure: Number(p("hour")) % 24, date: `${p("year")}-${p("month")}-${p("day")}` };
}

const LIBELLE_TYPE: Record<TypeNotif, string> = {
  disque: "Disque", indexeur: "Indexeur", torrent: "Torrent", service: "Service", resume: "Résumé",
};

// ---------- collecte de chaque type de problème ----------

async function collecterDisques(d: DepsSurveillant, s: ReglagesNotifs["seuils"]): Promise<Collecte> {
  const problemes: Probleme[] = [];
  const illisibles: string[] = [];
  for (const svc of ["radarr", "sonarr"] as const) {
    if (!d.configured(svc)) continue;
    let racines: Obj[];
    try {
      racines = (await d.getJson(svc, "/rootfolder")) as Obj[];
    } catch {
      illisibles.push(`disque:${svc}:`);
      continue;
    }
    // La taille totale vient de la racine si le service la donne, sinon de /diskspace.
    const espaces = (await d.getJson(svc, "/diskspace").catch(() => [])) as Obj[];
    for (const r of Array.isArray(racines) ? racines : []) {
      const chemin = str(r.path);
      if (!chemin || r.accessible === false || typeof r.freeSpace !== "number") continue;
      const libre = num(r.freeSpace);
      const total = num(r.totalSpace) || totalDe(Array.isArray(espaces) ? espaces : [], chemin);
      const pct = total > 0 ? (libre / total) * 100 : null;
      const critique = pct !== null && pct < s.disqueCritiquePct;
      const bas = critique || (pct !== null && pct < s.disquePct) || libre < s.disqueGo * GO;
      if (!bas) continue;
      const etat = (l: number) => `${fmtGo(l)} libres${pct !== null ? ` (${pct.toFixed(1).replace(".", ",")} %)` : ""}`;
      problemes.push({
        cle: `disque:${svc}:${chemin}`,
        type: "disque",
        niveau: critique ? "critique" : "normal",
        titre: critique ? `Disque presque plein : ${chemin}` : `Peu d'espace disque : ${chemin}`,
        message: () => `${chemin} : ${etat(libre)}.`,
        resolu: () => ({ titre: `Espace disque revenu : ${chemin}`, message: `${chemin} est repassé au-dessus des seuils.` }),
        minDepuisMs: 0,
      });
    }
  }
  return { problemes, illisibles };
}

/** Taille totale du disque qui contient `chemin`, d'après /diskspace (0 si inconnue). */
function totalDe(espaces: Obj[], chemin: string): number {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = norm(chemin);
  let meilleur: Obj | undefined;
  for (const e of espaces) {
    const p = norm(str(e.path));
    if ((c === p || c.startsWith(`${p}/`) || p === "") && (!meilleur || p.length > norm(str(meilleur.path)).length)) meilleur = e;
  }
  return num(meilleur?.totalSpace);
}

async function collecterIndexeurs(d: DepsSurveillant): Promise<Collecte> {
  if (!d.configured("prowlarr")) return { problemes: [], illisibles: [] };
  let liste: Obj[];
  let statuts: Obj[];
  try {
    [liste, statuts] = (await Promise.all([d.getJson("prowlarr", "/indexer"), d.getJson("prowlarr", "/indexerstatus")])) as [Obj[], Obj[]];
  } catch {
    return { problemes: [], illisibles: ["indexeur:"] };
  }
  const parId = new Map<number, Obj>((Array.isArray(statuts) ? statuts : []).map((s) => [num(s.indexerId), s]));
  const problemes: Probleme[] = [];
  for (const i of Array.isArray(liste) ? liste : []) {
    const id = num(i.id);
    const st = parId.get(id);
    // Un indexeur que tu as désactivé toi-même n'est pas un problème.
    if (i.enable !== true || !st || !(str(st.mostRecentFailure) || str(st.disabledTill))) continue;
    const nom = str(i.name) || `Indexeur ${id}`;
    const dernier = str(st.mostRecentFailure);
    problemes.push({
      cle: `indexeur:${id}`,
      type: "indexeur",
      niveau: "normal",
      titre: `Indexeur en échec : ${nom}`,
      message: (_duree, detail) => {
        const cause = detail || d.causeConnue(id) || "cause inconnue (ouvre Indexeurs dans Mediarr et touche « Tester »)";
        return `${nom} : ${cause}.${dernier ? ` Dernier échec : ${dernier.slice(0, 10)}.` : ""}`;
      },
      resolu: (duree) => ({ titre: `Indexeur rétabli : ${nom}`, message: `${nom} refonctionne (en échec depuis ${duree}).` }),
      minDepuisMs: 0,
      enrichir: async () => (await d.causeParTest(id)) ?? undefined,
    });
  }
  return { problemes, illisibles: [] };
}

const ETATS_ATTENTE = new Set(["pauseddl", "stoppeddl", "queueddl", "checkingdl", "checkingresumedata", "allocating", "moving"]);

async function collecterTorrents(d: DepsSurveillant, s: ReglagesNotifs["seuils"], maintenant: number): Promise<Collecte> {
  if (!d.configured("qbittorrent")) return { problemes: [], illisibles: [] };
  let torrents: Obj[];
  try {
    torrents = (await d.getJson("qbittorrent", "/torrents/info")) as Obj[];
  } catch {
    return { problemes: [], illisibles: ["torrent:"] };
  }
  const problemes: Probleme[] = [];
  for (const t of Array.isArray(torrents) ? torrents : []) {
    const etat = str(t.state);
    const progres = num(t.progress);
    if (progres >= 1 || ETATS_ATTENTE.has(etat.toLowerCase())) continue;
    const ajoute = num(t.added_on) * 1000;
    const activite = num(t.last_activity) * 1000;
    let raison = "";
    // Plusieurs raisons possibles : on garde la plus ancienne (le plus long « bloqué »).
    const refs: number[] = [];
    let inconnue = false;
    if (etat === "stalledDL") {
      refs.push(activite > 0 ? activite : ajoute);
      raison = "bloqué, sans source";
    }
    if (etat === "missingFiles" || etat === "error") {
      inconnue = true;
      raison = etat === "missingFiles" ? "fichiers manquants" : "en erreur";
    }
    if (progres === 0 && ajoute > 0 && ["downloading", "metaDL", "forcedDL", "forcedMetaDL", "stalledDL"].includes(etat)) {
      refs.push(ajoute);
      raison = raison ? `${raison}, 0 %` : "toujours à 0 %";
    }
    if (!raison) continue;
    const nom = str(t.name) || str(t.hash);
    problemes.push({
      cle: `torrent:${str(t.hash) || nom}`,
      type: "torrent",
      niveau: "normal",
      titre: `Torrent bloqué : ${nom.slice(0, 80)}`,
      message: (duree) => `${nom} : ${raison} depuis ${fmtDuree(duree)}.`,
      resolu: () => ({ titre: `Torrent débloqué : ${nom.slice(0, 80)}`, message: `${nom} n'est plus bloqué (terminé, supprimé ou reparti).` }),
      depuisConnu: inconnue || refs.length === 0 ? undefined : Math.min(...refs.filter((r) => r > 0), maintenant),
      minDepuisMs: s.torrentHeures * 3_600_000,
    });
  }
  return { problemes, illisibles: [] };
}

async function collecterServices(d: DepsSurveillant, s: ReglagesNotifs["seuils"]): Promise<Collecte> {
  const sante = await d.sante();
  return {
    illisibles: [],
    problemes: sante
      .filter((x) => !x.ok)
      .map((x) => ({
        cle: `service:${x.id}`,
        type: "service" as const,
        niveau: "normal" as const,
        titre: `${x.label} est hors ligne`,
        message: (duree: number) => `${x.label} ne répond plus depuis ${fmtDuree(duree)}.`,
        resolu: (duree: string) => ({ titre: `${x.label} est de nouveau en ligne`, message: `${x.label} répond de nouveau (hors ligne pendant ${duree}).` }),
        minDepuisMs: s.serviceMinutes * 60_000,
      })),
  };
}

// ---------- le surveillant ----------

export class Surveillant {
  private etat: Etat;
  private enCours = false;
  private minuteur: ReturnType<typeof setTimeout> | null = null;
  private arrete = false;

  constructor(private readonly d: DepsSurveillant) {
    this.etat = this.charger();
  }

  private fichier = () => join(this.d.dossier, "surveillance.json");
  private purger = (t: string) => (this.d.purger ? this.d.purger(t) : t);

  private charger(): Etat {
    try {
      const j = JSON.parse(readFileSync(this.fichier(), "utf8")) as Partial<Etat>;
      if (j && j.version === 1) return { ...etatVide(), ...j };
    } catch {
      /* premier lancement ou fichier illisible : on repart de zéro, en silence */
    }
    return etatVide();
  }

  private sauver() {
    try {
      mkdirSync(this.d.dossier, { recursive: true });
      const tmp = `${this.fichier()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.etat), "utf8");
      renameSync(tmp, this.fichier());
    } catch {
      /* dossier non inscriptible : le surveillant continue en mémoire */
    }
  }

  get actif() {
    return this.d.envoyer !== null;
  }

  /** Pour l'écran Réglages. */
  resume() {
    return {
      derniereLecture: this.etat.derniereLecture,
      journal: this.etat.journal,
      problemes: Object.values(this.etat.actifs).map((a) => ({ type: a.type, titre: a.titre, depuis: new Date(a.depuis).toISOString() })),
    };
  }

  /** Alertes en cours, pour le bloc « Alertes » de l'accueil. */
  alertes(): AlerteApp[] {
    return Object.values(this.etat.actifs).map((a) => ({
      source: LIBELLE_TYPE[a.type],
      niveau: a.niveau === "critique" ? ("critique" as const) : ("avertissement" as const),
      message: a.titre,
    }));
  }

  /** Ajoute une ligne au journal (50 dernières) ; sert aussi au bouton « test ». */
  noter(e: Omit<EntreeNotif, "date">) {
    this.etat.journal.unshift({
      ...e,
      date: new Date(this.d.maintenant()).toISOString(),
      titre: this.purger(e.titre).slice(0, 200),
      message: this.purger(e.message).slice(0, 500),
    });
    this.etat.journal.length = Math.min(this.etat.journal.length, MAX_JOURNAL);
    this.sauver();
  }

  /** Envoie une notification et la note au journal ; renvoie false (sans lever d'erreur) si ntfy ne répond pas. */
  async notifier(type: TypeNotif | "test", titre: string, message: string, priorite: 1 | 2 | 3 | 4 | 5, tags: string[]): Promise<{ ok: boolean; erreur?: string }> {
    if (!this.d.envoyer) return { ok: false, erreur: "ntfy n'est pas configuré" };
    try {
      await this.d.envoyer({ titre, message, priorite, tags });
      this.noter({ type, titre, message, ok: true });
      return { ok: true };
    } catch (e) {
      const erreur = this.purger(e instanceof Error ? e.message : "envoi impossible").slice(0, 200);
      this.noter({ type, titre, message, ok: false, erreur });
      return { ok: false, erreur };
    }
  }

  /** Une passe de surveillance. Ne lève jamais d'exception. */
  async tick(): Promise<void> {
    if (!this.d.envoyer || this.enCours) return;
    this.enCours = true;
    try {
      await this.passe();
    } catch {
      /* une erreur inattendue ne doit pas arrêter la surveillance */
    } finally {
      this.enCours = false;
    }
  }

  private async passe() {
    const e = this.etat;
    const r = this.d.reglages();
    const maintenant = this.d.maintenant();

    // Un type coupé dans Réglages : on oublie ses problèmes (ils repartiront de zéro s'il est réactivé).
    for (const cle of Object.keys(e.actifs)) if (!r.types[e.actifs[cle].type]) delete e.actifs[cle];
    for (const cle of Object.keys(e.candidats)) if (!r.types[cle.split(":")[0] as TypeNotif]) delete e.candidats[cle];

    const lecteurs: [TypeNotif, () => Promise<Collecte>][] = [
      ["disque", () => collecterDisques(this.d, r.seuils)],
      ["indexeur", () => collecterIndexeurs(this.d)],
      ["torrent", () => collecterTorrents(this.d, r.seuils, maintenant)],
      ["service", () => collecterServices(this.d, r.seuils)],
    ];
    const actives = lecteurs.filter(([t]) => r.types[t]);
    const collectes = await Promise.all(
      actives.map(async ([type, lire]): Promise<[TypeNotif, Collecte]> => {
        try {
          return [type, await lire()];
        } catch {
          return [type, { problemes: [], illisibles: [`${type}:`] }];
        }
      }),
    );

    let ntfyHs = false; // après un premier échec d'envoi, on n'insiste pas pendant cette passe
    const envoyer = async (type: TypeNotif, titre: string, message: string, priorite: 1 | 2 | 3 | 4 | 5, tags: string[]) => {
      if (ntfyHs) return false;
      const res = await this.notifier(type, titre, message, priorite, tags);
      if (!res.ok) ntfyHs = true;
      return res.ok;
    };

    for (const [type, c] of collectes) {
      const sousIllisible = (cle: string) => c.illisibles.some((p) => cle.startsWith(p));
      const vus = new Set<string>();
      const courants = new Set<string>();

      for (const p of c.problemes) {
        vus.add(p.cle);
        const depuis = (e.candidats[p.cle] ??= p.depuisConnu ?? maintenant);
        const duree = maintenant - depuis;
        if (duree < p.minDepuisMs) continue;
        courants.add(p.cle);

        const a = (e.actifs[p.cle] ??= { type, titre: p.titre, niveau: p.niveau, depuis, dernierEnvoi: null, annonce: false, resolu: p.resolu("%D") });
        a.titre = p.titre;
        const escalade = a.niveau === "normal" && p.niveau === "critique";
        const echu = a.dernierEnvoi === null || maintenant - a.dernierEnvoi >= DELAI_RENVOI_MS || escalade;
        if (!echu) continue;
        a.niveau = p.niveau;
        if (!e.amorce) {
          a.dernierEnvoi = maintenant; // premier lancement : on mémorise sans annoncer
          continue;
        }
        if (a.detail === undefined && p.enrichir && !ntfyHs) a.detail = (await p.enrichir().catch(() => undefined)) ?? "";
        const envoye = await envoyer(type, p.titre, p.message(duree, a.detail), p.niveau === "critique" ? 5 : 4, [p.niveau === "critique" ? "rotating_light" : "warning"]);
        if (envoye) {
          a.dernierEnvoi = maintenant;
          if (!a.annonce) {
            a.annonce = true;
            e.alertesSemaine.push({ date: maintenant, titre: p.titre });
          }
        }
      }

      // Problèmes finis : message « résolu » (seulement si on avait annoncé le problème).
      for (const cle of Object.keys(e.actifs)) {
        const a = e.actifs[cle];
        if (a.type !== type || courants.has(cle) || sousIllisible(cle)) continue;
        if (a.annonce) {
          const duree = fmtDuree(maintenant - a.depuis);
          const { titre, message } = a.resolu;
          if (!(await envoyer(type, titre, message.split("%D").join(duree), 3, ["white_check_mark"]))) continue; // on réessaiera à la prochaine passe
        }
        delete e.actifs[cle];
        delete e.candidats[cle];
      }
      for (const cle of Object.keys(e.candidats)) {
        if (cle.startsWith(`${type}:`) && !vus.has(cle) && !sousIllisible(cle) && !e.actifs[cle]) delete e.candidats[cle];
      }
    }

    // Les problèmes qui ont disparu pendant que leur source était illisible, puis redevenus lisibles, sont traités ci-dessus.
    if (r.types.resume) await this.resumeHebdo(maintenant, envoyer);

    const limite = maintenant - 7 * 86_400_000;
    e.alertesSemaine = e.alertesSemaine.filter((a) => a.date >= limite).slice(-200);
    e.amorce = true;
    e.derniereLecture = new Date(maintenant).toISOString();
    this.sauver();
  }

  /** Dimanche, à partir de 9 h (Montréal) : titres ajoutés, espace restant, alertes de la semaine. Une seule fois par dimanche. */
  private async resumeHebdo(
    maintenant: number,
    envoyer: (type: TypeNotif, titre: string, message: string, priorite: 1 | 2 | 3 | 4 | 5, tags: string[]) => Promise<boolean>,
  ) {
    const e = this.etat;
    const m = instantMontreal(maintenant);
    if (m.jour !== 0 || m.heure < 9 || e.dernierResume === m.date) return;
    if (!e.amorce) {
      e.dernierResume = m.date; // premier lancement : pas de résumé surprise
      return;
    }
    const depuis = maintenant - 7 * 86_400_000;
    const lignes: string[] = [];

    const ajoutes: string[] = [];
    let films = 0;
    let series = 0;
    const indisponibles: string[] = [];
    for (const [svc, chemin, libelle] of [["radarr", "/movie", "Radarr"], ["sonarr", "/series", "Sonarr"]] as const) {
      if (!this.d.configured(svc)) continue;
      try {
        for (const x of (await this.d.getJson(svc, chemin)) as Obj[]) {
          const quand = Date.parse(str(x.added));
          if (Number.isFinite(quand) && quand >= depuis && str(x.title)) {
            ajoutes.push(str(x.title));
            if (svc === "radarr") films++;
            else series++;
          }
        }
      } catch {
        indisponibles.push(libelle);
      }
    }
    lignes.push(
      ajoutes.length === 0
        ? "Aucun titre ajouté cette semaine."
        : `${ajoutes.length} titre${ajoutes.length > 1 ? "s" : ""} ajouté${ajoutes.length > 1 ? "s" : ""} (${films} film${films > 1 ? "s" : ""}, ${series} série${series > 1 ? "s" : ""}) : ${ajoutes.slice(0, 8).join(", ")}${ajoutes.length > 8 ? ` et ${ajoutes.length - 8} autres` : ""}.`,
    );

    const disques: string[] = [];
    const signatures = new Set<string>();
    for (const svc of ["radarr", "sonarr"] as const) {
      if (!this.d.configured(svc)) continue;
      try {
        for (const r of (await this.d.getJson(svc, "/rootfolder")) as Obj[]) {
          if (typeof r.freeSpace !== "number" || !str(r.path)) continue;
          const sig = `${num(r.totalSpace)}:${Math.round(num(r.freeSpace) / GO)}`;
          if (num(r.totalSpace) > 0 && signatures.has(sig)) continue;
          signatures.add(sig);
          disques.push(`${str(r.path)} : ${fmtGo(num(r.freeSpace))} libres`);
        }
      } catch {
        if (!indisponibles.includes(svc === "radarr" ? "Radarr" : "Sonarr")) indisponibles.push(svc === "radarr" ? "Radarr" : "Sonarr");
      }
    }
    if (disques.length) lignes.push(`Espace restant — ${disques.join(" ; ")}.`);

    const alertes = e.alertesSemaine.filter((a) => a.date >= depuis);
    lignes.push(alertes.length === 0 ? "Aucune alerte cette semaine." : `${alertes.length} alerte${alertes.length > 1 ? "s" : ""} cette semaine : ${[...new Set(alertes.map((a) => a.titre))].slice(0, 6).join(" ; ")}.`);
    if (indisponibles.length) lignes.push(`Non lu : ${indisponibles.join(", ")} (injoignable).`);

    if (await envoyer("resume", "Résumé de la semaine — Mediarr", lignes.join("\n"), 3, ["bar_chart"])) e.dernierResume = m.date;
  }

  // ---------- boucle ----------

  /** Lance la boucle (première passe après `premierDelaiMs`, puis toutes les `intervalleMin` minutes des Réglages). */
  demarrer(premierDelaiMs = 15_000) {
    if (!this.d.envoyer || this.minuteur || this.arrete) return;
    const boucle = async () => {
      await this.tick();
      if (this.arrete) return;
      this.minuteur = setTimeout(boucle, Math.max(1, this.d.reglages().intervalleMin) * 60_000);
      this.minuteur.unref();
    };
    this.minuteur = setTimeout(boucle, premierDelaiMs);
    this.minuteur.unref();
  }

  arreter() {
    this.arrete = true;
    if (this.minuteur) clearTimeout(this.minuteur);
    this.minuteur = null;
  }
}


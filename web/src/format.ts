const nombre = (n: number, decimales = 1) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

/** 12 976 128 → « 12,4 Mo/s » */
export function vitesse(octetsParSec: number): string {
  if (octetsParSec >= 1024 ** 2) return `${nombre(octetsParSec / 1024 ** 2)} Mo/s`;
  return `${nombre(octetsParSec / 1024, 0)} Ko/s`;
}

/** 9 400 000 000 → « 8,8 Go » ; au-delà d'un téraoctet → « 6,4 To » */
export function taille(octets: number): string {
  if (octets <= 0) return "—";
  if (octets >= 1024 ** 4) return `${nombre(octets / 1024 ** 4, 2)} To`;
  if (octets >= 1024 ** 3) return `${nombre(octets / 1024 ** 3)} Go`;
  return `${nombre(octets / 1024 ** 2, 0)} Mo`;
}

/** 118 → « 1 h 58 » */
export function duree(min: number | null): string | null {
  if (!min) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

/** 34 → « 0:34 », 3725 → « 1:02:05 » */
export function reste(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Clé de jour AAAA-MM-JJ dans le fuseau local. */
export const cleJour = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Jour (clé) d'un élément du calendrier : local pour un épisode, tel quel pour une sortie de film. */
export const cleJourItem = (i: { date: string; heure: boolean }) =>
  i.heure ? cleJour(new Date(i.date)) : i.date.slice(0, 10);

export const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** « 2026-10-08 » → « Jeudi 8 octobre » */
export function jourLong(cle: string): string {
  const [y, m, d] = cle.split("-").map(Number);
  return majuscule(
    new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }),
  );
}

/** « 2026-10-08 » → « jeu. 8 oct. » */
export function jourCourt(cle: string): string {
  const [y, m, d] = cle.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** 0.989 → « 98,9 % » */
export const pourcent = (ratio: number) => `${nombre(Math.min(1, Math.max(0, ratio)) * 100)} %`;

/** 4290 → « 4 290 » */
export const entier = (n: number) => n.toLocaleString("fr-FR");

/** « 2026-10-05T10:00:00Z » → « 5 oct. » */
export const dateCourte = (iso: string) =>
  new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

/** « 2026-10-05T10:00:00Z » → « il y a 3 heures » (au-delà d'un mois : la date). */
export function ilYa(iso: string, maintenant = Date.now()): string {
  const sec = Math.round((new Date(iso).getTime() - maintenant) / 1000); // négatif = passé
  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  const abs = Math.abs(sec);
  if (abs < 60) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 30 * 86400) return rtf.format(Math.round(sec / 86400), "day");
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

/** 300 → « 5 h », 2880 → « 2 j », 90000 → « 2 mois » */
export function age(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
  if (minutes < 60 * 1440) return `${Math.round(minutes / 1440)} j`;
  if (minutes < 365 * 1440) return `${Math.round(minutes / (30 * 1440))} mois`;
  return `${Math.round(minutes / (365 * 1440))} an${minutes >= 2 * 365 * 1440 ? "s" : ""}`;
}

/** 7.8 → « 7,8 » */
export const noteTexte = (valeur: number) => nombre(valeur, 1);

export const ETIQUETTE_NOTE = { imdb: "IMDb", tmdb: "TMDB", note: "Note" } as const;

export const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Pour comparer sans tenir compte des accents ni de la casse. */
export const normaliser = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

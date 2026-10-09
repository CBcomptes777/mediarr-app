import type { Prefs } from "./prefs";

export type NomReseau = "Maison" | "Tailscale" | "Distant";

export function hoteDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Adresse privée (réseau local) : 10.x, 192.168.x, 172.16–31.x, localhost, *.local */
const estLocal = (h: string) =>
  h === "localhost" || h.endsWith(".local") || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);

/** Adresse Tailscale : *.ts.net ou 100.64.0.0/10 */
const estTailscale = (h: string) => h.endsWith(".ts.net") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);

/** Sur quel réseau est-on, d'après l'adresse par laquelle l'app a été ouverte ? Les adresses saisies dans Réglages priment. */
export function detecterReseau(hote: string, reseau: Prefs["reglages"]["reseau"]): NomReseau {
  const h = hote.toLowerCase();
  if (reseau.tailscale && h === hoteDe(reseau.tailscale)) return "Tailscale";
  if (reseau.maison && h === hoteDe(reseau.maison)) return "Maison";
  if (estTailscale(h)) return "Tailscale";
  if (estLocal(h)) return "Maison";
  return "Distant";
}

/** L'adresse à proposer quand celle-ci ne répond pas : l'autre réseau, si elle est renseignée. */
export function autreAdresse(hote: string, reseau: Prefs["reglages"]["reseau"]): { nom: NomReseau; url: string } | null {
  const actuel = detecterReseau(hote, reseau);
  if (actuel !== "Tailscale" && reseau.tailscale) return { nom: "Tailscale", url: reseau.tailscale };
  if (actuel !== "Maison" && reseau.maison) return { nom: "Maison", url: reseau.maison };
  return null;
}

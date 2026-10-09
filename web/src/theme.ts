import type { Prefs } from "./prefs";

type Apparence = Prefs["apparence"];

/** Luminance relative d'une couleur #rrggbb (0 = noir, 1 = blanc), pour choisir un texte lisible dessus. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Texte à poser sur un fond de cette couleur : encre foncée si le fond est clair, blanc sinon (contraste ≥ 4,5 visé). */
export const texteSur = (hex: string) => (luminance(hex) > 0.35 ? "#1b1238" : "#ffffff");

let ecoute: MediaQueryList | null = null;
let courant: Apparence["theme"] = "auto";

function themeEffectif(theme: Apparence["theme"]): "clair" | "sombre" {
  if (theme !== "auto") return theme === "clair" ? "clair" : "sombre";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "clair" : "sombre";
}

function poserTheme() {
  const racine = document.documentElement;
  const effet = themeEffectif(courant);
  racine.dataset.theme = courant;
  racine.dataset.effet = effet;
  racine.style.colorScheme = effet === "clair" ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effet === "clair" ? "#f3effd" : "#1b1238");
}

/** Applique thème, couleur d'accent et intensité du fond à toute la page. À appeler au démarrage puis à chaque changement. */
export function appliquerApparence(a: Apparence) {
  const racine = document.documentElement;
  courant = a.theme;
  poserTheme();
  racine.style.setProperty("--accent", a.accent);
  racine.style.setProperty("--sur-accent", texteSur(a.accent));
  racine.style.setProperty("--intensite", String(a.intensite));
  // En mode automatique, on suit le réglage du téléphone en direct.
  if (!ecoute && typeof matchMedia === "function") {
    ecoute = matchMedia("(prefers-color-scheme: light)");
    ecoute.addEventListener?.("change", poserTheme);
  }
}

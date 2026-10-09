import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { appliquerApparence } from "./theme";
import { lireCachePrefs, PREFS_DEFAUT } from "./prefs";
import "./styles.css";

// Thème et couleur d'accent appliqués avant le premier affichage : pas de flash du mauvais thème.
appliquerApparence((lireCachePrefs() ?? PREFS_DEFAUT).apparence);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import type { NatureErreur } from "./api";

const TITRES: Record<NatureErreur, string> = {
  reseau: "Plex injoignable",
  refuse: "Jeton Plex refusé",
  illisible: "Réponse Plex illisible",
  http: "Plex a répondu par une erreur",
};

const CONSEILS: Partial<Record<NatureErreur, string>> = {
  refuse:
    "Vérifie la variable PLEX_TOKEN du serveur. L'état « En ligne » de Plex ne prouve rien sur le jeton : Plex répond au ping sans jeton, mais pas à la liste des lectures.",
  illisible: "Plex doit répondre en JSON : vérifie PLEX_URL (le port 32400 de Plex) et la version de Plex.",
};

/** Pourquoi la liste des lectures Plex a échoué : un titre selon la nature, puis la cause et, si besoin, un conseil. */
export function ErreurPlex({ echec }: { echec: { error: string; nature?: NatureErreur; detail?: string } }) {
  const nature: NatureErreur = echec.nature ?? "reseau";
  const cause = echec.error.replace(/^Plex : /, "");
  return (
    <div role="alert" className="erreur-plex">
      <strong>{TITRES[nature]}</strong>
      {/* Le détail (« HTTP 401 — … ») contient déjà le code : on ne le répète pas. */}
      {!echec.detail?.startsWith(cause) && <span className="muted">{nature === "reseau" ? `Cause : ${cause}.` : cause}</span>}
      {echec.detail && <code className="detail-erreur">{echec.detail}</code>}
      {CONSEILS[nature] && <span className="muted">{CONSEILS[nature]}</span>}
    </div>
  );
}

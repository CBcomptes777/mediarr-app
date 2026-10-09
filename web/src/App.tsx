import { useEffect, useMemo, useState } from "react";
import {
  setToken,
  setUnauthorizedHandler,
  type Accueil as DonneesAccueil,
  type ServiceHealth,
  type TypeMedia,
} from "./api";
import { Accueil } from "./Accueil";
import { appliquerApparence } from "./theme";
import { AjoutMedia } from "./AjoutMedia";
import { Activite } from "./Activite";
import { Bibliotheque } from "./Bibliotheque";
import { Calendrier } from "./Calendrier";
import { Demandes } from "./Demandes";
import { Detail } from "./Detail";
import { PagePlex } from "./PagePlex";
import { PrefsProvider, usePrefs, type Prefs } from "./prefs";
import { Reglages } from "./Reglages";
import { Indexeurs } from "./Indexeurs";
import { RechercheInteractive } from "./RechercheInteractive";
import { Stats } from "./Stats";
import { autreAdresse, detecterReseau } from "./reseau";
import { TiroirServices } from "./TiroirServices";
import { Navigation, type Onglet } from "./ui";
import { useApi } from "./useApi";

type Page = "demandes" | "plex" | "reglages" | "stats" | "indexeurs" | "recherche" | null;

/** Onglets affichés dans la barre du bas, d'après les préférences (5 au plus, 2 au moins). */
export function ongletsVisibles(prefs: Prefs, overseerrConfigure: boolean): Onglet[] {
  const a = prefs.apparence;
  const disponible = (id: string) =>
    id === "biblio" ? !a.bibliothequeScindee
    : id === "films" || id === "series" ? a.bibliothequeScindee
    : id === "services" ? !a.serviceSwitcherSepare
    : id === "demandes" ? overseerrConfigure
    : true;
  const liste = a.onglets.filter((o) => o.visible && disponible(o.id)).map((o) => o.id as Onglet);
  if (liste.length < 2) return a.bibliothequeScindee ? ["accueil", "films", "series", "activite"] : ["accueil", "biblio", "calendrier", "activite"];
  return liste.slice(0, 5);
}

export function App() {
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  // Change à chaque nouveau jeton : les écrans sont recréés et rechargent leurs données.
  const [session, setSession] = useState(0);

  useEffect(() => {
    setUnauthorizedHandler(() => setNeedsToken(true));
    return () => setUnauthorizedHandler(undefined);
  }, []);

  if (needsToken) {
    return (
      <main className="screen">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(tokenInput.trim());
            setNeedsToken(false);
            setSession((n) => n + 1);
          }}
        >
          <h2>Jeton d'accès</h2>
          <p className="muted">Entre le jeton défini dans ACCESS_TOKEN sur le serveur.</p>
          <input
            aria-label="Jeton d'accès"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button type="submit">Valider</button>
        </form>
      </main>
    );
  }

  return (
    <PrefsProvider session={session}>
      <Coque key={session} />
    </PrefsProvider>
  );
}

function Coque() {
  const { prefs } = usePrefs();
  const [onglet, setOnglet] = useState<Onglet>("accueil");
  const [page, setPage] = useState<Page>(null);
  const [detail, setDetail] = useState<{ type: TypeMedia; id: number } | null>(null);
  const [tiroir, setTiroir] = useState(false);
  const [typeBiblio, setTypeBiblio] = useState<TypeMedia>("film");
  // Chargés ici : l'Accueil, le tiroir Services et la barre du bas (pastilles) s'en servent.
  const accueil = useApi<DonneesAccueil>("/accueil", 15000);
  const sante = useApi<{ services: ServiceHealth[] }>("/health", 30000);
  // Feuille « Ajouter un média » (ouverte depuis l'Accueil ou la Bibliothèque) ; `requete` pré-remplit la recherche.
  const [ajout, setAjout] = useState<{ requete: string } | null>(null);
  // Terme à chercher d'emblée dans Indexeurs → Recherche (depuis la recherche interactive).
  const [termeIndexeurs, setTermeIndexeurs] = useState<string | undefined>(undefined);
  // Change après chaque ajout : la Bibliothèque est rechargée.
  const [versionListes, setVersionListes] = useState(0);

  const hote = window.location.hostname;
  const reseau = detecterReseau(hote, prefs.reglages.reseau);
  const overseerrConfigure = Boolean(accueil.data?.overseerr) || Boolean(sante.data?.services.some((s) => s.id === "overseerr"));
  const onglets = useMemo(() => ongletsVisibles(prefs, overseerrConfigure), [prefs, overseerrConfigure]);

  // Apparence : thème, couleur d'accent, intensité du fond.
  useEffect(() => {
    appliquerApparence(prefs.apparence);
  }, [prefs.apparence.theme, prefs.apparence.accent, prefs.apparence.intensite]); // eslint-disable-line react-hooks/exhaustive-deps

  const aller = (o: Onglet) => {
    setDetail(null);
    setPage(null);
    if (o === "services") return setTiroir(true);
    if (o === "demandes") return setPage("demandes");
    if (o === "biblio") setTypeBiblio("film");
    setOnglet(o);
  };

  const allerService = (id: string) => {
    setTiroir(false);
    setDetail(null);
    setPage(null);
    const scindee = prefs.apparence.bibliothequeScindee;
    if (id === "accueil") return setOnglet("accueil");
    if (id === "radarr" || id === "sonarr") {
      const t: TypeMedia = id === "radarr" ? "film" : "serie";
      setTypeBiblio(t);
      return setOnglet(scindee ? (t === "film" ? "films" : "series") : "biblio");
    }
    if (id === "qbittorrent") return setOnglet("activite");
    if (id === "overseerr") return setPage("demandes");
    if (id === "plex") return setPage("plex");
    if (id === "prowlarr") {
      setTermeIndexeurs(undefined);
      return setPage("indexeurs");
    }
    if (id === "recherche") return setPage("recherche");
  };

  const ouvrir = (type: TypeMedia, id: number) => setDetail({ type, id });

  /** Ouvre un écran de l'app (actions rapides). */
  const allerEcran = (ecran: string) => {
    setDetail(null);
    const scindee = prefs.apparence.bibliothequeScindee;
    if (ecran === "reglages" || ecran === "plex" || ecran === "demandes" || ecran === "stats" || ecran === "indexeurs" || ecran === "recherche") return setPage(ecran);
    setPage(null);
    if (ecran === "biblio") {
      setTypeBiblio("film");
      return setOnglet(scindee ? "films" : "biblio");
    }
    if (ecran === "films" || ecran === "series") {
      setTypeBiblio(ecran === "films" ? "film" : "serie");
      return setOnglet(scindee ? ecran : "biblio");
    }
    if (ecran === "calendrier" || ecran === "activite" || ecran === "historique") setOnglet(ecran === "historique" ? "activite" : ecran);
  };
  const enAttente = accueil.data?.overseerr?.ok ? accueil.data.overseerr.enAttente : 0;
  const actifsQbit = accueil.data?.qbit?.ok ? accueil.data.qbit.actifs : 0;
  const badges: Partial<Record<Onglet, number>> = {
    activite: prefs.apparence.badges.activite ? actifsQbit : 0,
    demandes: prefs.apparence.badges.demandes ? enAttente : 0,
  };
  const actif: Onglet | null = page === "demandes" && onglets.includes("demandes") ? "demandes" : onglet;

  // Le serveur ne répond pas du tout : on propose l'autre adresse (maison / Tailscale) si elle est connue.
  const autre = sante.data === null && sante.erreur ? autreAdresse(hote, prefs.reglages.reseau) : null;

  return (
    <>
      {autre && (
        <div className="bandeau" role="alert">
          Le serveur ne répond pas sur cette adresse.{" "}
          <a href={autre.url}>Essayer l'adresse {autre.nom}</a>
        </div>
      )}
      <main className="screen">
        {/* L'écran en dessous reste monté (recherche, semaine choisie) pendant qu'on regarde un détail. */}
        <div className="pile" hidden={detail !== null}>
          {page === "reglages" && <Reglages onRetour={() => setPage(null)} />}
          {page === "demandes" && (
            <Demandes
              onRetour={onglets.includes("demandes") ? undefined : () => setPage(null)}
              onChange={() => accueil.recharger()}
            />
          )}
          {page === "plex" && <PagePlex accueil={accueil} onRetour={() => setPage(null)} />}
          {page === "stats" && <Stats onRetour={() => setPage(null)} />}
          {page === "indexeurs" && <Indexeurs key={termeIndexeurs ?? ""} termeInitial={termeIndexeurs} onRetour={() => setPage(null)} />}
          {page === "recherche" && (
            <RechercheInteractive
              onRetour={() => setPage(null)}
              onIndexeurs={(terme) => {
                setTermeIndexeurs(terme);
                setPage("indexeurs");
              }}
              onAjouter={(requete) => setAjout({ requete })}
            />
          )}
          {page === null && onglet === "accueil" && (
            <Accueil
              accueil={accueil}
              sante={sante}
              reseau={reseau}
              onOuvrir={ouvrir}
              onAjouter={(requete) => setAjout({ requete })}
              onService={allerService}
              onReglages={() => setPage("reglages")}
              onEcran={allerEcran}
            />
          )}
          {page === null && (onglet === "biblio" || onglet === "films" || onglet === "series") && (
            <Bibliotheque
              key={`${versionListes}-${typeBiblio}-${onglet}`}
              typeInitial={onglet === "films" ? "film" : onglet === "series" ? "serie" : typeBiblio}
              typeFixe={onglet === "films" ? "film" : onglet === "series" ? "serie" : undefined}
              onOuvrir={ouvrir}
              onAjouter={() => setAjout({ requete: "" })}
            />
          )}
          {page === null && onglet === "calendrier" && <Calendrier onOuvrir={ouvrir} />}
          {page === null && onglet === "activite" && <Activite onOuvrir={ouvrir} />}
        </div>
        {detail && <Detail key={`${detail.type}-${detail.id}`} {...detail} onRetour={() => setDetail(null)} onOuvrir={ouvrir} />}
      </main>
      {ajout && (
        <AjoutMedia
          requeteInitiale={ajout.requete}
          onFermer={() => setAjout(null)}
          onAjoute={() => {
            setVersionListes((n) => n + 1);
            accueil.recharger();
          }}
          onOuvrir={ouvrir}
        />
      )}
      {tiroir && (
        <TiroirServices services={sante.data?.services ?? null} onChoisir={allerService} onFermer={() => setTiroir(false)} />
      )}
      <Navigation
        onglets={onglets}
        actif={actif}
        onChoix={aller}
        badges={badges}
        libelles={prefs.apparence.libelles}
        onServices={prefs.apparence.serviceSwitcherSepare ? () => setTiroir(true) : undefined}
      />
    </>
  );
}

import { useEffect, useState } from "react";
import { action, effacerToken, getToken, setToken } from "./api";
import { ilYa } from "./format";
import { usePrefs, type Prefs } from "./prefs";
import { SectionApparence } from "./Apparence";
import { autreAdresse, detecterReseau } from "./reseau";
import { COULEURS_SERVICES } from "./TiroirServices";
import { SectionNotifications } from "./Notifications";
import { BoutonRetour, DialogueConfirmation, Feuille, Interrupteur, ListeOrdonnable, Message, TitreCarte } from "./ui";
import { useApi } from "./useApi";

const NOMS_SERVICES: Record<string, string> = {
  radarr: "Radarr",
  sonarr: "Sonarr",
  overseerr: "Overseerr",
  qbittorrent: "qBittorrent",
  plex: "Plex",
  prowlarr: "Prowlarr",
  homarr: "Homarr",
};

interface EntreeJournal {
  date: string;
  service: string;
  chemin: string;
  statut: number;
  message: string;
  compteur: number;
}

export function Reglages({ onRetour, sections }: { onRetour: () => void; sections?: (p: { prefs: Prefs }) => React.ReactNode }) {
  const { prefs, stockage, jetonActif, sauvegarder } = usePrefs();
  const [echec, setEchec] = useState<string | null>(null);
  const enregistrer = async (modifier: (p: Prefs) => Prefs) => {
    setEchec(null);
    try {
      await sauvegarder(modifier);
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Enregistrement impossible");
    }
  };

  return (
    <>
      <header className="top">
        <BoutonRetour onClick={onRetour} />
        <h1>Réglages</h1>
        <span style={{ width: 44 }} />
      </header>

      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {stockage?.avertissement && (
        <p className="card avertissement" role="status">
          <strong>Préférences non durables.</strong> {stockage.avertissement}
        </p>
      )}

      <SectionReseau prefs={prefs} enregistrer={enregistrer} />
      <SectionJeton jetonActif={jetonActif} />
      <section className="card" aria-label="Ordre des services">
        <TitreCarte couleur="#a78bfa">Ordre des services</TitreCarte>
        <p className="muted marge-bas">Utilisé sur l'accueil et dans le tiroir Services.</p>
        <ListeOrdonnable
          elements={prefs.reglages.ordreServices.map((id) => ({ id, libelle: NOMS_SERVICES[id] ?? id }))}
          onChange={(suite) => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, ordreServices: suite.map((x) => x.id) } }))}
        />
      </section>

      <SectionApparence prefs={prefs} enregistrer={enregistrer} />

      <SectionNotifications prefs={prefs} enregistrer={enregistrer} />
      <SectionWebhooks prefs={prefs} enregistrer={enregistrer} />
      <SectionAvancee prefs={prefs} enregistrer={enregistrer} />
    </>
  );
}

type Enregistrer = (modifier: (p: Prefs) => Prefs) => Promise<void>;

function SectionReseau({ prefs, enregistrer }: { prefs: Prefs; enregistrer: Enregistrer }) {
  const r = prefs.reglages.reseau;
  const [maison, setMaison] = useState(r.maison);
  const [tailscale, setTailscale] = useState(r.tailscale);
  useEffect(() => {
    setMaison(r.maison);
    setTailscale(r.tailscale);
  }, [r.maison, r.tailscale]);

  const hote = window.location.hostname;
  const actuel = detecterReseau(hote, r);
  const autre = autreAdresse(hote, r);
  const modifie = maison.trim() !== r.maison || tailscale.trim() !== r.tailscale;

  return (
    <section className="card" aria-label="Réseau">
      <TitreCarte couleur="#4ade80">Réseau</TitreCarte>
      <p className="muted marge-bas">
        Tu es connecté par <strong>{actuel}</strong> ({hote || "adresse inconnue"}).
      </p>
      <form
        className="formulaire"
        onSubmit={(e) => {
          e.preventDefault();
          enregistrer((p) => ({ ...p, reglages: { ...p.reglages, reseau: { ...p.reglages.reseau, maison: maison.trim(), tailscale: tailscale.trim() } } }));
        }}
      >
        <label className="champ">
          <span>Adresse maison</span>
          <input type="url" inputMode="url" placeholder="http://192.168.1.20:8080" value={maison} onChange={(e) => setMaison(e.target.value)} />
        </label>
        <label className="champ">
          <span>Adresse Tailscale</span>
          <input type="url" inputMode="url" placeholder="https://nas.mon-reseau.ts.net" value={tailscale} onChange={(e) => setTailscale(e.target.value)} />
        </label>
        <button type="submit" className="bouton violet plein" disabled={!modifie}>
          Enregistrer les adresses
        </button>
      </form>

      <div className="choix-groupe" role="radiogroup" aria-label="Adresse préférée">
        <span className="muted">Adresse préférée</span>
        <div className="filtres">
          {(["auto", "maison", "tailscale"] as const).map((v) => (
            <button
              key={v}
              role="radio"
              aria-checked={r.preferee === v}
              className={r.preferee === v ? "actif" : ""}
              onClick={() => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, reseau: { ...p.reglages.reseau, preferee: v } } }))}
            >
              {v === "auto" ? "Automatique" : v === "maison" ? "Maison" : "Tailscale"}
            </button>
          ))}
        </div>
      </div>
      {autre && (
        <a className="bouton violet lien-bouton" href={autre.url}>
          Ouvrir par l'adresse {autre.nom}
        </a>
      )}
      <p className="muted">
        Si le serveur ne répond plus sur cette adresse, l'app propose l'autre. Chaque adresse a son propre jeton :
        il faudra le saisir une fois.
      </p>
    </section>
  );
}

function SectionJeton({ jetonActif }: { jetonActif: boolean }) {
  const [saisie, setSaisie] = useState("");
  const [edition, setEdition] = useState(false);
  const [oublier, setOublier] = useState(false);
  const present = getToken() !== "";

  return (
    <section className="card" aria-label="Jeton d'accès">
      <TitreCarte couleur="#f59e42">Jeton d'accès</TitreCarte>
      <p className="muted marge-bas">
        Le serveur {jetonActif ? "exige" : "n'exige pas"} de jeton (variable ACCESS_TOKEN, définie côté serveur).{" "}
        {present ? "Un jeton est enregistré sur cet appareil : ••••••••" : "Aucun jeton n'est enregistré sur cet appareil."}
      </p>
      {edition ? (
        <form
          className="formulaire"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(saisie.trim());
            window.location.reload(); // tout recharger avec le nouveau jeton
          }}
        >
          <label className="champ">
            <span>Nouveau jeton</span>
            <input type="password" autoComplete="off" value={saisie} onChange={(e) => setSaisie(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="bouton violet plein" disabled={!saisie.trim()}>
              Enregistrer
            </button>
            <button type="button" className="bouton violet" onClick={() => setEdition(false)}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="bouton violet" onClick={() => setEdition(true)}>
            {present ? "Changer le jeton" : "Saisir un jeton"}
          </button>
          {present && (
            <button className="bouton violet danger" onClick={() => setOublier(true)}>
              Oublier le jeton
            </button>
          )}
        </div>
      )}
      {oublier && (
        <DialogueConfirmation
          titre="Oublier le jeton sur cet appareil ?"
          texte="Il faudra le saisir à nouveau pour utiliser l'app."
          boutons={[
            {
              libelle: "Oublier le jeton",
              variante: "danger",
              onClick: () => {
                effacerToken();
                window.location.reload();
              },
            },
          ]}
          onAnnuler={() => setOublier(false)}
        />
      )}
    </section>
  );
}

function SectionAvancee({ prefs, enregistrer }: { prefs: Prefs; enregistrer: Enregistrer }) {
  const [delai, setDelai] = useState(Math.round(prefs.reglages.delaiHttpMs / 1000));
  const [delaiRecherche, setDelaiRecherche] = useState(Math.round(prefs.reglages.delaiRechercheMs / 1000));
  const [racines, setRacines] = useState(prefs.reglages.racinesQbit.join("\n"));
  const [journal, setJournal] = useState(false);
  const [viderCache, setViderCache] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Le curseur se déplace librement ; on n'enregistre qu'une fois qu'il s'est arrêté.
  useEffect(() => {
    if (delai * 1000 === prefs.reglages.delaiHttpMs) return;
    const t = setTimeout(() => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, delaiHttpMs: delai * 1000 } })), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delai]);

  useEffect(() => {
    if (delaiRecherche * 1000 === prefs.reglages.delaiRechercheMs) return;
    const t = setTimeout(() => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, delaiRechercheMs: delaiRecherche * 1000 } })), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delaiRecherche]);

  useEffect(() => {
    const liste = racines.split("\n").map((l) => l.trim()).filter(Boolean);
    if (liste.join("\n") === prefs.reglages.racinesQbit.join("\n")) return;
    const t = setTimeout(() => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, racinesQbit: liste } })), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racines]);

  return (
    <section className="card" aria-label="Avancé">
      <TitreCarte couleur="#818cf8">Avancé</TitreCarte>

      <div className="champ">
        <label htmlFor="delai-http">
          <strong>Délai des requêtes</strong> <span className="strong">{delai} s</span>
        </label>
        <input id="delai-http" type="range" min={5} max={120} step={5} value={delai} onChange={(e) => setDelai(Number(e.target.value))} />
        <span className="muted">Temps d'attente maximum d'un service. À augmenter si ta bibliothèque est très grande.</span>
      </div>

      <div className="champ">
        <label htmlFor="delai-recherche">
          <strong>Délai de la recherche manuelle</strong> <span className="strong">{delaiRecherche} s</span>
        </label>
        <input id="delai-recherche" type="range" min={15} max={300} step={15} value={delaiRecherche} onChange={(e) => setDelaiRecherche(Number(e.target.value))} />
        <span className="muted">Temps laissé aux indexeurs pour répondre (90 s par défaut). À augmenter si tu as beaucoup d'indexeurs lents.</span>
      </div>

      <div className="champ">
        <label htmlFor="racines-qbit">
          <strong>Dossiers autorisés pour qBittorrent</strong>
        </label>
        <textarea id="racines-qbit" rows={3} value={racines} onChange={(e) => setRacines(e.target.value)} placeholder="Un dossier par ligne, ex. /downloads" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className="muted">
          Où l'app peut ajouter ou déplacer des torrents. Vide : les dossiers de Radarr, de Sonarr et de qBittorrent (automatique). Un dossier
          en dehors de cette liste est toujours refusé.
        </span>
      </div>

      <Interrupteur
        libelle="Masquer la suppression"
        description="Cache tous les boutons de suppression de l'app, pour éviter un retrait par erreur."
        valeur={prefs.reglages.masquerSuppression}
        onChange={(v) => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, masquerSuppression: v } }))}
      />

      <div className="actions colonne">
        <button className="bouton violet" onClick={() => setJournal(true)}>
          Journal des connexions échouées
        </button>
        <button className="bouton violet danger" onClick={() => setViderCache(true)}>
          Vider le cache
        </button>
      </div>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}

      {journal && <JournalConnexions onFermer={() => setJournal(false)} />}
      {viderCache && (
        <DialogueConfirmation
          titre="Vider le cache ?"
          texte="Les listes, affiches et calculs gardés en mémoire par le serveur seront redemandés aux services. Rien n'est supprimé chez eux."
          boutons={[
            {
              libelle: "Vider le cache",
              variante: "danger",
              onClick: async () => {
                setViderCache(false);
                try {
                  await action("POST", "/cache/vider");
                  window.location.reload();
                } catch (e) {
                  setMessage(e instanceof Error ? e.message : "Impossible de vider le cache");
                }
              },
            },
          ]}
          onAnnuler={() => setViderCache(false)}
        />
      )}
    </section>
  );
}

function JournalConnexions({ onFermer }: { onFermer: () => void }) {
  const { data, erreur, chargement, recharger } = useApi<{ items: EntreeJournal[] }>("/journal");
  const [effacer, setEffacer] = useState(false);
  return (
    <Feuille titre="Connexions échouées" sousTitre="Jamais de clé ni de paramètre dans ce journal" onFermer={onFermer}>
      {erreur && <Message erreur>{erreur}</Message>}
      {chargement && !data && <Message>Chargement…</Message>}
      {data && data.items.length === 0 && <Message>Aucune connexion échouée depuis le démarrage du serveur.</Message>}
      {data?.items.map((e, i) => (
        <article key={i} className="release">
          <div className="release-titre">
            <span style={{ color: COULEURS_SERVICES[e.service] ?? "inherit" }}>{NOMS_SERVICES[e.service] ?? e.service}</span> {e.chemin}
          </div>
          <div className="release-infos">
            <span>{e.statut ? `HTTP ${e.statut}` : "Pas de réponse"}</span>
            <span>{e.message}</span>
            <span>{ilYa(e.date)}</span>
            {e.compteur > 1 && <span>× {e.compteur}</span>}
          </div>
        </article>
      ))}
      {data && data.items.length > 0 && (
        <button className="bouton violet danger" onClick={() => setEffacer(true)}>
          Effacer le journal
        </button>
      )}
      {effacer && (
        <DialogueConfirmation
          titre="Effacer le journal ?"
          boutons={[
            {
              libelle: "Effacer",
              variante: "danger",
              onClick: async () => {
                setEffacer(false);
                await action("DELETE", "/journal").catch(() => {});
                recharger();
              },
            },
          ]}
          onAnnuler={() => setEffacer(false)}
        />
      )}
    </Feuille>
  );
}

interface EtatWebhooks {
  actif: boolean;
  /** Une configuration est en cours (lancement ou bouton). */
  enCours: boolean;
  automatique: Record<string, string>;
  raison: string | null;
  evenements: { date: string; service: string; evenement: string; titre: string }[];
}

function SectionWebhooks({ prefs, enregistrer }: { prefs: Prefs; enregistrer: Enregistrer }) {
  // Pendant une configuration (qui peut réessayer pendant une quinzaine de secondes), on relit l'état toutes les 2 s.
  const [suivi, setSuivi] = useState(false);
  const [lanceA, setLanceA] = useState(0);
  const [envoi, setEnvoi] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);
  const { data, erreur, recharger } = useApi<EtatWebhooks>("/webhooks/etat", suivi ? 2000 : 30000);
  const origine = window.location.origin;

  useEffect(() => {
    if (!data) return;
    if (data.enCours) setSuivi(true);
    else if (suivi && Date.now() - lanceA > 2500) setSuivi(false);
  }, [data, suivi, lanceA]);

  async function reconfigurer() {
    setEnvoi(true);
    setEchec(null);
    try {
      await action("POST", "/webhooks/configurer");
      setLanceA(Date.now());
      setSuivi(true);
      recharger();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Impossible de lancer la configuration");
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <section className="card" aria-label="Webhooks">
      <TitreCarte couleur="#22d3ee">Webhooks</TitreCarte>
      <p className="muted marge-bas">
        Radarr, Sonarr et Overseerr peuvent prévenir Mediarr quand il se passe quelque chose. Pour l'instant, les évènements
        sont seulement reçus et listés ici : aucune notification n'est envoyée.
      </p>
      {erreur && <Message erreur>{erreur}</Message>}
      {data && !data.actif && (
        <p className="muted marge-bas">
          Désactivés : définis la variable <strong>WEBHOOK_SECRET</strong> (12 caractères au moins) sur le serveur pour les activer.
        </p>
      )}
      {data?.actif && (
        <>
          <p className="muted">Adresses à utiliser (méthode POST, en-tête <strong>Authorization: Bearer</strong> + ton secret) :</p>
          <ul className="adresses">
            {["radarr", "sonarr", "overseerr"].map((s) => (
              <li key={s}>
                <span className="strong">{NOMS_SERVICES[s]}</span> <code>{origine}/api/webhooks/{s}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <Interrupteur
        libelle="Configurer les webhooks au lancement"
        description="Au démarrage, Mediarr crée (ou met à jour) la notification « Mediarr » dans Radarr, Sonarr et Overseerr. Demande WEBHOOK_SECRET et MEDIARR_URL sur le serveur."
        valeur={prefs.reglages.webhooksAuto}
        onChange={(v) => enregistrer((p) => ({ ...p, reglages: { ...p.reglages, webhooksAuto: v } }))}
      />
      {data && prefs.reglages.webhooksAuto && data.raison && <p className="muted">Pas lancée : {data.raison}.</p>}
      {data && Object.keys(data.automatique).length > 0 && (
        <ul className="adresses" aria-live="polite">
          {Object.entries(data.automatique).map(([s, etat]) => (
            <li key={s} className={/^échec/.test(etat) ? "etat-echec" : undefined}>
              <span className="strong">{NOMS_SERVICES[s] ?? s}</span> : {etat}
            </li>
          ))}
        </ul>
      )}
      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {data?.actif && (
        <button className="bouton violet" disabled={envoi || data.enCours} onClick={reconfigurer}>
          {data.enCours ? "Configuration en cours…" : "Reconfigurer maintenant"}
        </button>
      )}
      {data?.actif && (
        <>
          <h3 className="sous-titre">Derniers évènements reçus</h3>
          {data.evenements.length === 0 ? (
            <p className="muted">Aucun évènement reçu pour le moment.</p>
          ) : (
            <ul className="adresses">
              {data.evenements.slice(0, 8).map((e, i) => (
                <li key={i}>
                  <span className="strong">{NOMS_SERVICES[e.service] ?? e.service}</span> · {e.evenement}
                  {e.titre ? ` · ${e.titre}` : ""} <span className="muted">({ilYa(e.date)})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

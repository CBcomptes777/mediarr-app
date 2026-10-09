import { useEffect, useState } from "react";
import { action } from "./api";
import { ilYa } from "./format";
import type { Prefs, ReglagesNotifs } from "./prefs";
import { Interrupteur, Message, TitreCarte } from "./ui";
import { useApi } from "./useApi";

interface EntreeNotif {
  date: string;
  type: string;
  titre: string;
  message: string;
  ok: boolean;
  erreur?: string;
}
interface EtatNotifs {
  configure: boolean;
  /** Message prêt à afficher quand ntfy n'est pas configuré. */
  message: string | null;
  derniereLecture: string | null;
  journal: EntreeNotif[];
  problemes: { type: string; titre: string; depuis: string }[];
}

type Enregistrer = (modifier: (p: Prefs) => Prefs) => Promise<void>;
type TypeNotif = keyof ReglagesNotifs["types"];

const TYPES: { id: TypeNotif; libelle: string; description: string }[] = [
  { id: "disque", libelle: "Espace disque bas", description: "Dossiers racine de Radarr et Sonarr presque pleins (critique sous le seuil critique)." },
  { id: "indexeur", libelle: "Indexeur Prowlarr en échec", description: "Avec la cause quand elle est connue, et un message quand il refonctionne." },
  { id: "torrent", libelle: "Torrent bloqué", description: "Sans source, fichiers manquants ou toujours à 0 % depuis trop longtemps." },
  { id: "service", libelle: "Service hors ligne", description: "Radarr, Sonarr, Overseerr, qBittorrent, Plex ou Prowlarr, et leur retour." },
  { id: "resume", libelle: "Résumé du dimanche", description: "Dimanche à 9 h (heure de Montréal) : titres ajoutés, espace restant, alertes de la semaine." },
];

const LIBELLE_TYPE: Record<string, string> = {
  disque: "Disque", indexeur: "Indexeur", torrent: "Torrent", service: "Service", resume: "Résumé", test: "Test",
};

/** Champ numérique : on tape librement, la valeur est bornée puis enregistrée quand on quitte le champ. */
function ChampNombre({ id, libelle, valeur, min, max, suffixe, onChange }: {
  id: string;
  libelle: string;
  valeur: number;
  min: number;
  max: number;
  suffixe: string;
  onChange: (v: number) => void;
}) {
  const [texte, setTexte] = useState(String(valeur));
  useEffect(() => setTexte(String(valeur)), [valeur]);
  const valider = () => {
    const n = Math.round(Number(texte));
    const v = Number.isFinite(n) && texte.trim() !== "" ? Math.min(max, Math.max(min, n)) : valeur;
    setTexte(String(v));
    if (v !== valeur) onChange(v);
  };
  return (
    <div className="champ champ-nombre">
      <label htmlFor={id}>{libelle}</label>
      <span className="champ-nombre-saisie">
        <input id={id} type="number" inputMode="numeric" min={min} max={max} value={texte} onChange={(e) => setTexte(e.target.value)} onBlur={valider} />
        <span className="muted">{suffixe}</span>
      </span>
    </div>
  );
}

export function SectionNotifications({ prefs, enregistrer }: { prefs: Prefs; enregistrer: Enregistrer }) {
  const { data, erreur, recharger } = useApi<EtatNotifs>("/notifications/etat", 30000);
  const [envoi, setEnvoi] = useState(false);
  const [resultat, setResultat] = useState<{ ok: boolean; texte: string } | null>(null);
  const n = prefs.notifications;
  const maj = (modifier: (n: ReglagesNotifs) => ReglagesNotifs) => enregistrer((p) => ({ ...p, notifications: modifier(p.notifications) }));
  const seuil = (cle: keyof ReglagesNotifs["seuils"]) => (v: number) => maj((x) => ({ ...x, seuils: { ...x.seuils, [cle]: v } }));

  async function tester() {
    setEnvoi(true);
    setResultat(null);
    try {
      await action("POST", "/notifications/test");
      setResultat({ ok: true, texte: "Notification de test envoyée : elle doit arriver sur ton iPhone." });
    } catch (e) {
      setResultat({ ok: false, texte: e instanceof Error ? e.message : "Envoi impossible" });
    } finally {
      setEnvoi(false);
      recharger();
    }
  }

  return (
    <section className="card" aria-label="Notifications">
      <TitreCarte couleur="#f472b6">Notifications</TitreCarte>
      {erreur && <Message erreur>{erreur}</Message>}
      {data && !data.configure && (
        <p className="muted marge-bas" role="status">
          {data.message}
        </p>
      )}
      {data?.configure && (
        <p className="muted marge-bas">
          Mediarr surveille tes services et t'envoie une notification ntfy
          {data.derniereLecture ? ` (dernière vérification : ${ilYa(data.derniereLecture)})` : ""}.
        </p>
      )}

      {TYPES.map((t) => (
        <Interrupteur
          key={t.id}
          libelle={t.libelle}
          description={t.description}
          valeur={n.types[t.id]}
          onChange={(v) => maj((x) => ({ ...x, types: { ...x.types, [t.id]: v } }))}
        />
      ))}

      <h3 className="sous-titre">Seuils</h3>
      <ChampNombre id="n-pct" libelle="Disque : alerte sous" valeur={n.seuils.disquePct} min={1} max={50} suffixe="% libres" onChange={seuil("disquePct")} />
      <ChampNombre id="n-go" libelle="…ou sous" valeur={n.seuils.disqueGo} min={0} max={10000} suffixe="Go libres" onChange={seuil("disqueGo")} />
      <ChampNombre id="n-crit" libelle="Disque : critique sous" valeur={n.seuils.disqueCritiquePct} min={1} max={50} suffixe="% libres" onChange={seuil("disqueCritiquePct")} />
      <ChampNombre id="n-tor" libelle="Torrent bloqué depuis plus de" valeur={n.seuils.torrentHeures} min={1} max={72} suffixe="heures" onChange={seuil("torrentHeures")} />
      <ChampNombre id="n-svc" libelle="Service hors ligne depuis plus de" valeur={n.seuils.serviceMinutes} min={1} max={120} suffixe="minutes" onChange={seuil("serviceMinutes")} />
      <ChampNombre id="n-int" libelle="Vérifier toutes les" valeur={n.intervalleMin} min={1} max={60} suffixe="minutes" onChange={(v) => maj((x) => ({ ...x, intervalleMin: v }))} />
      <p className="muted">Une même alerte n'est renvoyée qu'après 6 heures tant que le problème dure. La nouvelle fréquence s'applique à la prochaine vérification.</p>

      <button className="bouton violet" disabled={envoi || !data?.configure} onClick={tester}>
        {envoi ? "Envoi…" : "Envoyer une notification de test"}
      </button>
      {resultat && (
        <p className={resultat.ok ? "muted" : "card error"} role={resultat.ok ? "status" : "alert"}>
          {resultat.texte}
        </p>
      )}

      {data && data.problemes.length > 0 && (
        <>
          <h3 className="sous-titre">Problèmes en cours</h3>
          <ul className="adresses">
            {data.problemes.map((p, i) => (
              <li key={i}>
                <span className="strong">{LIBELLE_TYPE[p.type] ?? p.type}</span> · {p.titre} <span className="muted">(depuis {ilYa(p.depuis).replace(/^il y a /, "")})</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="sous-titre">Dernières notifications</h3>
      {data && data.journal.length === 0 && <p className="muted">Aucune notification envoyée pour le moment.</p>}
      {data && data.journal.length > 0 && (
        <ul className="adresses journal-notifs">
          {data.journal.map((e, i) => (
            <li key={i} className={e.ok ? undefined : "etat-echec"}>
              <span className="strong">{LIBELLE_TYPE[e.type] ?? e.type}</span> · {e.titre}{" "}
              <span className="muted">({ilYa(e.date)})</span>
              {!e.ok && <div>Non envoyée : {e.erreur}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

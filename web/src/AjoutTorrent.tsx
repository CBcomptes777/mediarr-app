import { useEffect, useRef, useState } from "react";
import { action } from "./api";
import { taille } from "./format";
import { contientMagnet, koVersOctets, type EtatQbitApp } from "./qbitLogique";
import { Feuille, Message } from "./ui";
import { useApi } from "./useApi";

const MAX_OCTETS = 5 * 1024 * 1024;

interface Resume {
  ok: boolean;
  ajoutes: number;
  doublons: string[];
  echecs: { source: string; cause: string }[];
  error?: string;
}

/** Lit un fichier choisi sur l'iPhone et le renvoie en base64 (le serveur le transmet à qBittorrent). */
function enBase64(f: File): Promise<string> {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => ko(new Error("Lecture du fichier impossible"));
    r.readAsDataURL(f);
  });
}

/** Feuille « Ajouter un torrent » : liens magnet / .torrent (un par ligne) ou fichiers, avec les options de qBittorrent. */
export function AjoutTorrent({ onFermer, onAjoute }: { onFermer: () => void; onAjoute: () => void }) {
  const catalogue = useApi<EtatQbitApp>("/qbit/etat");
  const dossiers = useApi<{ racines: string[] }>("/qbit/dossiers");
  const [liens, setLiens] = useState("");
  const [fichiers, setFichiers] = useState<File[]>([]);
  const [options, setOptions] = useState(false);
  const [categorie, setCategorie] = useState("");
  const [nouvelle, setNouvelle] = useState("");
  const [chemin, setChemin] = useState("");
  const [etiquettes, setEtiquettes] = useState("");
  const [pause, setPause] = useState(false);
  const [sequentiel, setSequentiel] = useState(false);
  const [premierDernier, setPremierDernier] = useState(false);
  const [sansVerif, setSansVerif] = useState(false);
  const [limiteDl, setLimiteDl] = useState("");
  const [limiteUp, setLimiteUp] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [resume, setResume] = useState<Resume | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const [propose, setPropose] = useState<string | null>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  // À l'ouverture (qui vient d'un tap), on regarde si le presse-papiers contient un magnet : on PROPOSE de le coller, sans le coller seul.
  useEffect(() => {
    let fini = false;
    (async () => {
      try {
        const t = await navigator.clipboard?.readText?.();
        if (!fini && t && contientMagnet(t)) setPropose(t.trim());
      } catch {
        /* permission refusée ou indisponible : le bouton « Coller » reste là */
      }
    })();
    return () => {
      fini = true;
    };
  }, []);

  async function coller() {
    try {
      const t = propose ?? (await navigator.clipboard.readText());
      if (t) setLiens((l) => (l.trim() ? `${l.trimEnd()}\n${t.trim()}` : t.trim()));
      setPropose(null);
    } catch {
      setEchec("Impossible de lire le presse-papiers : colle le lien directement dans le champ.");
    }
  }

  function choisir(liste: FileList | null) {
    if (!liste) return;
    const ok: File[] = [];
    const refus: string[] = [];
    for (const f of [...liste]) {
      if (f.size > MAX_OCTETS) refus.push(`${f.name} (${taille(f.size)} : 5 Mo au plus)`);
      else ok.push(f);
    }
    setFichiers((a) => [...a, ...ok].slice(0, 10));
    setEchec(refus.length ? `Fichier trop gros : ${refus.join(", ")}` : null);
    if (champFichier.current) champFichier.current.value = "";
  }

  const dl = koVersOctets(limiteDl);
  const up = koVersOctets(limiteUp);
  const limitesValides = dl !== null && up !== null;
  const vide = !liens.trim() && fichiers.length === 0;

  async function envoyer() {
    setOccupe(true);
    setEchec(null);
    setResume(null);
    try {
      const donnees = await Promise.all(fichiers.map(async (f) => ({ nom: f.name, donnees: await enBase64(f) })));
      const cat = categorie === "__nouvelle" ? nouvelle.trim() : categorie;
      const r = await action<Resume>("POST", "/qbit/ajouter", {
        liens,
        fichiers: donnees,
        options: {
          ...(cat ? { categorie: cat } : {}),
          ...(chemin.trim() ? { chemin: chemin.trim() } : {}),
          etiquettes: etiquettes.split(",").map((t) => t.trim()).filter(Boolean),
          pause,
          sequentiel,
          premierDernier,
          sansVerification: sansVerif,
          ...(dl ? { limiteDl: dl } : {}),
          ...(up ? { limiteUp: up } : {}),
        },
      });
      setResume(r);
      setLiens("");
      setFichiers([]);
      onAjoute();
    } catch (e) {
      setEchec(e instanceof Error ? e.message : "Ajout impossible");
    } finally {
      setOccupe(false);
    }
  }

  return (
    <Feuille titre="Ajouter un torrent" sousTitre="qBittorrent" onFermer={onFermer}>
      {propose && (
        <button className="bouton violet" onClick={coller}>
          Coller le lien du presse-papiers
        </button>
      )}
      <label className="champ">
        <span>
          <strong>Liens magnet ou adresses .torrent</strong> (un par ligne)
        </span>
        <textarea
          rows={4}
          value={liens}
          onChange={(e) => setLiens(e.target.value)}
          placeholder="magnet:?xt=urn:btih:…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      {!propose && typeof navigator !== "undefined" && "clipboard" in navigator && (
        <button className="lien" onClick={coller}>
          Coller depuis le presse-papiers
        </button>
      )}

      <div className="champ">
        <span>
          <strong>Fichiers .torrent</strong> (5 Mo au plus chacun)
        </span>
        <input ref={champFichier} type="file" accept=".torrent,application/x-bittorrent" multiple onChange={(e) => choisir(e.target.files)} />
        {fichiers.length > 0 && (
          <ul className="adresses">
            {fichiers.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name} <span className="muted">({taille(f.size)})</span>{" "}
                <button className="lien" aria-label={`Retirer ${f.name}`} onClick={() => setFichiers((a) => a.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button className="bouton violet" aria-expanded={options} onClick={() => setOptions(!options)}>
        Options {options ? "▴" : "▾"}
      </button>
      {options && (
        <div className="panneau-filtres">
          <label className="champ-compact">
            <span>Catégorie</span>
            <select value={categorie} onChange={(e) => setCategorie(e.target.value)}>
              <option value="">Aucune</option>
              {(catalogue.data?.categories ?? []).map((c) => (
                <option key={c.nom} value={c.nom}>
                  {c.nom}
                </option>
              ))}
              <option value="__nouvelle">Nouvelle catégorie…</option>
            </select>
          </label>
          {categorie === "__nouvelle" && (
            <label className="champ-compact">
              <span>Nom de la nouvelle catégorie</span>
              <input value={nouvelle} maxLength={100} onChange={(e) => setNouvelle(e.target.value)} />
            </label>
          )}
          <label className="champ-compact">
            <span>Dossier de destination (vide : celui de la catégorie)</span>
            <input list="dossiers-qbit" value={chemin} onChange={(e) => setChemin(e.target.value)} placeholder="/downloads/films" autoCapitalize="off" autoCorrect="off" />
            <datalist id="dossiers-qbit">
              {(dossiers.data?.racines ?? []).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className="champ-compact">
            <span>Étiquettes (séparées par des virgules)</span>
            <input value={etiquettes} onChange={(e) => setEtiquettes(e.target.value)} placeholder="hd, à voir" />
          </label>
          <label className="case compact">
            <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} />
            <span>Démarrer en pause</span>
          </label>
          <label className="case compact">
            <input type="checkbox" checked={sequentiel} onChange={(e) => setSequentiel(e.target.checked)} />
            <span>Téléchargement séquentiel</span>
          </label>
          <label className="case compact">
            <input type="checkbox" checked={premierDernier} onChange={(e) => setPremierDernier(e.target.checked)} />
            <span>Premier et dernier morceau en priorité</span>
          </label>
          <label className="case compact">
            <input type="checkbox" checked={sansVerif} onChange={(e) => setSansVerif(e.target.checked)} />
            <span>Ignorer la vérification des fichiers</span>
          </label>
          <div className="filtres-selects">
            <label className="champ-compact">
              <span>Limite ↓ (Ko/s)</span>
              <input inputMode="decimal" value={limiteDl} onChange={(e) => setLimiteDl(e.target.value)} placeholder="Illimité" />
            </label>
            <label className="champ-compact">
              <span>Limite ↑ (Ko/s)</span>
              <input inputMode="decimal" value={limiteUp} onChange={(e) => setLimiteUp(e.target.value)} placeholder="Illimité" />
            </label>
          </div>
          {!limitesValides && <p className="card error">Limite de vitesse invalide : un nombre positif ou rien.</p>}
        </div>
      )}

      {echec && (
        <p className="card error" role="alert">
          {echec}
        </p>
      )}
      {resume && (
        <div className="card" role="status">
          <strong>{resume.ajoutes > 0 ? `Ajouté : ${resume.ajoutes} torrent${resume.ajoutes > 1 ? "s" : ""}` : "Rien d'ajouté"}</strong>
          {resume.doublons.length > 0 && <div className="muted">Déjà présents : {resume.doublons.join(", ")}</div>}
          {resume.echecs.map((e, i) => (
            <div key={i} className="error">
              {e.source} : {e.cause}
            </div>
          ))}
        </div>
      )}
      {occupe && <Message>Envoi à qBittorrent…</Message>}
      <button className="bouton plein" disabled={occupe || vide || !limitesValides || (categorie === "__nouvelle" && !nouvelle.trim())} onClick={envoyer}>
        {occupe ? "Envoi…" : "Ajouter"}
      </button>
    </Feuille>
  );
}

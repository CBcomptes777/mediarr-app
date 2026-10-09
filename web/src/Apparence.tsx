import { useEffect, useState } from "react";
import { appliquerApparence } from "./theme";
import type { Prefs } from "./prefs";
import { Interrupteur, ListeOrdonnable, NOMS_ONGLETS, TitreCarte, type Onglet } from "./ui";

type Enregistrer = (modifier: (p: Prefs) => Prefs) => Promise<void>;
type Apparence = Prefs["apparence"];

const ACCENTS: { couleur: string; nom: string }[] = [
  { couleur: "#a78bfa", nom: "Violet" },
  { couleur: "#60a5fa", nom: "Bleu" },
  { couleur: "#22d3ee", nom: "Cyan" },
  { couleur: "#34d399", nom: "Vert" },
  { couleur: "#fbbf24", nom: "Jaune" },
  { couleur: "#fb923c", nom: "Orange" },
  { couleur: "#f472b6", nom: "Rose" },
  { couleur: "#f87171", nom: "Rouge" },
];

/** Combien d'onglets s'affichent dans la barre : 5 au plus, et seulement ceux qui existent avec les options choisies. */
const MAX_ONGLETS = 5;

export function SectionApparence({ prefs, enregistrer }: { prefs: Prefs; enregistrer: Enregistrer }) {
  const a = prefs.apparence;
  const modifier = (suite: Partial<Apparence>) => enregistrer((p) => ({ ...p, apparence: { ...p.apparence, ...suite } }));

  // L'intensité suit le curseur en direct ; on n'enregistre qu'une fois qu'il s'est arrêté.
  const [intensite, setIntensite] = useState(a.intensite);
  useEffect(() => setIntensite(a.intensite), [a.intensite]);
  useEffect(() => {
    if (intensite === a.intensite) return;
    appliquerApparence({ ...a, intensite });
    const t = setTimeout(() => modifier({ intensite }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intensite]);

  const disponible = (id: string) =>
    id === "biblio" ? !a.bibliothequeScindee
    : id === "films" || id === "series" ? a.bibliothequeScindee
    : id === "services" ? !a.serviceSwitcherSepare
    : true;
  const affiches = a.onglets.filter((o) => o.visible && disponible(o.id)).length;

  return (
    <>
      <section className="card" aria-label="Apparence">
        <TitreCarte couleur="#f472b6">Apparence</TitreCarte>

        <div className="choix-groupe" role="radiogroup" aria-label="Thème">
          <span className="strong">Thème</span>
          <div className="filtres">
            {([["auto", "Auto"], ["clair", "Clair"], ["sombre", "Sombre"]] as const).map(([v, l]) => (
              <button key={v} role="radio" aria-checked={a.theme === v} className={a.theme === v ? "actif" : ""} onClick={() => modifier({ theme: v })}>
                {l}
              </button>
            ))}
          </div>
          <span className="muted">« Auto » suit le réglage clair / sombre de ton téléphone.</span>
        </div>

        <div className="choix-groupe" role="radiogroup" aria-label="Couleur d'accent">
          <span className="strong">Couleur d'accent</span>
          <div className="pastilles-couleur">
            {ACCENTS.map((c) => (
              <button
                key={c.couleur}
                role="radio"
                aria-checked={a.accent === c.couleur}
                aria-label={c.nom}
                title={c.nom}
                className={a.accent === c.couleur ? "pastille-couleur choisie" : "pastille-couleur"}
                style={{ background: c.couleur }}
                onClick={() => modifier({ accent: c.couleur })}
              >
                {a.accent === c.couleur ? "✓" : ""}
              </button>
            ))}
          </div>
          <label className="champ-couleur">
            <span className="muted">Couleur personnalisée</span>
            <input type="color" aria-label="Couleur personnalisée" value={a.accent} onChange={(e) => modifier({ accent: e.target.value })} />
          </label>
        </div>

        <div className="champ">
          <label htmlFor="intensite-fond">
            <strong>Intensité du fond</strong> <span className="strong">{intensite} %</span>
          </label>
          <input id="intensite-fond" type="range" min={0} max={100} step={5} value={intensite} onChange={(e) => setIntensite(Number(e.target.value))} />
          <span className="muted">Plus l'intensité est haute, plus le fond prend la couleur d'accent.</span>
        </div>
      </section>

      <section className="card" aria-label="Navigation">
        <TitreCarte couleur="#60a5fa">Navigation</TitreCarte>
        <Interrupteur
          libelle="Bibliothèque scindée"
          description="Remplace l'onglet Biblio par deux onglets, Films et Séries."
          valeur={a.bibliothequeScindee}
          onChange={(v) => modifier({ bibliothequeScindee: v })}
        />
        <Interrupteur
          libelle="Sélecteur de services séparé"
          description="Le tiroir Services est un bouton rond à côté de la barre. Désactivé : c'est un onglet de la barre."
          valeur={a.serviceSwitcherSepare}
          onChange={(v) => modifier({ serviceSwitcherSepare: v })}
        />
        <Interrupteur
          libelle="Libellés sous les icônes"
          description="Affiche le nom de chaque onglet sous son icône."
          valeur={a.libelles}
          onChange={(v) => modifier({ libelles: v })}
        />
        <Interrupteur
          libelle="Pastille des téléchargements"
          description="Nombre de téléchargements en cours sur l'onglet Activité."
          valeur={a.badges.activite}
          onChange={(v) => modifier({ badges: { ...a.badges, activite: v } })}
        />
        <Interrupteur
          libelle="Pastille des demandes"
          description="Nombre de demandes Overseerr en attente sur l'onglet Demandes."
          valeur={a.badges.demandes}
          onChange={(v) => modifier({ badges: { ...a.badges, demandes: v } })}
        />

        <h3 className="sous-titre">Barre d'onglets</h3>
        <p className="muted marge-bas">
          Coche les onglets à afficher et change leur ordre. La barre en montre {MAX_ONGLETS} au plus
          {affiches > MAX_ONGLETS ? ` : seuls les ${MAX_ONGLETS} premiers cochés sont affichés` : ""}.
        </p>
        <ListeOrdonnable
          elements={a.onglets.map((o) => ({
            id: o.id,
            libelle: NOMS_ONGLETS[o.id as Onglet] ?? o.id,
            visible: o.visible,
            detail: disponible(o.id) ? undefined : "Indisponible avec les options ci-dessus",
          }))}
          onChange={(suite) => modifier({ onglets: suite.map((s) => ({ id: s.id, visible: s.visible ?? true })) })}
        />
      </section>

      <section className="card" aria-label="Fiche d'un titre">
        <TitreCarte couleur="#4caf8a">Fiche d'un titre</TitreCarte>
        <Interrupteur
          libelle="Distribution"
          description="Acteurs et équipe d'un film (non disponible pour les séries : Sonarr ne la fournit pas)."
          valeur={a.detail.distribution}
          onChange={(v) => modifier({ detail: { ...a.detail, distribution: v } })}
        />
        <Interrupteur
          libelle="Studios et chaînes"
          description="Studio d'un film, chaîne d'une série."
          valeur={a.detail.studios}
          onChange={(v) => modifier({ detail: { ...a.detail, studios: v } })}
        />
        <Interrupteur
          libelle="Collection"
          description="Les autres films de la même saga présents dans ta bibliothèque."
          valeur={a.detail.collection}
          onChange={(v) => modifier({ detail: { ...a.detail, collection: v } })}
        />
      </section>
    </>
  );
}

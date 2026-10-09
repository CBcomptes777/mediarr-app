// Petits graphiques en SVG, sans bibliothèque : anneau, courbe et barre.
// Chaque graphique a une description lisible par un lecteur d'écran (role="img" + aria-label) :
// l'information ne passe jamais par la couleur seule (valeurs écrites à côté).
import { entier, pourcent } from "./format";

/** Couleurs de série, distinctes entre elles et lisibles sur fond sombre comme sur fond clair. */
export const PALETTE = ["#e07b2a", "#4a90e2", "#a78bfa", "#4caf8a", "#e8b04a", "#e56b8a", "#5bc0de", "#9aa5b1"];

export interface Part {
  nom: string;
  valeur: number;
}

/** Anneau (donut) avec sa légende : couleur, nom, valeur. */
export function Anneau({ parts, titre }: { parts: Part[]; titre: string }) {
  const total = parts.reduce((n, p) => n + p.valeur, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let decalage = 0;
  const arcs = parts.map((p, i) => {
    const longueur = total ? (p.valeur / total) * C : 0;
    // Un petit espace entre les parts (2 unités) pour les distinguer sans dépendre de la couleur.
    const arc = { couleur: PALETTE[i % PALETTE.length], longueur: Math.max(0, longueur - (parts.length > 1 ? 2 : 0)), decalage };
    decalage += longueur;
    return arc;
  });
  const description = `${titre} : ${parts.map((p) => `${p.nom} ${entier(p.valeur)}`).join(", ")}`;
  return (
    <div className="anneau">
      <svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label={description}>
        <g transform="rotate(-90 60 60)">
          {arcs.map((a, i) => (
            <circle
              key={i}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke={a.couleur}
              strokeWidth="20"
              strokeDasharray={`${a.longueur} ${C - a.longueur}`}
              strokeDashoffset={-a.decalage}
            />
          ))}
        </g>
      </svg>
      <ul className="legende anneau-legende">
        {parts.map((p, i) => (
          <li key={p.nom}>
            <span className="carre" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="strong">{p.nom}</span>
            <span className="muted">{entier(p.valeur)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Barre horizontale « nom — pourcentage » avec le détail dessous. */
export function BarreStat({ nom, ratio, detail, couleur = "var(--accent)" }: { nom: string; ratio: number; detail: string; couleur?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 10;
  return (
    <div className="barre">
      <div className="barre-tete">
        <span className="strong">{nom}</span>
        <span className="strong">{pourcent(ratio)}</span>
      </div>
      <div className="jauge" role="progressbar" aria-label={nom} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%`, background: couleur }} />
      </div>
      <span className="muted">{detail}</span>
    </div>
  );
}

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
/** « 2026-10 » → « oct. 26 » */
export const moisCourt = (m: string) => `${MOIS_COURTS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(2, 4)}`;

/** Courbe du total au fil des mois, avec axe vertical gradué et quelques repères de dates. */
export function Courbe({ points, titre }: { points: { mois: string; total: number }[]; titre: string }) {
  const L = 320;
  const H = 150;
  const g = { gauche: 38, droite: 8, haut: 8, bas: 22 };
  const valeurs = points.map((p) => p.total);
  const max = Math.max(1, ...valeurs);
  const min = Math.min(...valeurs, max);
  // Graduation « ronde » : le haut de l'axe est un multiple propre du pas.
  const pas = Math.pow(10, Math.floor(Math.log10(Math.max(1, max - min || max))));
  const haut = Math.ceil(max / pas) * pas;
  const bas = Math.floor(min / pas) * pas;
  const x = (i: number) => g.gauche + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (L - g.gauche - g.droite));
  const y = (v: number) => g.haut + (1 - (v - bas) / Math.max(1, haut - bas)) * (H - g.haut - g.bas);
  const trace = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.total).toFixed(1)}`).join(" ");
  const aire = points.length ? `${trace} L${x(points.length - 1).toFixed(1)} ${H - g.bas} L${x(0).toFixed(1)} ${H - g.bas} Z` : "";
  const graduations = [0, 1, 2, 3].map((i) => bas + ((haut - bas) / 3) * i);
  const reperes = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i && points[v]);
  const premier = points[0];
  const dernier = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${L} ${H}`} className="courbe" role="img" aria-label={premier && dernier ? `${titre} : de ${entier(premier.total)} en ${moisCourt(premier.mois)} à ${entier(dernier.total)} en ${moisCourt(dernier.mois)}` : titre}>
      {graduations.map((v) => (
        <g key={v}>
          <line x1={g.gauche} x2={L - g.droite} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.15" />
          <text x={g.gauche - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.75">
            {entier(Math.round(v))}
          </text>
        </g>
      ))}
      {aire && <path d={aire} fill="var(--accent)" fillOpacity="0.18" />}
      {trace && <path d={trace} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {dernier && <circle cx={x(points.length - 1)} cy={y(dernier.total)} r="3.5" fill="var(--accent)" />}
      {reperes.map((i) => (
        <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize="10" fill="currentColor" fillOpacity="0.75">
          {moisCourt(points[i].mois)}
        </text>
      ))}
    </svg>
  );
}

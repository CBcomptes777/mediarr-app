/** Les widgets de l'accueil : titre et description affichés dans « Ajouter un widget ». */
export const WIDGETS_INFO: Record<string, { titre: string; description: string }> = {
  alertes: { titre: "Alertes", description: "Avertissements de Prowlarr et problèmes détectés." },
  services: { titre: "Services", description: "État de chaque service, en un coup d'œil." },
  ajout: { titre: "Ajouter un média", description: "Chercher et ajouter un film ou une série." },
  apercu: { titre: "Vue d'ensemble", description: "Nombre de films et de séries." },
  telechargements: { titre: "Derniers téléchargements", description: "Les titres récemment importés." },
  completude: { titre: "Complétude", description: "Part des films et des épisodes présents." },
  stockage: { titre: "Stockage", description: "Espace occupé, réparti entre Sonarr et Radarr." },
  qbit: { titre: "qBittorrent", description: "Vitesse et téléchargement en cours." },
  plex: { titre: "Plex — en lecture", description: "Ce qui est regardé en ce moment." },
  sorties: { titre: "Prochaines sorties", description: "Films et épisodes attendus cette semaine." },
  genres: { titre: "Genres", description: "Les cinq genres les plus présents." },
  actions: { titre: "Actions rapides", description: "Tes raccourcis : un média, un écran ou un lien." },
};

/** Écrans de l'app qu'une action rapide peut ouvrir. */
export const ECRANS_ACTIONS: { id: string; libelle: string }[] = [
  { id: "biblio", libelle: "Bibliothèque" },
  { id: "films", libelle: "Films" },
  { id: "series", libelle: "Séries" },
  { id: "calendrier", libelle: "Calendrier" },
  { id: "activite", libelle: "Activité (file d'attente)" },
  { id: "historique", libelle: "Historique" },
  { id: "demandes", libelle: "Demandes Overseerr" },
  { id: "plex", libelle: "Plex — en lecture" },
  { id: "indexeurs", libelle: "Indexeurs (Prowlarr)" },
  { id: "recherche", libelle: "Recherche interactive" },
  { id: "stats", libelle: "Stats" },
  { id: "reglages", libelle: "Réglages" },
];

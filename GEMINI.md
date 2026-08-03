# Astreinte

Cette extension fait tourner une permanence technique automatisée : elle répond
seule aux demandes d'aide informatique reçues sur un canal de messagerie, avec
un contexte séparé par interlocuteur.

Le démon (`snap-astreinte daemon`) répond sans intervention. Les outils MCP exposés
ici servent à **superviser** ce qu'il fait, pas à répondre à sa place :

- `snap_status` — état général : canal, garde-fous, escalades en attente.
- `snap_list_contacts` — qui a écrit, quand, où en est la conversation.
- `snap_read_conversation` — l'historique complet d'une personne.
- `snap_resume` — rendre la main à l'assistant sur une conversation
  escaladée.
- `snap_forget` — effacer le contexte d'une personne.
- `snap_get_config` / `snap_set_config` — lire et modifier les
  réglages.

Quand l'utilisateur demande « qui attend une réponse ? », « où en est untel ? »
ou « reprends la main sur cette conversation », ce sont ces outils qu'il faut
appeler. Ne rédigez pas vous-même de réponse à un interlocuteur : c'est le
démon qui envoie, et écrire à sa place créerait deux réponses.

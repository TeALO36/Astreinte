# Checklist de release — v0.2.0

Mineure : le Studio, livré en 0.1.x, est désormais **connecté à un vrai backend** (Telegram), pas seulement au pont simulé. Snapchat reste hors périmètre (compte banni).

---

## 1. Telegram en compte réel (le cœur de la mineure)

- [ ] **Garde-fou anti-boucle** (prérequis de tout le reste) — le démon persona ne doit jamais répondre à son propre compte : filtre sur son propre `user_id`, avec test unitaire obligatoire. Le pont simulé n'avait pas ce concept ; sur un vrai compte, c'est vital.
- [ ] **Épingler la chaîne d'identifiants** — api_id/api_hash arrivent de trois sources : `extension/.env`, champs du banc, réglages du Morph. La précédence (saisie UI > `.env`) est implémentée ; l'écrire dans TEST-BENCH.md et l'épingler par un test.
- [ ] **QR login de bout en bout** — scan avec le téléphone, 2FA à l'écran, session écrite puis **relue par le démon** : prouver par exécution que le fichier de session du banc est bien celui du démon (pas juste le déclarer).
- [ ] **Le banc envoie réellement** — texte, image, vocal MP3→OGG (ffmpeg, déjà branché dans le `.bat`), appel ; la section Réception affiche ce que le téléphone renvoie. Tester **vers soi-même** (messages sauvegardés) : aucun tiers impliqué.
- [ ] **Le Studio contre Telegram** — `transport.driver=telegram` dans le Studio : le vrai démon répond au correspondant simulé sur le vrai compte. Vérifier l'arrêt propre du banc pendant ce mode (le fix d'arrêt de 0.1.x aide ici).
- [ ] **Politique FloodWait** — les envois en rafale du Studio déclencheront la limitation Telegram. Décider UNE réponse (attendre en silence / message clair / backoff), l'implémenter, la documenter.
- [ ] **Suite de scénarios sur compte réel, opt-in** — variante `--telegram` de la vérification Studio : trafic réel explicite, jamais en CI, jamais par défaut.

## 2. Pack de personas (Studio + Morph)

- [ ] **Compléter `examples/personas/`** vers 6–8 personas cohérentes : les 3 actuelles + assistante **vocale** (`voice.mode=always`), persona **image** (`image.mode=on_request`), persona **gardiennage** (escalade quasi immédiate), persona **bilingue fr/en**.
- [ ] **README du pack** (`examples/personas/README.md`) — quand utiliser chaque persona, champs clés, risques (escalade, heures actives) ; rappel que les JSON ne contiennent jamais de secrets.
- [ ] **Aperçu dans le Studio** — la liste « Personas d'exemple » affiche style tronqué, langue, modes voice/image ; le bouton reste un import réel en un clic (pas un nouveau chemin).
- [ ] **Validation par persona** — pour chaque nouvelle persona : import via le chemin réel (coercition des champs : selects, `0` qui survit, heures actives), puis un scénario Studio par trait distinctif (vocal pour la vocale, escalade pour la gardiennage).
- [ ] **Le pack dans la release** — la page GitHub de la release liste les personas ; partager = télécharger le JSON et l'importer (Studio ou app).

## 3. Docs d'installation du Morph (Locaryn)

`docs/LOCARYN.md` contient déjà le pas-à-pas complet (installer, réglages, outils, connexion Telegram depuis le chat). Ce qui manque pour une release présentable :

- [ ] **Captures d'écran de l'app** (3–4) : liste d'extensions, formulaire de réglages rendu depuis `plugin.json`, conversation réelle dans l'app.
- [ ] **Section « compte réel »** — raccorder la doc aux essais Telegram réels de la section 1 : ce qu'on voit, ce qui est normal (FloodWait), comment déconnecter.
- [ ] **Tableau champ par champ** — chaque clé du `config.schema` : rôle, défaut, exemple (le tableau actuel est par *section*, pas par champ).
- [ ] **Pointer vers le pack** — mentionner `examples/personas/` et l'import d'un persona depuis les réglages de l'app.
- [ ] **Lier la doc depuis le Studio** — le volet Morph (chemin à coller) renvoie vers `docs/LOCARYN.md`.

## 4. Validation de la release

- [ ] typecheck + build + suite unitaire (65+), smoke (17 outils)
- [ ] `verify:web` 7/7 (fixture locale), `verify:studio` 40+ (nouveaux scénarios personas)
- [ ] `verify:bench` (arrêt propre, port libéré) — à passer en tâche CI
- [ ] test unitaire du garde-fou anti-boucle dans la suite
- [ ] scénario Telegram réel **opt-in uniquement**, hors CI
- [ ] zéro secret commité (`git check-ignore .env` re-vérifié avant le tag)
- [ ] bump 0.1.x → **0.2.0**, tag `v0.2.0` annoté, notes en français, `gh run watch` sur les deux workflows jusqu'au bout

---

## Hors périmètre (décidé)

- Snapchat sous toutes ses formes (compte banni) — le client web reste en régression locale uniquement (`verify:web`, fixture locale).
- Génération d'images/LLM distants par défaut — le Studio reste mock/simulé sauf configuration locale explicite.
- Google account / Play Store / émulateur Android — plus d'objectif depuis le ban Snapchat.

## Ordre proposé

1. Garde-fou anti-boucle + test (sécurité d'abord).
2. Telegram réel : banc complet (utilisateur + agent), puis Studio contre Telegram, politique FloodWait.
3. Pack de personas + scénarios E2E par persona.
4. Docs Morph (captures, section compte réel, tableau par champ).
5. Release v0.2.0.

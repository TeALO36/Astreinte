# Banc de test SnapMCP

Depuis le dossier `.snap-astreinte` :

```bash
npm run build
npm run test-bench
```

La commande démarre une fenêtre locale dans le navigateur sur `127.0.0.1`.
Avec `--no-open`, elle démarre le serveur sans ouvrir le navigateur :

```bash
npm run test-bench -- --no-open --port 8787
```

## Parcours conseillé

1. Cliquer sur **Vérifier le PC et les connexions**.
2. Choisir `Simulation` et cliquer sur **Vérifier ce backend**.
3. Tester les outils manuellement avec **Appel d'outil manuel**.
4. Pour Telegram, saisir `api_id`, `api_hash`, puis le fichier de session. Le bouton **Vérifier ce backend** lit réellement les conversations ; il n'accepte donc pas une session invalide.
5. **Première connexion ?** La section « Connexion Telegram — compte ou bot » fait tout : **Se connecter par QR (compte)** affiche un QR à scanner avec le téléphone (la 2FA, si présente, est demandée à l'écran), **Se connecter en bot** prend le jeton de @BotFather sans rien demander d'autre. La session est écrite dans le fichier indiqué et servira aussi au démon.
6. Pour Android ou une VM, démarrer l'appareil, saisir son serial ADB si nécessaire, puis vérifier le backend. Le diagnostic appelle `adb devices`.
7. Pour Snapchat Web, cliquer sur **Ouvrir Snapchat Web / QR**, scanner le QR dans Chromium, puis cliquer sur **Vérifier Snapchat Web**.
8. Utiliser ensuite les tests texte, média, vocal et appel.

Le diagnostic ne fait aucun envoi. Les boutons d'envoi et les appels manuels peuvent agir réellement sur le compte ou l'appareil sélectionné.

Les identifiants Telegram saisis dans cette fenêtre restent en mémoire du processus et ne sont pas écrits par le banc. Fermer la fenêtre ou cliquer sur **Fermer les sessions** après les essais.

## Les trois machines virtuelles Android

Le banc s'appuie sur trois VM Android (AVD), toutes en API 35 avec l'image **Google Play** (le Play Store est donc présent dans le système, sans aucun compte nécessaire pour l'ouvrir) :

| VM | Port ADB | Profil |
|---|---|---|
| `SnapMCP_API35` | `emulator-5554` | Pixel 5 |
| `SnapMCP_Pixel7_API35` | `emulator-5556` | Pixel 7 |
| `SnapMCP_PixelFold_API35` | `emulator-5558` | Pixel Fold |

### Créer les VM la première fois

Les trois AVD n'existent pas sur une machine neuve, et `android:vms` s'arrête
alors sur « AVD manquants ». Pour les fabriquer :

```bash
npm run android:provision                       # état des lieux, ne change rien
npm run android:provision -- --all              # composants du SDK, puis AVD
```

L'état des lieux est le comportement par défaut : l'installation télécharge
plusieurs gigaoctets (image système `google_apis_playstore` comprise) et écrit
dans le SDK de la machine. Options : `--install` (composants seuls),
`--create-avds` (AVD seuls), `--api 34` (viser une autre API), `--force`
(recréer un AVD existant — ses snapshots et ses données partent avec).

Pour les démarrer et vérifier le Play Store sur chacune :

```bash
npm run android:vms                  # fenêtres visibles (défaut)
npm run android:vms:headless         # sans fenêtre, pour CI ou serveur
```

Le script démarre les VM, attend la fin du boot, ouvre le Play Store sur chacune et vérifie qu'il est bien au premier plan (fenêtre `com.android.vending` / `com.google.android.finsky`). Il écrit une capture d'écran par VM dans le dossier temporaire indiqué en fin de sortie. Options utiles : `--cold` (boot complet sans snapshot), `--check-only` (vérifie des VM déjà lancées), `--quit-after-check` (arrête les VM après la vérification).

Il existe aussi un lanceur double-clic : **`Lancer-VMs-Android.bat`** à la racine du dépôt. Les VM restent lancées après le script ; pour les arrêter :

```bash
adb -s emulator-5554 emu kill
adb -s emulator-5556 emu kill
adb -s emulator-5558 emu kill
```

## Lire et piloter l'écran d'une VM

Une capture PNG ne se compare pas en script. `android:screen` lit l'arbre
d'interface — c'est lui qui dit quels textes et quels boutons sont réellement à
l'écran — et sait y toucher.

```bash
npm run android:screen                              # décrit l'écran
npm run android:screen -- --grep "Play"             # échoue si le texte est absent
npm run android:screen -- --tap 540 1200            # appuie
npm run android:screen -- --swipe 540 1600 540 600  # fait défiler
npm run android:screen -- --back                    # retour
npm run android:screen -- --home                    # accueil
npm run android:screen -- --text "bonjour"          # saisit du texte
npm run android:screen -- --keyevent 82             # une touche brute
```

Sans `--serial`, le script agit sur le seul appareil prêt ; s'il y en a
plusieurs, il refuse plutôt que d'en choisir un. Chaque action est suivie d'une
relecture de l'écran, si bien qu'on voit ce qu'elle a produit. La capture et
l'arbre XML sont écrits dans le dossier temporaire indiqué en sortie.

`--grep` rend un code de sortie non nul quand le texte manque : c'est ce qui
permet d'enchaîner des vérifications dans un script.

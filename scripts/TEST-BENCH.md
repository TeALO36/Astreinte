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
4. Pour Telegram : les champs `api_id`/`api_hash` sont **optionnels** — remplis, ils sont prioritaires ; laissés vides, ils sont lus dans `extension/.env`. Saisir ensuite le fichier de session. Le bouton **Vérifier ce backend** lit réellement les conversations ; il n'accepte donc pas une session invalide.
5. **Première connexion ?** La section « Connexion Telegram — compte ou bot » fait tout : **Se connecter par QR (compte)** affiche un QR à scanner avec le téléphone (la 2FA, si présente, est demandée à l'écran), **Se connecter en bot** prend le jeton de @BotFather sans rien demander d'autre. La session est écrite dans le fichier indiqué et servira aussi au démon.
6. Pour Android ou une VM, démarrer l'appareil, saisir son serial ADB si nécessaire, puis vérifier le backend. Le diagnostic appelle `adb devices`.
7. Pour Snapchat Web, cliquer sur **Ouvrir Snapchat Web / QR**, scanner le QR dans Chromium, puis cliquer sur **Vérifier Snapchat Web**.
8. Utiliser ensuite les tests texte, média, vocal et appel.
9. **Lire ce qu'on vous a envoyé** : la section « Réception — lire les messages et voir les médias reçus » lit les derniers messages de la conversation (bouton **Lire les messages reçus**) puis télécharge et affiche les images reçues via l'outil `get_media`. Le champ « ID du message » permet de rafraîchir un média précis.

Le diagnostic ne fait aucun envoi. Les boutons d'envoi et les appels manuels peuvent agir réellement sur le compte ou l'appareil sélectionné.

Les identifiants Telegram saisis dans cette fenêtre restent en mémoire du processus et ne sont pas écrits par le banc. Une clé erronée n'interrompt plus rien : chaque outil renvoie une erreur véridique et le serveur reste utilisable. Fermer la fenêtre ou cliquer sur **Fermer les sessions** après les essais.

## Les trois machines virtuelles Android

Le banc s'appuie sur trois VM Android (AVD), toutes en API 35 avec l'image **Google Play** (le Play Store est donc présent dans le système, sans aucun compte nécessaire pour l'ouvrir) :

| VM | Port ADB | Profil |
|---|---|---|
| `SnapMCP_API35` | `emulator-5554` | Pixel 5 |
| `SnapMCP_Pixel7_API35` | `emulator-5556` | Pixel 7 |
| `SnapMCP_PixelFold_API35` | `emulator-5558` | Pixel Fold |

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

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
5. Pour Android ou une VM, démarrer l'appareil, saisir son serial ADB si nécessaire, puis vérifier le backend. Le diagnostic appelle `adb devices`.
6. Pour Snapchat Web, cliquer sur **Ouvrir Snapchat Web / QR**, scanner le QR dans Chromium, puis cliquer sur **Vérifier Snapchat Web**.
7. Utiliser ensuite les tests texte, média, vocal et appel.

Le diagnostic ne fait aucun envoi. Les boutons d'envoi et les appels manuels peuvent agir réellement sur le compte ou l'appareil sélectionné.

Les identifiants Telegram saisis dans cette fenêtre restent en mémoire du processus et ne sont pas écrits par le banc. Fermer la fenêtre ou cliquer sur **Fermer les sessions** après les essais.

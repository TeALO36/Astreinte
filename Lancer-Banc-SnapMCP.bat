@echo off
setlocal EnableExtensions
chcp 65001 >nul
title SnapMCP - Installation et banc de test
color 0B

cd /d "%~dp0"

echo.
echo ================================================================
echo       SnapMCP - installation et banc de test
echo ================================================================
echo.
echo Ce fichier prepare l'extension puis ouvre la petite fenetre de test.
echo Aucune commande ne doit etre saisie manuellement.
echo.

where node >nul 2>&1
if errorlevel 1 goto :node_missing
where npm >nul 2>&1
if errorlevel 1 goto :npm_missing

node -e "process.exit(Number(process.versions.node.split('.')[0]) ^< 20 ? 1 : 0)" >nul 2>&1
if errorlevel 1 goto :node_old

echo [1/4] Verification des dependances Node.js...
if not exist "node_modules\" (
    echo Installation des dependances de l'extension...
    call npm ci --no-audit --no-fund
    if errorlevel 1 goto :npm_failed
) else (
    echo Dependances deja presentes.
)

echo.
echo [2/4] Preparation de Chromium pour Snapchat Web...
call npx playwright install chromium
if errorlevel 1 (
    echo.
    echo AVERTISSEMENT : Chromium n'a pas pu etre installe.
    echo Les tests Simulation, Telegram et ADB restent disponibles.
    echo Le diagnostic de la fenetre expliquera le probleme Snapchat Web.
)

echo.
echo [3/4] Compilation du serveur MCP...
call npm run build
if errorlevel 1 goto :build_failed

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo.
    echo AVERTISSEMENT : ffmpeg est absent du PATH.
    echo Les vocaux Telegram ne pourront pas etre convertis automatiquement.
)
where adb >nul 2>&1
if errorlevel 1 (
    echo.
    echo AVERTISSEMENT : ADB est absent du PATH.
    echo Les tests telephone et VM Android seront indisponibles.
)

echo.


rem ffmpeg installe par l assistant dans D:\tools\ffmpeg (winget) : versions
rem datees dans un sous-dossier, exposees via une jonction current.
if exist "D:\tools\ffmpeg\current\bin\ffmpeg.exe" goto ffmpeg_ok
for /d %%D in ("D:\tools\ffmpeg\ffmpeg-*") do set "FFDIR=%%D"
if defined FFDIR if not exist "D:\tools\ffmpeg\current" mklink /j "D:\tools\ffmpeg\current" "%FFDIR%" >nul 2>&1
:ffmpeg_ok
if exist "D:\tools\ffmpeg\current\bin\ffmpeg.exe" (
    set "PATH=D:\tools\ffmpeg\current\bin;%PATH%"
    echo ffmpeg : D:\tools\ffmpeg\current\bin ajoute au PATH.
) else (
    where ffmpeg >nul 2>&1 || echo AVERTISSEMENT : ffmpeg absent - les vocaux Telegram echoueront.
)
echo [4/4] Ouverture du banc de test...
echo La fenetre du navigateur va s'ouvrir automatiquement.
echo Pour arreter le banc : fermer la fenetre ou utiliser Ctrl+C ici.
echo.
call npm run test-bench
if errorlevel 1 goto :bench_failed

goto :done

:node_missing
echo ERREUR : Node.js n'est pas installe.
echo Installe Node.js 20 ou plus recent depuis https://nodejs.org/
goto :failure

:npm_missing
echo ERREUR : npm est introuvable.
echo Reinstalle Node.js 20 ou plus recent depuis https://nodejs.org/
goto :failure

:node_old
echo ERREUR : cette extension necessite Node.js 20 ou plus recent.
node --version
goto :failure

:npm_failed
echo ERREUR : l'installation des dependances a echoue.
goto :failure

:build_failed
echo ERREUR : la compilation du serveur MCP a echoue.
goto :failure

:bench_failed
echo Le banc de test s'est arrete avec une erreur.
goto :failure

:done
echo.
echo Banc de test ferme.
goto :end

:failure
echo.
echo Consulte les messages ci-dessus. Aucun compte n'a ete modifie par le diagnostic.
pause

:end
endlocal

@echo off
setlocal EnableExtensions
chcp 65001 >nul
title SnapMCP - Machines virtuelles Android
color 0B

cd /d "%~dp0"

echo.
echo ================================================================
echo       SnapMCP - les trois machines virtuelles Android
echo ================================================================
echo.
echo Cette fenetre demarre les trois VM Android du banc (Pixel 5,
echo Pixel 7 et Pixel Fold, API 35 avec Google Play), attend la fin
echo du boot, ouvre le Play Store sur chacune et verifie qu'il est
echo bien a l'ecran.
echo.
echo Le Play Store n'a besoin d'aucun compte pour cette verification.
echo Fermer cette fenetre n'arrete pas les VM : elles restent
echo disponibles pour le banc de test.
echo.

where node >nul 2>&1
if errorlevel 1 goto :node_missing

echo [1/3] Verification du SDK Android...
if not exist "%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" (
    echo ERREUR : SDK Android introuvable.
    goto :failure
)

echo [2/3] Demarrage des trois VM et ouverture du Play Store...
echo Cela peut prendre 1 a 3 minutes au premier lancement.
echo.

call node scripts/android-vms.mjs
if errorlevel 1 goto :vms_failed

echo.
echo Les trois VM sont lancees et le Play Store est ouvert sur chacune.
echo Les VM restent actives pour le banc de test.
goto :done

:node_missing
echo ERREUR : Node.js n'est pas installe.
echo Installe Node.js 20 ou plus recent depuis https://nodejs.org/
goto :failure

:vms_failed
echo.
echo ECHEC : une ou plusieurs VM n'ont pas pu demarrer ou le Play Store
echo ne s'est pas ouvert. Consulte les messages ci-dessus.
goto :failure

:done
echo.
pause

:end
endlocal

# Plan : AUTOEXEC.BAT et CONFIG.SYS éditables

## Objectif

Les programmes DOS héritent leur environnement d'un vrai AUTOEXEC.BAT persisté en IndexedDB, éditable avec NOTEPAD/EDIT.

## Étape 1 : Contenu par défaut

Dans `file-manager.ts`, donner un contenu réel aux fichiers `AUTOEXEC.BAT` et `CONFIG.SYS` (actuellement ce sont des entrées de listing sans contenu).

**AUTOEXEC.BAT** :
```
@ECHO OFF
SET BLASTER=A220 I7 D1 T4
SET PATH=C:\
SET COMSPEC=C:\COMMAND.COM
```

**CONFIG.SYS** :
```
FILES=40
BUFFERS=20
```

Ces contenus sont écrits en IndexedDB au premier lancement (si le fichier n'existe pas déjà). Si l'utilisateur les a modifiés, on garde sa version.

## Étape 2 : Lecture/écriture via INT 21h

S'assurer que `C:\AUTOEXEC.BAT` et `C:\CONFIG.SYS` sont accessibles en open/read/write via les handlers INT 21h existants (AH=3Dh open, AH=3Fh read, AH=40h write). Le file-manager gère déjà IndexedDB — il faut juste que ces fichiers y soient présents avec leur contenu (étape 1).

Vérifier que NOTEPAD (Win16) et EDIT (DOS) peuvent ouvrir, modifier et sauvegarder ces fichiers.

## Étape 3 : Parser AUTOEXEC.BAT au chargement MZ/COM

Dans `mz-loader.ts`, au moment de construire le bloc environnement du PSP :

1. Lire le contenu d'AUTOEXEC.BAT depuis IndexedDB (via file-manager)
2. Parser les lignes pertinentes :
   - `SET VAR=VALUE` → variable d'environnement
   - `PATH=...` ou `PATH ...` (sans SET) → équivalent de `SET PATH=...` (syntaxe DOS classique)
   - Ignorer les autres lignes (ECHO, REM, commandes exécutables, etc.)
3. Construire l'environnement DOS à partir de ces variables
4. Ajouter les variables par défaut si absentes (COMSPEC, PATH, BLASTER)

Le parsing est trivial : pour chaque ligne, `trim()`, case-insensitive, extraire `key=value`.

## Étape 3b : Utiliser PATH dans la recherche de fichiers

Quand INT 21h AH=4Bh (EXEC) ou AH=3Dh (OPEN) reçoit un nom de fichier sans chemin absolu, chercher dans les répertoires listés dans la variable PATH de l'environnement (séparés par `;`). Actuellement la recherche se fait uniquement dans le répertoire courant.

### Point d'attention : async IndexedDB

`loadMZ`/`loadCOM` sont synchrones mais la lecture IndexedDB est asynchrone. `emu-load.ts` est déjà async — charger le contenu d'AUTOEXEC.BAT en amont et le passer au loader. C'est cohérent avec un vrai PC où AUTOEXEC.BAT est lu une seule fois au boot — pas à chaque EXEC.

## Étape 4 : Retirer le hardcoding

Une fois l'étape 3 en place, retirer la variable `BLASTER` hardcodée ajoutée dans `mz-loader.ts` (commit actuel) — elle sera désormais fournie par le contenu d'AUTOEXEC.BAT.

Conserver des valeurs par défaut en fallback si AUTOEXEC.BAT est vide ou absent (COMSPEC et PATH au minimum).

## Étape 5 : Boîte de dialogue File Open/Save virtuelle

Pré-requis pour que l'utilisateur puisse éditer AUTOEXEC.BAT depuis un programme émulé (ex: NOTEPAD File>Open). Actuellement, File>Open ouvre le file picker natif du navigateur (fichiers hôtes) au lieu de montrer les fichiers de l'émulateur.

Voir [plan-file-dialog.md](plan-file-dialog.md) pour le plan détaillé.

## Étape 6 : Double-clic sur AUTOEXEC.BAT pour recharger l'environnement (idée — à rediscuter)

Permettre à l'utilisateur de double-cliquer sur AUTOEXEC.BAT pour re-parser les `SET`/`PATH` et mettre à jour `emu.envVars`. Les programmes déjà lancés gardent leur environnement (comportement normal), seuls les futurs programmes héritent des changements.

Workflow : éditer avec NOTEPAD → sauvegarder → double-clic → environnement mis à jour.

**Point ouvert** : il faut un moyen d'accéder au fichier pour double-cliquer dessus. Piste : un dossier "Poste de travail" / "My Computer" sur le bureau qui expose le filesystem virtuel (C:\, D:\). Design à définir — ça touche aussi à l'explorateur de fichiers en général.

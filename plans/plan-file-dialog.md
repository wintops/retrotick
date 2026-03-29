# Plan : Boîte de dialogue File Open/Save virtuelle

## Contexte actuel

Quand un programme émulé appelle `GetOpenFileName` / `GetSaveFileName` :
- Win32 (`comdlg32.ts`) → `emu.onFileDialog` → `<input type="file">` natif du navigateur
- Win16 (`commdlg.ts`) → `emu.onShowCommonDialog` → idem

L'utilisateur navigue dans ses fichiers **hôtes**, pas dans le filesystem de l'émulateur. Le fichier sélectionné est stocké sur `Z:\` (in-memory). Il n'y a aucun moyen de parcourir les fichiers virtuels (C:\, D:\).

## Objectif

Remplacer le file picker natif par une boîte de dialogue Win2k émulée qui :
1. Affiche les fichiers du filesystem virtuel (C:\, D:\) par défaut
2. Permet de naviguer dans les répertoires virtuels
3. Offre un bouton "Importer depuis le PC" qui ouvre le file picker natif (mécanisme actuel sur Z:\)
4. Pour Save : écrit dans le filesystem virtuel (IndexedDB) avec option "Exporter vers le PC"

## Étape 1 : Composant FileDialog Win2k

Créer un composant Preact dans `src/components/win2k/FileDialog.tsx` qui reproduit la boîte "Ouvrir" / "Enregistrer sous" de Windows 2000 :
- Liste de fichiers avec icônes (nom, taille, date)
- Barre de navigation (combo drive C:/D:/Z:, boutons haut/nouveau dossier)
- Champ "Nom du fichier" + combo "Type de fichiers" (filtres)
- Boutons "Ouvrir"/"Enregistrer" et "Annuler"
- Bouton supplémentaire "Importer depuis le PC..." (spécifique émulateur)

Le composant reçoit :
- `mode: 'open' | 'save'`
- `filter: string` (format Win32 : `"Text Files|*.txt|All Files|*.*"`)
- `initialDir: string`
- `onResult: (path: string, data?: Uint8Array) => void`
- `onCancel: () => void`
- Un accès au FileManager pour lister/lire les fichiers

## Étape 2 : API FileManager — listing par répertoire

`file-manager.ts` expose déjà `getVirtualDirListing()` mais uniquement pour `C:\*.*`. Étendre pour supporter :
- Listing de n'importe quel répertoire sur n'importe quel drive (C:\, D:\, Z:\)
- Retourner nom, taille, attributs (fichier/dossier), date
- Supporter les filtres par extension (*.txt, *.bmp, etc.)

## Étape 3 : Brancher sur les callbacks existants

Remplacer le mécanisme actuel dans `EmulatorView.tsx` :
- `emu.onFileDialog` → afficher `<FileDialog>` au lieu du `<input type="file">`
- `emu.onShowCommonDialog` → idem pour Win16
- Le bouton "Importer depuis le PC" déclenche l'ancien mécanisme (`<input type="file">`) et copie le fichier dans le drive courant avant de le sélectionner

## Étape 4 : Écriture et persistance

Pour le mode Save :
- Écrire le fichier dans le filesystem virtuel via FileManager (IndexedDB)
- Option "Exporter vers le PC" → téléchargement navigateur (mécanisme actuel)

## Points d'attention

- La boîte de dialogue doit être modale (bloquer l'émulation comme actuellement avec `waitingForMessage`)
- Les widgets Win2k existants (`src/components/win2k/`) couvrent déjà ListView, ComboBox, Button, etc. — les réutiliser
- Le champ "Nom du fichier" doit accepter la saisie directe de chemins (C:\AUTOEXEC.BAT)
- Gérer le cas où le programme demande un filtre spécifique (*.exe, *.txt) et ne montrer que les fichiers correspondants + "All Files"

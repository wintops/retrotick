<div lang="fr">

# RetroTick

[English](./README.md) | <a lang="zh-Hans" href="./README.zh-Hans.md">简体中文</a> | <a lang="ja" href="./README.ja.md">日本語</a>

**Exécutez des programmes Windows et DOS classiques directement dans votre navigateur.** Pas d'émulation d'OS. Juste un émulateur de CPU x86 avec les API Windows/DOS réimplémentées. Glissez un `.exe` dans la page et voyez ce qui se passe.

### [Essayez maintenant → retrotick.com](https://retrotick.com/)

<img src="https://static.retrotick.com/screenshot.webp" width="800" height="600" alt="Capture d'écran" />

RetroTick est un émulateur de CPU x86/ARM et une couche de compatibilité Windows/DOS entièrement construits from scratch en TypeScript. Plutôt que d'émuler un système d'exploitation complet, il émule le processeur et réimplémente directement les API de l'OS. Il analyse les binaires PE (Win32/WinCE), NE (Win16) et MZ (DOS), exécute le code machine x86 et ARM instruction par instruction, et fournit une partie des API Win32, Win16 et DOS, permettant à certains fichiers `.exe` de l'ère Windows classique de s'exécuter et d'afficher leurs interfaces graphiques dans le navigateur.

## Programmes supportés

| Catégorie | Programmes |
|-----------|------------|
| Jeux | FreeCell, Solitaire, Démineur, SkiFree, Prince of Persia (DOS), Chinese Paladin (DOS), Moktar (DOS) |
| Programmes | Calculatrice, Horloge, Invite de commandes, Gestionnaire des tâches, Magnétophone, Bloc-notes (Win 3.1x), QBasic, GLX Gears |
| Écrans de veille | Labyrinthe 3D (OpenGL), Tuyaux 3D (OpenGL), Mystify, Champ d'étoiles, Bézier, Boîte à fleurs, Texte défilant |

La plupart des programmes présentent des défauts de rendu ou des fonctionnalités manquantes. Le projet est en cours de développement.

## Sous le capot

- **Émulateur CPU x86** — FPU x87, évaluation paresseuse des flags, mode protégé 32 bits (modèle plat) et mode réel 16 bits avec adressage segment:offset, IVT, PSP, porte A20
- **Émulateur CPU ARM** — Exécution basique d'instructions ARM pour les binaires PE Windows CE (WinCE)
- **Chargeur de binaires PE/NE/MZ** — Analyse des en-têtes, mapping des sections, résolution des imports, extraction des ressources ; chargement de DLL PE avec relocation de base et détection de conflits
- **Couche de compatibilité Win32** — kernel32, user32, gdi32, advapi32, comctl32, comdlg32, shell32, msvcrt, ntdll, opengl32, glu32, ddraw, dsound, ole32, oleaut32, winmm, imm32, uxtheme, winspool, ws2_32, version, psapi, shlwapi, iphlpapi, msacm32, secur32, setupapi, netapi32, mpr, msimg32, et plus
- **Couche de compatibilité Win16** — KERNEL, USER, GDI, SHELL, COMMDLG, COMMCTRL, MMSYSTEM, KEYBOARD, DDEML, LZEXPAND, SOUND, VER, SCONFIG, WIN87EM
- **Couche de compatibilité WinCE** — COREDLL (kernel32/user32/gdi32 combinés pour les binaires ARM Windows CE)
- **Émulation des interruptions DOS** — INT 21h fichiers/processus, INT 10h BIOS vidéo, INT 08h/1Ch timer, INT 09h/16h clavier, INT 1Ah horloge temps réel, INT 15h services système, INT 33h souris, INT 2Fh multiplex, EMS (INT 67h) et XMS mémoire étendue ; support DPMI/PMODE/W pour les extensions DOS en mode protégé
- **Émulation VGA** — 14 modes vidéo (texte, CGA, EGA, VGA, Mode 13h, Mode X), émulation complète des registres CRTC/Sequencer/GC/ATC, palette 256 couleurs, mémoire planaire
- **Audio Sound Blaster / OPL2 / GUS** — DSP Sound Blaster 2.0 avec lecture DMA 8 bits, synthèse FM OPL2 (YM3812) 9 canaux, émulation Gravis Ultrasound (GUS), onde carrée PC Speaker, contrôleur DMA Intel 8237A, sortie temps réel AudioWorklet
- **Traduction OpenGL 1.x → WebGL2** — Pipeline complet en mode immédiat mappé vers WebGL2, pour les écrans de veille 3D
- **DirectDraw / DirectSound** — Gestion COM de surfaces et de tampons audio pour les jeux Windows de l'ère DOS
- **Gestionnaire de fenêtres** — Fenêtres multiples, ordre Z, focus, MDI (Multiple Document Interface), barre des tâches, dispatch des messages, dialogues communs
- **Moteur de rendu GDI** — Bitmaps, brosses, stylos, régions, texte, mapping DIB vers Canvas
- **Système de fichiers virtuel** — Stockage persistant basé sur IndexedDB

## Pour commencer

```bash
npm install
npm run dev
```

Ouvrez `http://localhost:5173` et glissez un fichier `.exe` sur la page, ou choisissez-en un depuis le lanceur d'exemples intégré.

## Build

```bash
npm run build     # Build de production → dist/
```

## Contribuer

Les PR sont les bienvenues ! L'objectif principal est de faire fonctionner correctement davantage d'exécutables, ce qui implique généralement d'implémenter les stubs d'API Win32/Win16 manquants, de corriger les problèmes de rendu et d'améliorer la fidélité GDI. Consultez `CLAUDE.md` pour le workflow étape par étape.

Nous recommandons fortement de contribuer avec [Claude Code](https://claude.ai/code) ou des outils de code assisté par IA similaires. Le projet inclut un `CLAUDE.md` détaillé que Claude Code charge automatiquement, facilitant la navigation dans les composants internes x86 et les API Win32. Bien entendu, le code écrit à la main est également le bienvenu.

## Licence

Ce projet est publié sous [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). Le code initial a été entièrement généré par IA. Vous êtes libre d'utiliser, modifier et distribuer ce projet à toute fin sans attribution. Les dépendances tierces conservent leurs propres licences (MIT).

## Avertissement

Comme QEMU, DOSBox, Wine et d'autres émulateurs, RetroTick implémente des interfaces publiques documentées (jeu d'instructions x86, API Win32, formats de fichiers PE/NE/MZ) et ne contient pas de code dérivé d'une implémentation propriétaire. Pendant le développement, des outils de code IA ont été utilisés et ont pu inspecter les octets des exécutables de test pour diagnostiquer des problèmes de compatibilité, comme un développeur utilisant un débogueur ou un éditeur hexadécimal. Une telle analyse ne révèle que les API publiques et les instructions x86 utilisées par un programme, pas sa logique propriétaire.

Les programmes d'exemple présentés par ce projet sont des utilitaires et jeux Windows classiques des années 1990, largement disponibles sur Internet depuis des décennies. Ils sont inclus uniquement à des fins de démonstration d'interopérabilité. Si vous êtes un ayant droit et souhaitez le retrait d'un programme, veuillez ouvrir une issue.

Tous les noms de produits, marques commerciales et marques déposées mentionnés dans ce projet sont la propriété de leurs détenteurs respectifs. Ce projet n'est affilié à, approuvé par, ni sponsorisé par aucun détenteur de marque.

</div>

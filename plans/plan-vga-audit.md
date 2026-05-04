# Plan: Audit et améliorations VGA

## Contexte

Audit complet de l'implémentation VGA (`src/lib/emu/dos/vga.ts`, 864 lignes + `video.ts` pour INT 10h). L'émulation couvre les ports 0x3C0-0x3DA, les registres CRTC/Seq/GC/ATC, les modes 0-13h, Mode X, ainsi que la synchronisation VRAM→canvas.

Globalement **solide pour les jeux DOS standard** (Doom, jeux VGA classiques). Plusieurs lacunes impactent les démos scene et quelques optimisations avancées (Mode X tweaks, split-screen, smooth scroll).

Ce plan liste les améliorations ordonnées par ratio impact/coût.

## Ce qui est déjà bien implémenté (ne pas retoucher)

- **0x3DA VRetrace/HBlank** : cache tous les 64 polls, invalidation sur writes CRTC 0x07/0x09/0x12, reset flip-flop ATC (`vga.ts:461-476`).
- **Mode X détection** : bit 3 de Seq[4] via `isUnchained()` + callback `onUnchainedChange` pour rebrancher le hook mémoire planar (`vga.ts:348-388`).
- **Write modes 0/1/2/3 + Read modes 0/1** : complets, y compris latches, bit mask, rotation, set/reset, logical ops (`vga.ts:496-581`).
- **Start Address (CRTC 0x0C/0x0D)** : lu et appliqué dans `syncMode13h` (ligne 658) et `syncModeX` (ligne 704).
- **Word/Byte mode (CRTC 0x17 bit 6)** : appliqué en Mode 13h (ligne 659). *Pas appliqué en Mode X* — voir Bug 4.
- **DAC auto-increment R/G/B, pel mask 0x3C6** : OK.
- **ATC flip-flop** : reset sur lecture 0x3DA, alternance index/data sur 0x3C0 (ligne 359-369).
- **INT 10h AH=10h palette** : très complet (sous-fonctions 00/01/02/03/07/08/09/10/12/13/15/17/1A).

## Bugs et manques identifiés

### Bug 1 — Line Compare (CRTC 0x18) ignoré pour split-screen (HIGH)

**Fichier** : `src/lib/emu/dos/vga.ts:673-728` (`syncModeX`), `645-668` (`syncMode13h`), `787-815` (`syncPlanar16`).

**Symptôme** : Line Compare découpe l'écran en deux zones verticales : au-dessus, scan depuis `displayStart` ; en dessous de la ligne `lineCompare`, scan redémarre à l'offset 0 (utile pour HUD/status bar fixe pendant que la zone de jeu scrolle). Pas implémenté du tout — la valeur de CRTC[0x18] est stockée mais jamais lue par le renderer.

**Spec VGA** :
- `lineCompare[9:0]` = CRTC[0x18] (bits 7:0) | (CRTC[0x07] & 0x10) << 4 | (CRTC[0x09] & 0x40) << 3
- Quand la scanline affichée ≥ lineCompare → offset mémoire redémarre à 0 (comme si `displayStart=0`) pour le reste de la frame.
- Pixel Panning (ATC[0x13]) est forcé à 0 après le split si `atcRegs[0x10]` bit 5 est set, sinon il continue.

**Fix** :

1. Extraire le calcul 10-bit dans un helper `VGAState.getLineCompare()`.
2. Dans `syncMode13h`, `syncModeX`, `syncPlanar16`, couper la boucle Y en deux : Y < split et Y ≥ split. Dans la seconde, remplacer `displayStart` par 0 pour le calcul d'offset.
3. Tester : démo DOS "second_reality" split status bar, jeu "Duke Nukem II" status bar fixe.

**Coût** : ~40 lignes, 3 renderers à modifier.

**Impact** : Débloque nombreuses démos scene 1992-1996 + jeux à HUD fixe en Mode X.

---

### Bug 2 — Mode X width figé à 320 pixels (MEDIUM)

**Fichier** : `src/lib/emu/dos/vga.ts:689` (`const width = 320;`).

**Symptôme** : Les variantes "Mode Q" (256×256), "Mode R" (160×120), Mode X tweaks à 360×270, 400×300, etc. ne s'affichent pas correctement — elles sont rendues comme 320 pixels de large, ce qui décale tous les pixels.

**Spec VGA** :
- Largeur réelle = `(CRTC[0x01] + 1) × charClock` où charClock dépend de Misc Output bit 2 (25 MHz/28 MHz dot clock) et de Seq[0x01] bit 0 (8/9 dot chars) et bit 3 (dot clock div 2).
- Pour Mode X 320 : CRTC[0x01]=0x4F (79), charClock = 8 pixels/char, dot clock div 2 → 320 pixels.
- Pour 360 : CRTC[0x01]=0x59 (89) + dot clock 28 MHz → 360.

**Fix** :

1. Ajouter `VGAState.getVisibleWidth()` calculé depuis CRTC[0x01] et Misc Output.
2. Dans `syncModeX` remplacer `const width = 320` par `vga.getVisibleWidth()`.
3. Framebuffer réinit déjà géré par `initFramebuffer(width, height)` — OK si la largeur change.
4. Test harness : écrire un petit test qui programme CRTC[0x01]=0x59 + Misc=0xE7 et vérifie que `getVisibleWidth()` renvoie 360.

**Coût** : ~15 lignes + helper.

**Impact** : Débloque démos avec Mode X tweak (Future Crew, quelques intros).

---

### Bug 3 — Horizontal Pixel Panning (ATC 0x13) non appliqué (MEDIUM)

**Fichier** : `src/lib/emu/dos/vga.ts:185` (stocké à init), rien dans les renderers.

**Symptôme** : Les démos qui utilisent le smooth scroll au pixel près (modifier ATC[0x13] entre 0 et 7 chaque frame pour obtenir un scrolling fluide sans toucher la VRAM) voient un scrolling "par byte" (par 8 pixels).

**Spec VGA** :
- ATC[0x13] bits 3:0 = offset horizontal en pixels à supprimer en début de scanline affichée.
- En Mode 13h/X (bytes 8-bit ou 4-plan entrelacés), le panning est en pixels, pas en bytes → affecte directement l'offset de départ de chaque scanline.

**Fix** :

1. Dans `syncModeX` et `syncMode13h`, lire `pan = vga.atcRegs[0x13] & 0x07` (Mode X) ou `& 0x0F` (Mode 12h/16 couleurs — mode control ATC[0x10] bit 6 altère la granularité).
2. Décaler de `pan` pixels à gauche l'écriture dans `buf32` pour chaque row (les `pan` premiers pixels ne sont pas affichés).
3. Alternativement, compenser via `displayStart` en pixels et rogner les derniers `pan` pixels.

**Coût** : ~20 lignes.

**Impact** : Démos scrollers, certains jeux (Commander Keen 4+ utilise du parallax pixel-perfect en Mode Y).

---

### Bug 4 — Word/Byte mode CRTC 0x17 ignoré en Mode X (LOW)

**Fichier** : `src/lib/emu/dos/vga.ts:704` (`syncModeX`).

**Symptôme** : En mode word (bit 6 clear), l'adresse CRTC est shift left 1 (doublée) avant lecture VRAM. Mode 13h le fait (ligne 659), `syncModeX` non. La plupart des programmes Mode X configurent byte mode (bit 6 set) donc pas bloquant en pratique — mais non-conforme.

**Fix** : Ajouter dans `syncModeX` :
```
const wordMode = !(vga.crtcRegs[0x17] & 0x40);
const startByte = wordMode ? (displayStart << 1) : displayStart;
```
Puis utiliser `startByte` ligne 714 au lieu de `displayStart`.

**Coût** : 3 lignes.

**Impact** : Très faible — normalise le comportement.

---

### Bug 5 — CRTC index masqué à 5 bits (LOW)

**Fichier** : `src/lib/emu/dos/vga.ts:425` (`this.crtcIndex = value & 0x1F;`).

**Symptôme** : Masque à 0x1F (0-31). OK pour VGA standard (registres 0-0x18), mais certains chipsets SVGA et quelques démos écrivent dans 0x20+ pour détection (lecture/écriture qui doit retourner 0 → OK déjà). Pas un vrai bug tant qu'on reste VGA.

**Décision** : Garder `& 0x1F`. Documenter.

---

### Bug 6 — Fallback sync timeout 15 ms génère tearing (LOW)

**Fichier** : `src/lib/emu/emu-exec.ts:1370-1384`.

**Symptôme** : Si un programme ne poll pas 0x3DA (ex: rendering CPU-intensif qui fait confiance au double-buffer), le fallback déclenche un sync chaque 15 ms → ~66 fps, proche mais pas aligné sur 70 Hz → micro-tearing visible.

**Fix** : Ramener le fallback à 14 ms (ou ~1000/70 = 14.28 ms). Mieux : déclencher le sync sur le tick du timer PIT IRQ0 si présent.

**Coût** : 1 ligne si on change 15→14. Plus propre : hook sur `onVerticalRetrace`.

**Impact** : Cosmétique.

---

### Bug 7 — Character Map Select (Seq 0x03) et ATC Mode Control bit 3 ignorés (LOW)

**Fichier** : `src/lib/emu/dos/vga.ts:192` (Seq[3] init), non utilisé pour sélectionner la police en mode texte.

**Symptôme** : Programmes qui chargent une police custom via `INT 10h AH=11h AL=00h` en deux banks A et B + switch via Seq[3] bits 2:0/5:3 voient toujours la même police. En pratique, la majorité des programmes utilisent AL=0x10 (replace ROM font) ce qui écrit directement la font par défaut.

**Fix** : Connecter Seq[3] à la source font dans `renderText()` / `charData` du renderer texte. Nécessite charger les 8 slots de fonts séparément dans `initRegsForMode`.

**Coût** : ~30 lignes + refactor du stockage fonts.

**Impact** : Rare. Surtout programmes utilitaires multi-police.

---

### Bug 8 — Gray-scale summing (INT 10h 10/1B, 12/33) stub (LOW)

**Fichier** : `src/lib/emu/dos/video.ts` (audit : stubs détectés).

**Fix** : Implémenter `gray = (30*R + 59*G + 11*B) / 100` sur les 256 entrées DAC. Simple.

**Coût** : ~15 lignes.

**Impact** : Programmes accessibilité / modes monochrome.

## Ordre d'implémentation recommandé

1. **Bug 1** — Line Compare (HIGH impact, ~40 lignes, débloque le plus de démos).
2. **Bug 3** — Pixel Panning (MEDIUM, ~20 lignes, démos scrollers).
3. **Bug 2** — Mode X width dynamique (MEDIUM, ~15 lignes, Mode X tweaks).
4. **Bug 4** — Word/Byte mode en Mode X (3 lignes, conformité).
5. **Bug 6** — Fallback sync 14 ms (1 ligne, cosmétique).
6. **Bug 8** — Gray-scale summing (15 lignes, complétude INT 10h).
7. **Bug 7** — Character Map Select (rare, faible priorité).
8. **Bug 5** — Aucune action (documenter).

## Fichiers modifiés

- `src/lib/emu/dos/vga.ts` — Bugs 1, 2, 3, 4, 7.
- `src/lib/emu/dos/video.ts` — Bug 8.
- `src/lib/emu/emu-exec.ts` — Bug 6.

## Tests

- Créer `tests/test-vga-line-compare.mjs` : programme minimal qui positionne CRTC[0x18]=100 + écrit deux motifs distincts en VRAM (offsets 0 et 0x1000), vérifier via framebuffer que les rows < 100 montrent motif 1 et rows ≥ 100 montrent motif 2.
- Créer `tests/test-vga-mode-x-tweak.mjs` : programmer CRTC[0x01]=0x59 + Misc=0xE7, vérifier `getVisibleWidth() === 360`.
- Créer `tests/test-vga-pan.mjs` : écrire en VRAM, faire varier ATC[0x13] 0→7, vérifier framebuffer décalé.
- Re-tester démos existantes : Second Reality, Doom, Jazz Jackrabbit.

## Références

- Dosbox-staging : `D:\Perso\SideProjects\dosbox-staging\src\hardware\vga_crtc.cpp`, `vga_draw.cpp` (line compare lignes 50-80), `vga_paradise.cpp` (Mode X tweaks).
- FreeVGA Project : [http://www.osdever.net/FreeVGA/vga/vga.htm](http://www.osdever.net/FreeVGA/vga/vga.htm) — référence canonique pour tous les registres.
- Michael Abrash, *Graphics Programming Black Book* — chapitres 23-31 sur Mode X et tweaks CRTC.

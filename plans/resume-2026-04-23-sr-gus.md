# Resume prompt — SR GUS sample drift, 2026-04-23

## Hand to Claude tomorrow morning

```
Branche DPMI, on continue à chasser le bug "samples GUS de plus en plus mauvais"
sur Second Reality. Session d'hier : 8 commits dont 4 ciblés audio/DMA
(5b6b5dc, cc09c17, 207405e, 2e844d6). Le fix DMA-physical (cc09c17) a
réduit les artefacts mais il en reste.

Lis d'abord `~/.claude/projects/D--Perso-SideProjects-retrotick/memory/project_gus_fidelity.md`
(section "2026-04-22 session") pour le contexte complet et les hypothèses
restantes.

J'ai du tracing runtime dispo dans le commit 2e844d6. Je vais lancer SR
dans le browser avec `emu.dosAudio.gus.traceGus = true` et te coller les logs
de deux moments : le début de la démo (où ça sonne bien) et plus tard
(où ça sonne mal). Compare les patterns et diagnostique.

Si tu veux d'autres traces (voice IRQ, volume ramp, positions en cours),
ajoute-les et redémarre le cycle. Les modifs qui sont de vraies corrections
se committent au fur et à mesure, les autres (expérimentations) restent en
WIP.
```

## Contexte pour Claude (à lire avant)

- **Symptôme** : SR mode GUS, samples corrects au début, progressivement
  mauvais au fil de la démo. SB : rien à signaler. 640 Ko suffisent en
  GUS (samples résident en GUS RAM hardware), 1 Mo nécessaire en SB
  (samples restent en EMS pendant la lecture).

- **Ce qui a été fixé hier** :
  - GUS DMA masking aligné 8237/DOSBox (IsUnmasked callback, dmaPending
    gate, auto-mask sur TC).
  - DMA lit la mémoire physique via `memory.readPhysicalU8` au lieu de
    `readU8` (qui traduit via paging). VDS 0x03/0x05/0x07 traduisent
    virtual→physical via page walk quand paging actif.
  - VDS Lock détecte la fragmentation physique (error AL=02), SG Lock
    émet une vraie table de fragments inline.
  - Runtime tracing : `gus.traceGus = true` → logs voice-start + dma-upload
    avec hash 16 octets, plus `gus.hashRam(addr, len)` et `gus.resetTrace()`.

- **Ce qui reste ouvert** (par ordre de probabilité) :
  1. Dérive d'état dans les registres voice : comparer les `start=` tracés
     début vs fin de démo.
  2. Corruption RAM GUS par uploads ultérieurs : comparer les `hash=` sur
     la même offset avant/après.
  3. IRQ voice mal délivrés (dedupe `_pendingHwInts` masquant des events).
  4. `RenderUpToNow` manquant (10 ms lag).
  5. Préparation sample SR différente SB/GUS (peu probable, pure mémoire).

- **Test headless bloqué** : `tests/test-sr-gus-trace.mjs` stalle à
  `CS:IP=50:507`. Passer par le navigateur.

## Workflow de diagnostic

1. Ouvrir SR avec mode GUS dans le browser (`npm run dev`).
2. DevTools console : `emu.dosAudio.gus.traceGus = true`
3. Laisser la première scène/morceau tourner 10-15 s, copier le log.
4. `emu.dosAudio.gus.resetTrace()` puis attendre plus tard dans la démo
   quand on entend un mauvais sample, laisser tourner 10-15 s, copier
   le log.
5. Comparer : mêmes voices → mêmes `start=` ? Mêmes `dma-upload gus=` →
   mêmes `hash=` ?
6. Passer la comparaison à Claude pour analyse.

## Commits de référence (DPMI branch)

```
2e844d6  Add GUS runtime tracing for sample-drift diagnosis
207405e  Detect fragmentation in VDS Lock and fill SG table in SG Lock
d8b702e  Add PM #PF dispatch plan and headless harnesses
39d899e  Add minimal ROM BIOS signatures at F0000-FFFFF
d4ed908  Activate paging on VCPI entry and CR0/CR3 writes
5e42e63  Apply DS segment base to 32-bit PM memory operands
cc09c17  Bypass MMU paging for DMA reads and VDS translations
5b6b5dc  Align GUS DMA masking with 8237 + DOSBox
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

An unofficial Thai translation patch for the visual novel *Rewrite* (Siglus engine, Steam EN build). It extracts the English scene archive, replaces dialogue lines with Thai translations, preprocesses the Thai text to work around the engine's glyph renderer, and repackages everything alongside a Windows launcher + hook DLL that loads the patched files at runtime.

## Prerequisites

- Docker (for the full build)
- Original `SceneEN.pck` and `GameexeEN.dat` placed in `input/`
- Node.js (for running individual scripts outside Docker)

## Build

Full pipeline (Docker):
```sh
docker build -t rewrite-thai-builder .
docker run --rm -v "$PWD:/work" rewrite-thai-builder
```

Output goes to `output/`: `SceneEN.pck`, `GameexeEN.dat`, `hook.dll`, `launcher.exe`.

Individual Makefile targets (run inside Docker or with the tools installed):
```sh
make extract       # extract input/SceneEN.pck → extracted/original/
make translations  # apply translations/*.patch → extracted/output_patched/
make preprocess    # run charmap substitution on extracted/output_patched/
make archive       # repack latest extracted/output_*/ → output/SceneEN.pck
make patch         # cross-compile hook.dll + launcher.exe → output/
make clean
```

## Architecture

### Pipeline flow

```
input/SceneEN.pck
       │
  siglus-ssu -x          (make extract)
       │
extracted/original/       ← gitignored, canonical source of truth for line numbers
       │
apply-translation-patch.js (make translations)
       │
extracted/output_patched/ ← copy of original with patched lines applied
       │
preprocess.js             (make preprocess)
       │
  siglus-ssu -c          (make archive)
       │
output/SceneEN.pck  +  output/hook.dll  +  output/launcher.exe
```

The Makefile targets `archive` and `preprocess` both pick the most-recently-modified `extracted/output_*/` directory, so `make translations` must run immediately before them (the `output_patched` name preserves this ordering).

### `.ss` script file format

Files use `\r\n` line endings and UTF-8 encoding (sometimes with a BOM). A line is **translatable** if, after trimming, it ends with `"R` and does not start with `;` or `//`. Three variants:

```
# narration (no speaker)
"Line of narration text."R

# dialogue with speaker tag
【SpeakerKey】"\"Quoted dialogue.\""R

# dialogue with voice cue
KOE(voiceId,volume)【SpeakerKey】"\"Quoted dialogue.\""R
```

Speaker tags (`【…】`) are internal keys, not display names; `gameexe.ini` maps each key to its display name via `#NAMAE = "key", "DisplayName", ...` lines.

Text content uses `\"` for a literal quote character and `\\` for a literal backslash. Surrounding double quotes and the trailing `R` are part of the line syntax, not the text. When writing a patch line, `buildPatchLine` in `serve-translations.js` keeps the original line's prefix (voice cue, speaker tag) up to its first `"`, then wraps the new text as `"${escaped}"R`.

Non-text lines are engine commands (`@BGM_PLAY(...)`, `@BG0(...)`, etc.), block structure (`IF(...)`, `{`, `}`), or comments (`;` or `//`). These are never patched.

### Translation patches (`translations/`)

Format: one file per source file (`<filename>.patch`), each line is `<line_number>:<full_replacement_line>`. These patch over `extracted/original/` line-addressed. The patch format is a complete line replacement — no diff context, no hunks.

`gameexe.ini.patch` patches `#NAMAE` entries (speaker display names). `.ss.patch` files patch `.ss` script files (dialogue/narration lines ending with `"R`).

### Thai text preprocessing (`scripts/preprocess.js`)

The Siglus engine rasterizes glyphs one character at a time via `GetGlyphOutlineW`, so multi-character Thai syllable sequences (base consonant + combining vowel/tone marks) won't render. `preprocess.js` replaces these sequences with single precomposed codepoints defined in `scripts/charmaps/charMap*.json`. Priority order on collisions: `charMap3 > charMap2 > charMap`. Replacements are sorted longest-first to prevent shorter prefixes from matching first.

### Windows runtime patch (`patch/`)

- **`launcher.exe`** — launches `SiglusEngine_SteamEN.exe` in a suspended process, injects `hook.dll` via `CreateRemoteThread`+`LoadLibraryW`, then resumes.
- **`hook.dll`** — uses MinHook to intercept four Win32 APIs:
  - `CreateFileW`: redirects `SceneEN.pck` and `GameexeEN.dat` to the patched versions in the DLL's own directory.
  - `SetWindowTextW`: forces the window title to "Rewrite - Thai Patch".
  - `CreateFontIndirectW` / `CreateFontW`: forces the font face to `"RewriteThai"` (the bundled `fonts/RewriteThaiMediumGame.ttf`).
  - `GetGlyphOutlineW`: reserved hook for future per-glyph remapping (currently pass-through).

Cross-compiled with `i686-w64-mingw32-gcc` (32-bit Windows). Config constants (game EXE name, window title, font name, file redirects) live in `patch/src/patch_config.h`.

### Translation review tool

```sh
node scripts/serve-translations.js [port]   # default port 4000
```

Serves a web UI showing all translatable lines from `extracted/original/` alongside their current Thai translation from `translations/*.patch`. Lines without a translation are highlighted so translators can see what remains.

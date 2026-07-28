#!/usr/bin/env node
// Local web server for reviewing translations: lists every translatable
// text line straight from extracted/original/<file>.ss (not just the ones
// that already have a translation), and shows its Thai translation next to
// it when translations/<file>.ss.patch has one. This lets a translator
// browse the full original script and see what's left to do, instead of
// only seeing lines that were already patched.
//
// A line counts as "translatable text" if it ends with the `"R` marker this
// engine's script format uses for dialogue/narration (see isTextLine below).
// Non-.ss patch files (e.g. gameexe.ini.patch) don't follow that convention,
// so they're listed separately and still reviewed patch-line-by-patch-line.
//
// Usage: node scripts/serve-translations.js [port]
// Defaults to port 4000, or PORT env var if set.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const ORIGINAL_DIR = path.join(ROOT, "extracted", "original");
const PATCH_DIR = path.join(ROOT, "translations");
const GAMEEXE_PATH = path.join(ORIGINAL_DIR, "gameexe.ini");
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 4000;

const NAMAE_RE = /^#NAMAE\s*=\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/;

// Reverses the `\"` (and `\\`) backslash-escaping used throughout this
// engine's script/ini text.
function unescapeQuoted(s) {
  return s.replace(/\\(.)/g, "$1");
}

// Speaker tags in .ss lines (e.g. 【吉野＿体験版】) are internal keys, not
// display names. gameexe.ini maps each internal key to the name shown
// in-game via lines like `#NAMAE = "吉野＿体験版", "Yoshino", ...`. Also
// records which gameexe.ini line each key's #NAMAE entry came from, so an
// edited Thai name can be written back to the right patch line.
function loadSpeakerNames() {
  const names = new Map();
  const lines = new Map();
  if (!fs.existsSync(GAMEEXE_PATH)) return { names, lines };
  readLines(GAMEEXE_PATH).forEach((raw, i) => {
    const m = NAMAE_RE.exec(raw);
    if (!m) return;
    const key = unescapeQuoted(m[1]);
    if (names.has(key)) return;
    names.set(key, unescapeQuoted(m[2]));
    lines.set(key, i + 1);
  });
  return { names, lines };
}

const { names: SPEAKER_NAMES, lines: SPEAKER_LINES } = loadSpeakerNames();

// Same idea as loadSpeakerNames, but reads the Thai display name from
// translations/gameexe.ini.patch instead of the English original — only
// keys whose #NAMAE line has actually been translated show up here. Not
// cached at module scope (unlike SPEAKER_NAMES) since the patch file
// changes whenever a speaker name is edited through the UI.
function loadSpeakerNamesTH(lineMap) {
  const map = new Map();
  const patch = loadPatchMap(path.join(PATCH_DIR, "gameexe.ini.patch"));
  for (const [key, lineNumber] of lineMap) {
    const content = patch.get(lineNumber);
    if (!content) continue;
    const m = NAMAE_RE.exec(content);
    if (!m) continue;
    map.set(key, unescapeQuoted(m[2]));
  }
  return map;
}

// Pulls the speaker tag (if any) and the plain dialogue/narration text out of
// a raw .ss text line, e.g.:
//   KOE(300200001,13)【理香子＿体験版】"\"My daughter Kotori hasn't returned home.\""R
// -> { speakerKey: "理香子＿体験版", speaker: "Rikako", speakerTH: "ริกาโกะ",
//      text: "\"My daughter Kotori hasn't returned home.\"" }
// Lines can carry engine commands (@PCM_PLAY(...), TIMEWAIT(...), ...)
// interleaved with multiple quoted segments; those are concatenated in
// order to rebuild the full line of text.
function extractSpeakerAndText(rawLine, speakerNamesTH) {
  const trimmed = rawLine.trim();
  const open = trimmed.indexOf("【");
  const close = open === -1 ? -1 : trimmed.indexOf("】", open + 1);
  const speakerKey = close === -1 ? null : trimmed.slice(open + 1, close);
  const speaker = speakerKey ? (SPEAKER_NAMES.get(speakerKey) ?? speakerKey) : "";
  const speakerTH = speakerKey ? (speakerNamesTH.get(speakerKey) ?? "") : "";

  const quoteRe = /"((?:[^"\\]|\\.)*)"/g;
  let text = "";
  let m;
  while ((m = quoteRe.exec(trimmed))) {
    text += unescapeQuoted(m[1]);
  }
  return { speakerKey, speaker, speakerTH, text: text || trimmed };
}

// Mirrors the "<line>:<content>" format used by apply-translation-patch.js.
function parsePatch(text) {
  const changes = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const entry = line.match(/^(\d+):(.*)$/);
    if (!entry) continue;
    changes.push({ line: Number(entry[1]), after: entry[2] });
  }
  changes.sort((a, b) => a.line - b.line);
  return changes;
}

function loadPatchMap(patchPath) {
  const map = new Map();
  if (!fs.existsSync(patchPath)) return map;
  for (const { line, after } of parsePatch(fs.readFileSync(patchPath, "utf8"))) {
    map.set(line, after);
  }
  return map;
}

// Inverse of parsePatch/loadPatchMap: writes a line -> content map back out
// as "<line>:<content>" rows, sorted for stable diffs. An empty map removes
// the patch file entirely rather than leaving a stray empty one behind.
function writePatchMap(patchPath, map) {
  if (map.size === 0) {
    fs.rmSync(patchPath, { force: true });
    return;
  }
  const body = Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([line, content]) => `${line}:${content}`)
    .join("\n");
  fs.writeFileSync(patchPath, `${body}\n`, "utf8");
}

// Applies the `\"` (and `\\`) backslash-escaping used throughout this
// engine's script/ini text — the inverse of unescapeQuoted.
function escapeQuoted(s) {
  return s.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

// Rebuilds a full .ss script line for the patch file from an edited Thai
// translation: keeps the original line's prefix (voice cue id, speaker tag,
// any leading engine commands) up to its first quote, and wraps the new text
// in the engine's `"..."R` convention with the same backslash-escaping
// extractSpeakerAndText reverses.
function buildPatchLine(originalRawLine, newText) {
  const quoteIndex = originalRawLine.indexOf('"');
  const prefix = quoteIndex === -1 ? "" : originalRawLine.slice(0, quoteIndex);
  const tail = matchTrailingComment(originalRawLine.trim()) ?? "";
  return `${prefix}"${escapeQuoted(newText)}"R${tail}`;
}

// Rebuilds a `#NAMAE = "key", "DisplayName", ...` gameexe.ini line with an
// edited Thai display name, keeping the internal key and trailing fields
// (numeric args after the display name) untouched.
function buildNamaePatchLine(originalRawLine, newDisplayName) {
  const m = /^(#NAMAE\s*=\s*"(?:[^"\\]|\\.)*"\s*,\s*")((?:[^"\\]|\\.)*)(".*)$/.exec(originalRawLine);
  if (!m) throw apiError(400, "Line is not a #NAMAE entry");
  return `${m[1]}${escapeQuoted(newDisplayName)}${m[3]}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readLines(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  return text.split("\r\n");
}

// Some text lines carry a trailing dev comment after the `"R` marker, e.g.:
//   "I bow like the obedient servant of a noble house."R	// Rewrite+ 変更
// Finds the closing `"R` of the line's last quoted segment and returns
// whatever follows it (empty string, or the trailing comment including its
// leading whitespace), or null if the line doesn't end in `"R` at all.
function matchTrailingComment(trimmed) {
  const quoteRe = /"((?:[^"\\]|\\.)*)"/g;
  let lastEnd = -1;
  while (quoteRe.exec(trimmed)) {
    lastEnd = quoteRe.lastIndex;
  }
  if (lastEnd === -1 || trimmed[lastEnd] !== "R") return null;
  const tail = trimmed.slice(lastEnd + 1);
  if (tail === "" || /^\s*(\/\/|;)/.test(tail)) return tail;
  return null;
}

// Dialogue/narration lines in this engine's .ss format end with `"R`,
// optionally followed by a trailing `//` or `;` dev comment. Comment-only
// lines (`;` or `//` at the start) can coincidentally end the same way, so
// they're excluded even though they end with the marker.
function isTextLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(";") || trimmed.startsWith("//")) return false;
  return matchTrailingComment(trimmed) !== null;
}

// Recognizes the token that opens a `SELBTN(...)` / `SELBTN_READY(...)` /
// `SELBTN_CANCEL(...)` call. Looks up the keyword first, then reads
// backwards for an optional `<var>=` prefix, rather than combining both into
// one regex -- keeps things linear instead of stacking an optional group of
// quantifiers in front of an alternation.
const SELBTN_KEYWORD_RE = /(SELBTN_READY|SELBTN_CANCEL|SELBTN)\(/;

function matchAssignedVar(trimmed, beforeIndex) {
  const eq = trimmed.lastIndexOf("=", beforeIndex);
  if (eq === -1) return undefined;
  const varName = trimmed.slice(0, eq).trim();
  return varName || undefined;
}

function matchSelbtnOpen(trimmed) {
  const m = SELBTN_KEYWORD_RE.exec(trimmed);
  if (!m) return null;
  return { keyword: m[1], varName: matchAssignedVar(trimmed, m.index) };
}

// `SELBTN_READY` doesn't assign a variable itself -- that happens later via a
// separate `<var>=SELBTN_START` line once the buttons are actually shown.
function matchSelbtnStart(trimmed) {
  const idx = trimmed.indexOf("SELBTN_START");
  if (idx === -1) return undefined;
  const after = trimmed.slice(idx + "SELBTN_START".length);
  if (/^\w/.test(after)) return undefined; // e.g. a longer identifier, not this token
  return matchAssignedVar(trimmed, idx);
}

// How far past a SELBTN(...) block's closing paren to search for its
// `IF(<var>==n){`/`ELSEIF(<var>==n){` branches. Bounded so that, on the rare
// file where a block's result isn't checked nearby (e.g. a custom event
// widget), we fail to find a jump target rather than latching onto some
// unrelated later reuse of the same variable name.
const CHOICE_JUMP_LOOKAHEAD = 150;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Running net paren delta for a line, ignoring parens inside quoted text (so
// a stray "(" in dialogue can't confuse SELBTN block-boundary tracking).
function unquotedParenDelta(line) {
  let delta = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote && c === "\\") {
      i++;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (c === "(") delta++;
    else if (c === ")") delta--;
  }
  return delta;
}

// Finds the first quoted segment on a line -- a choice's button text, e.g.
// `"Invite Yoshino",` or (with extra trailing args) `"Don't help"@some_flag`
// or (closing its SELBTN call on the same line) `"It's too dangerous")`.
// Returns the span's start (the opening quote) and end (just past the
// closing quote) so callers can preserve everything outside it verbatim,
// or null if the line has no quoted segment at all.
function matchQuotedSpan(line) {
  const start = line.indexOf('"');
  if (start === -1) return null;
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === '"') return { start, end: i + 1 };
    i++;
  }
  return null;
}

// A choice's button-text line always starts with its quoted segment (see
// the samples above); this rules out the block's other lines (a bare `)`,
// a leading numeric/lc0 style arg, ...).
function isChoiceCandidateLine(trimmed) {
  return trimmed.startsWith('"') && matchQuotedSpan(trimmed) !== null;
}

// Scans forward from a SELBTN block's closing paren for its
// `IF(<var>==n){`/`ELSEIF(<var>==n){` branches, returning a Map from choice
// index to the line number of the first translatable line inside that
// branch (the "start message" a jump link should land on).
function findChoiceJumpTargets(lines, afterLine, varName, choiceCount) {
  const targets = new Map();
  const ifRe = new RegExp(String.raw`^(?:IF|ELSEIF)\(${escapeRegExp(varName)}==(\d+)\)\{`);
  const limit = Math.min(lines.length, afterLine + CHOICE_JUMP_LOOKAHEAD);
  for (let k = afterLine; k < limit && targets.size < choiceCount; k++) {
    const m = ifRe.exec(lines[k].trim());
    if (!m || targets.has(Number(m[1]))) continue;
    let t = k + 1;
    while (t < lines.length && !isTextLine(lines[t])) t++;
    if (t < lines.length) targets.set(Number(m[1]), t + 1);
  }
  return targets;
}

// Finds every SELBTN(...)/SELBTN_READY(...)/SELBTN_CANCEL(...) choice block in
// a script file's lines and returns a Map from 1-based line number (of each
// choice's button-text line) to its 0-based position within the block and,
// best-effort, the line number where picking that choice starts playing out.
function findChoiceLines(lines) {
  const result = new Map();

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const open = (trimmed.startsWith(";") || trimmed.startsWith("//")) ? null : matchSelbtnOpen(trimmed);
    if (!open) {
      i++;
      continue;
    }

    let varName = open.varName;
    const isReady = open.keyword === "SELBTN_READY";

    let depth = unquotedParenDelta(trimmed);
    const choiceLines = [];
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      const lineTrimmed = lines[j].trim();
      if (isChoiceCandidateLine(lineTrimmed)) choiceLines.push(j + 1);
      depth += unquotedParenDelta(lineTrimmed);
    }

    if (isReady && choiceLines.length > 0) {
      varName = undefined;
      const limit = Math.min(lines.length, j + CHOICE_JUMP_LOOKAHEAD);
      for (let k = j + 1; k < limit; k++) {
        const started = matchSelbtnStart(lines[k].trim());
        if (started) {
          varName = started;
          break;
        }
      }
    }

    const targets = varName ? findChoiceJumpTargets(lines, j + 1, varName, choiceLines.length) : new Map();
    choiceLines.forEach((lineNum, idx) => {
      result.set(lineNum, { index: idx, jumpToLine: targets.get(idx) });
    });

    i = j + 1;
  }

  return result;
}

// Rebuilds a choice's button-text line for the patch file: preserves
// everything outside the quoted text verbatim (indentation, trailing comma,
// `@directive`, extra args, a same-line closing paren, ...), swapping only
// the quoted text itself.
function buildChoiceLine(originalRawLine, newText) {
  const span = matchQuotedSpan(originalRawLine);
  const prefix = span ? originalRawLine.slice(0, span.start) : originalRawLine;
  const suffix = span ? originalRawLine.slice(span.end) : "";
  return `${prefix}"${escapeQuoted(newText)}"${suffix}`;
}

function listSsFiles() {
  return fs
    .readdirSync(ORIGINAL_DIR)
    .filter((f) => f.endsWith(".ss"))
    .sort();
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Validates a (file, line) pair from an /api/translation request and returns
// the original raw script line it refers to plus whether it's a SELBTN
// choice line (which patches back differently than a `"R` dialogue line), so
// callers don't have to re-derive the same checks loadSsRows already
// performs at render time.
function validateSsLine(file, line) {
  if (typeof file !== "string" || !listSsFiles().includes(file)) {
    throw apiError(400, "Unknown script file");
  }
  if (!Number.isInteger(line) || line < 1) {
    throw apiError(400, "Invalid line number");
  }
  const lines = readLines(path.join(ORIGINAL_DIR, file));
  const raw = lines[line - 1];
  if (raw === undefined) throw apiError(400, "Line is not a translatable text line");
  if (isTextLine(raw)) return { raw, isChoice: false };
  if (findChoiceLines(lines).has(line)) return { raw, isChoice: true };
  throw apiError(400, "Line is not a translatable text line");
}

// Validates a gameexe.ini line number from an /api/speaker-name request and
// returns its original raw #NAMAE line.
function validateNamaeLine(line) {
  if (!Number.isInteger(line) || line < 1) {
    throw apiError(400, "Invalid line number");
  }
  const raw = readLines(GAMEEXE_PATH)[line - 1];
  if (raw === undefined || !NAMAE_RE.test(raw)) {
    throw apiError(400, "Line is not a #NAMAE entry");
  }
  return raw;
}

function loadSsRows(ssFile) {
  const originalPath = path.join(ORIGINAL_DIR, ssFile);
  const lines = readLines(originalPath);
  const patch = loadPatchMap(path.join(PATCH_DIR, `${ssFile}.patch`));
  const speakerNamesTH = loadSpeakerNamesTH(SPEAKER_LINES);
  const choiceLines = findChoiceLines(lines);

  const rows = [];
  lines.forEach((text, i) => {
    const line = i + 1;
    const choice = choiceLines.get(line);
    const isNormalText = isTextLine(text);
    if (!isNormalText && !choice) return;

    const after = patch.get(line) ?? "";
    const translated = patch.has(line);

    if (choice) {
      rows.push({
        line,
        type: "choice",
        choiceIndex: choice.index,
        jumpToLine: choice.jumpToLine,
        speaker: "",
        speakerTH: "",
        speakerNamaeLine: undefined,
        before: extractSpeakerAndText(text, speakerNamesTH).text,
        after: translated ? extractSpeakerAndText(after, speakerNamesTH).text : "",
        translated,
      });
      return;
    }

    const { speakerKey, speaker, speakerTH, text: beforeText } = extractSpeakerAndText(text, speakerNamesTH);
    rows.push({
      line,
      type: "text",
      speaker,
      speakerTH,
      speakerNamaeLine: speakerKey ? SPEAKER_LINES.get(speakerKey) : undefined,
      before: beforeText,
      after: translated ? extractSpeakerAndText(after, speakerNamesTH).text : "",
      translated,
    });
  });
  return rows;
}

// One row per #NAMAE entry in gameexe.ini — the speaker name list, editable
// as translations/gameexe.ini.patch. Every key gets a row regardless of
// translation status, same as loadSsRows does for dialogue lines.
function loadNameRows() {
  const speakerNamesTH = loadSpeakerNamesTH(SPEAKER_LINES);
  const rows = Array.from(SPEAKER_LINES, ([key, line]) => {
    const nameTH = speakerNamesTH.get(key) ?? "";
    return { line, key, nameEN: SPEAKER_NAMES.get(key), nameTH, translated: nameTH !== "" };
  });
  rows.sort((a, b) => a.line - b.line);
  return rows;
}

// Also escapes quotes so this is safe to drop into an HTML attribute, not
// just text content (used for the editable cells' data-raw attribute).
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: #0b5fa5; }
  ul { padding-left: 1.2rem; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; position: sticky; top: 0; }
  td.line { color: #888; text-align: right; white-space: nowrap; font-family: monospace; }
  td.speaker, td.speaker-th { white-space: nowrap; font-weight: 600; color: #333; }
  td.speaker-th { font-family: "Sarabun", "Noto Sans Thai", system-ui, sans-serif; }
  td.before, td.after { font-family: "Sarabun", "Noto Sans Thai", system-ui, sans-serif; white-space: pre-wrap; word-break: break-word; }
  td.before { color: #444; }
  td.after { color: #0a5c2b; }
  tr.pending td.after { color: #b45309; }
  .placeholder { font-style: italic; }
  tr:nth-child(even) td { background: #f7f7f7; }
  .filter { margin: 1rem 0; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
  .filter input[type="text"] { flex: 1 1 24rem; padding: 0.4rem 0.6rem; font-size: 1rem; }
  .filter label { font-size: 0.9rem; white-space: nowrap; }
  .count { color: #666; font-size: 0.9rem; }
  td.after.editable, td.speaker-th.editable { cursor: pointer; }
  td.after.editable:hover, td.speaker-th.editable:hover { outline: 1px dashed #0b5fa5; outline-offset: -3px; }
  td.after.editing, td.speaker-th.editing { cursor: default; }
  .edit-box { width: 100%; box-sizing: border-box; font: inherit; padding: 0.3rem; resize: vertical; }
  .edit-actions { margin-top: 0.4rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .edit-actions button {
    padding: 0.25rem 0.6rem; font-size: 0.85rem; cursor: pointer; border-radius: 3px; border: 1px solid #ccc;
  }
  .btn-submit { background: #0a5c2b; color: #fff; border-color: #0a5c2b; }
  .btn-cancel { background: #eee; }
  .btn-delete { background: #b3261e; color: #fff; border-color: #b3261e; }
  .btn-delete:disabled, .edit-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .edit-status { font-size: 0.8rem; color: #b45309; }
  tr.choice td { background: #eef4fb; }
  tr.choice:nth-child(even) td { background: #e6eff9; }
  td.choice-badge { color: #0b5fa5; }
  a.jump-link { text-decoration: none; }
  tr:target td { outline: 2px solid #0b5fa5; outline-offset: -2px; }
`;

const FILTER_SCRIPT = `
  const input = document.getElementById("filter");
  const untranslatedOnly = document.getElementById("untranslated-only");
  const rows = Array.from(document.querySelectorAll("tbody tr"));
  function apply() {
    const q = input.value.toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const matchesText = row.textContent.toLowerCase().includes(q);
      const matchesState = !untranslatedOnly.checked || row.classList.contains("pending");
      const match = matchesText && matchesState;
      row.style.display = match ? "" : "none";
      if (match) shown++;
    }
    document.getElementById("count").textContent = shown + " / " + rows.length + " lines";
  }
  input.addEventListener("input", apply);
  untranslatedOnly.addEventListener("change", apply);
`;

// Click-to-edit for the Thai column: turns a td.after.editable cell into a
// textarea with Submit/Cancel/Delete, and calls the /api/translation
// endpoints to write the change straight into translations/<file>.ss.patch.
function editScript(fileName) {
  return String.raw`
  const CURRENT_FILE = ${JSON.stringify(fileName)};

  function renderCell(cell, text, translated) {
    cell.classList.remove("editing");
    cell.dataset.raw = text;
    const row = cell.closest("tr");
    row.classList.toggle("translated", translated);
    row.classList.toggle("pending", !translated);
    cell.textContent = "";
    if (translated) {
      cell.textContent = text;
    } else {
      const span = document.createElement("span");
      span.className = "placeholder";
      span.textContent = "(untranslated)";
      cell.appendChild(span);
    }
  }

  async function callApi(method, line, text) {
    const res = await fetch("/api/translation", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: CURRENT_FILE, line, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || (method + " failed"));
    return data;
  }

  function startEdit(cell) {
    const line = Number(cell.dataset.line);
    const original = cell.dataset.raw || "";
    const wasTranslated = cell.closest("tr").classList.contains("translated");
    cell.classList.add("editing");
    cell.textContent = "";

    const textarea = document.createElement("textarea");
    textarea.className = "edit-box";
    textarea.value = original;
    textarea.rows = Math.max(2, original.split("\n").length);

    const actions = document.createElement("div");
    actions.className = "edit-actions";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn-submit";
    submitBtn.textContent = "Submit";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "Cancel";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = !wasTranslated;

    const status = document.createElement("span");
    status.className = "edit-status";

    actions.append(submitBtn, cancelBtn, deleteBtn, status);
    cell.append(textarea, actions);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    cell.addEventListener("click", (e) => e.stopPropagation());

    cancelBtn.addEventListener("click", () => renderCell(cell, original, wasTranslated));

    submitBtn.addEventListener("click", async () => {
      const text = textarea.value;
      if (!text.trim()) {
        status.textContent = "Text is required (use Delete to clear)";
        return;
      }
      submitBtn.disabled = true;
      status.textContent = "Saving...";
      try {
        const data = await callApi("POST", line, text);
        renderCell(cell, data.text, true);
      } catch (err) {
        status.textContent = err.message;
        submitBtn.disabled = false;
      }
    });

    deleteBtn.addEventListener("click", async () => {
      deleteBtn.disabled = true;
      status.textContent = "Deleting...";
      try {
        await callApi("DELETE", line);
        renderCell(cell, "", false);
      } catch (err) {
        status.textContent = err.message;
        deleteBtn.disabled = false;
      }
    });
  }

  for (const cell of document.querySelectorAll("td.after.editable")) {
    cell.addEventListener("click", () => {
      if (!cell.classList.contains("editing")) startEdit(cell);
    });
  }
`;
}

// Click-to-edit for the Speaker (TH) column: one gameexe.ini #NAMAE line can
// back many dialogue rows sharing the same speaker, so a save/delete here
// updates every td.speaker-th cell with a matching data-line, not just the
// one that was clicked.
const SPEAKER_NAME_SCRIPT = `
  function renderSpeakerThCells(line, text, hasName) {
    for (const cell of document.querySelectorAll('td.speaker-th[data-line="' + line + '"]')) {
      cell.classList.remove("editing");
      cell.dataset.raw = text;
      cell.textContent = "";
      if (hasName) {
        cell.textContent = text;
      } else {
        const span = document.createElement("span");
        span.className = "placeholder";
        span.textContent = "(no Thai name)";
        cell.appendChild(span);
      }
    }
  }

  async function callSpeakerNameApi(method, line, text) {
    const res = await fetch("/api/speaker-name", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || (method + " failed"));
    return data;
  }

  function startSpeakerNameEdit(cell) {
    const line = Number(cell.dataset.line);
    const original = cell.dataset.raw || "";
    cell.classList.add("editing");
    cell.textContent = "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "edit-box";
    input.value = original;

    const actions = document.createElement("div");
    actions.className = "edit-actions";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn-submit";
    submitBtn.textContent = "Submit";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "Cancel";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = !original;

    const status = document.createElement("span");
    status.className = "edit-status";

    actions.append(submitBtn, cancelBtn, deleteBtn, status);
    cell.append(input, actions);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    cell.addEventListener("click", (e) => e.stopPropagation());

    cancelBtn.addEventListener("click", () => renderSpeakerThCells(line, original, Boolean(original)));

    submitBtn.addEventListener("click", async () => {
      const text = input.value;
      if (!text.trim()) {
        status.textContent = "Text is required (use Delete to clear)";
        return;
      }
      submitBtn.disabled = true;
      status.textContent = "Saving...";
      try {
        const data = await callSpeakerNameApi("POST", line, text);
        renderSpeakerThCells(line, data.text, true);
      } catch (err) {
        status.textContent = err.message;
        submitBtn.disabled = false;
      }
    });

    deleteBtn.addEventListener("click", async () => {
      deleteBtn.disabled = true;
      status.textContent = "Deleting...";
      try {
        await callSpeakerNameApi("DELETE", line);
        renderSpeakerThCells(line, "", false);
      } catch (err) {
        status.textContent = err.message;
        deleteBtn.disabled = false;
      }
    });
  }

  for (const cell of document.querySelectorAll("td.speaker-th.editable")) {
    cell.addEventListener("click", () => {
      if (!cell.classList.contains("editing")) startSpeakerNameEdit(cell);
    });
  }
`;

function renderIndex() {
  const ssItems = listSsFiles()
    .map((f) => {
      const rows = loadSsRows(f);
      if (rows.length === 0) return null;
      const translated = rows.filter((r) => r.translated).length;
      return { f, total: rows.length, translated };
    })
    .filter(Boolean)
    .map(
      ({ f, total, translated }) =>
        `<li><a href="/file/${encodeURIComponent(f)}">${escapeHtml(f)}</a> <span class="count">(${translated} / ${total} lines translated)</span></li>`,
    )
    .join("\n");

  const nameRows = loadNameRows();
  const nameTranslated = nameRows.filter((r) => r.translated).length;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Translation review</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Translation review</h1>
<h2>Scripts (extracted/original/*.ss)</h2>
<ul>${ssItems || "<li>No .ss files with translatable text found.</li>"}</ul>
<h2>Speaker names (gameexe.ini)</h2>
<ul><li><a href="/file/gameexe.ini">gameexe.ini</a> <span class="count">(${nameTranslated} / ${nameRows.length} names translated)</span></li></ul>
</body>
</html>`;
}

function renderSpeakerThCell(r, editable) {
  if (!(editable && r.speakerNamaeLine != null)) {
    return `<td class="speaker-th">${escapeHtml(r.speakerTH)}</td>`;
  }
  const content = r.speakerTH ? escapeHtml(r.speakerTH) : '<span class="placeholder">(no Thai name)</span>';
  return `<td class="speaker-th editable" data-line="${r.speakerNamaeLine}" data-raw="${escapeHtml(r.speakerTH)}">${content}</td>`;
}

// Choice rows (SELBTN button text) show a "Choice N" badge instead of a
// speaker name, plus a jump link to the first line of the branch that choice
// leads to, when one could be located (see findChoiceLines).
function renderSpeakerCell(r) {
  if (r.type !== "choice") return `<td class="speaker">${escapeHtml(r.speaker)}</td>`;
  const jump =
    r.jumpToLine != null ? ` <a class="jump-link" href="#line-${r.jumpToLine}" title="Jump to start of this choice">&#8618;</a>` : "";
  return `<td class="speaker choice-badge">Choice ${r.choiceIndex + 1}${jump}</td>`;
}

function renderRow(r, editable) {
  const rowClasses = [r.translated ? "translated" : "pending", r.type === "choice" ? "choice" : ""].filter(Boolean).join(" ");
  return `<tr id="line-${r.line}" class="${rowClasses}">
  <td class="line">${r.line}</td>
  ${renderSpeakerCell(r)}
  ${renderSpeakerThCell(r, editable)}
  <td class="before">${escapeHtml(r.before)}</td>
  <td class="after${editable ? " editable" : ""}"${editable ? ` data-line="${r.line}" data-raw="${escapeHtml(r.after)}"` : ""}>${r.translated ? escapeHtml(r.after) : '<span class="placeholder">(untranslated)</span>'}</td>
</tr>`;
}

function renderFile(name, rows, { editable = false } = {}) {
  const body = rows.map((r) => renderRow(r, editable)).join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)} — translation review</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<p><a href="/">&larr; all files</a></p>
<h1>${escapeHtml(name)}</h1>
<div class="filter">
  <input id="filter" type="text" placeholder="Filter rows...">
  <label><input id="untranslated-only" type="checkbox"> Show untranslated only</label>
  <div class="count" id="count">${rows.length} / ${rows.length} lines</div>
</div>
<table>
<thead><tr><th>Line</th><th>Speaker</th><th>Speaker (TH)</th><th>Original</th><th>Thai</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
<script>${FILTER_SCRIPT}</script>
${editable ? `<script>${editScript(name)}</script><script>${SPEAKER_NAME_SCRIPT}</script>` : ""}
</body>
</html>`;
}

// The speaker name list: one row per #NAMAE entry in gameexe.ini, with an
// editable Thai name backed by translations/gameexe.ini.patch.
function renderNameList(rows) {
  const body = rows
    .map(
      (r) => `<tr class="${r.translated ? "translated" : "pending"}">
  <td class="line">${r.line}</td>
  <td class="speaker">${escapeHtml(r.key)}</td>
  <td class="speaker">${escapeHtml(r.nameEN)}</td>
  <td class="speaker-th editable" data-line="${r.line}" data-raw="${escapeHtml(r.nameTH)}">${r.nameTH ? escapeHtml(r.nameTH) : '<span class="placeholder">(no Thai name)</span>'}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>gameexe.ini — speaker names</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<p><a href="/">&larr; all files</a></p>
<h1>gameexe.ini — speaker names</h1>
<div class="filter">
  <input id="filter" type="text" placeholder="Filter rows...">
  <label><input id="untranslated-only" type="checkbox"> Show untranslated only</label>
  <div class="count" id="count">${rows.length} / ${rows.length} lines</div>
</div>
<table>
<thead><tr><th>Line</th><th>Key</th><th>Name (EN)</th><th>Name (TH)</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
<script>${FILTER_SCRIPT}</script>
<script>${SPEAKER_NAME_SCRIPT}</script>
</body>
</html>`;
}

function serveFile(res, name) {
  if (name.endsWith(".ss")) {
    if (!listSsFiles().includes(name)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Unknown script: ${name}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderFile(name, loadSsRows(name), { editable: true }));
    return;
  }

  if (name === path.basename(GAMEEXE_PATH)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderNameList(loadNameRows()));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Unknown file: ${name}`);
}

// Handles both saving (POST, with a `text` field) and clearing (DELETE) a
// single translation line, writing the result straight into
// translations/<file>.ss.patch.
async function handleTranslationApi(req, res) {
  const body = await readJsonBody(req);
  const { file, line } = body;
  const { raw, isChoice } = validateSsLine(file, line);
  const patchPath = path.join(PATCH_DIR, `${file}.patch`);
  const map = loadPatchMap(patchPath);

  if (req.method === "DELETE") {
    map.delete(line);
    writePatchMap(patchPath, map);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    throw apiError(400, "Text is required");
  }
  const content = isChoice ? buildChoiceLine(raw, body.text) : buildPatchLine(raw, body.text);
  map.set(line, content);
  writePatchMap(patchPath, map);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, text: extractSpeakerAndText(content, new Map()).text }));
}

// Handles both saving (POST, with a `text` field) and clearing (DELETE) a
// speaker's Thai display name, writing the result straight into
// translations/gameexe.ini.patch. One #NAMAE line backs every dialogue row
// for that speaker, so this affects all of them at once.
async function handleSpeakerNameApi(req, res) {
  const body = await readJsonBody(req);
  const { line } = body;
  const raw = validateNamaeLine(line);
  const patchPath = path.join(PATCH_DIR, "gameexe.ini.patch");
  const map = loadPatchMap(patchPath);

  if (req.method === "DELETE") {
    map.delete(line);
    writePatchMap(patchPath, map);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    throw apiError(400, "Text is required");
  }
  const content = buildNamaePatchLine(raw, body.text);
  map.set(line, content);
  writePatchMap(patchPath, map);
  const m = NAMAE_RE.exec(content);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, text: unescapeQuoted(m[2]) }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    const match = /^\/file\/(.+)$/.exec(url.pathname);
    if (match) {
      serveFile(res, decodeURIComponent(match[1]));
      return;
    }

    if (url.pathname === "/api/translation" && (req.method === "POST" || req.method === "DELETE")) {
      await handleTranslationApi(req, res);
      return;
    }

    if (url.pathname === "/api/speaker-name" && (req.method === "POST" || req.method === "DELETE")) {
      await handleSpeakerNameApi(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    const status = err.status || 500;
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } else {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Error: ${err.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Translation review server running at http://localhost:${PORT}`);
});

#!/usr/bin/env node
// Applies translations/<name>.patch files on top of a fresh copy of
// extracted/original to regenerate the translated .ss/.ini files, written into
// a scratch directory (extracted/output_patched) rather than any extraction's
// output_* dir. extracted/ is gitignored and rebuilt by `npm run extract`, so
// this is how a fresh extraction gets translations back without re-running
// any translation tooling.
//
// The scratch dir keeps the "output_" name prefix so preprocess.js and the
// Makefile's archive target, which both pick the most-recently-modified
// extracted/output_* directory, pick this one up automatically as long as
// this script runs right before them (see the Makefile's archive target).
//
// Usage: node scripts/apply-translation-patch.js [targetDir]
// targetDir defaults to extracted/output_patched.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXTRACTED_DIR = path.join(ROOT, "extracted");
const ORIGINAL_DIR = path.join(EXTRACTED_DIR, "original");
const PATCH_DIR = path.join(ROOT, "translations");
const DEFAULT_TARGET_DIR = path.join(EXTRACTED_DIR, "output_patched");

// Mirrors the "<line>:<content>" format written by export-translation-patch.js.
function parsePatch(text) {
  const changes = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const entry = line.match(/^(\d+):(.*)$/);
    if (!entry) continue;
    changes.set(Number(entry[1]), entry[2]);
  }
  return changes;
}

function applyToFile(filename, changes, targetDir) {
  const originalPath = path.join(ORIGINAL_DIR, filename);
  const targetPath = path.join(targetDir, filename);
  const lines = fs.readFileSync(originalPath, "utf8").split("\r\n");

  for (const [lineNumber, content] of changes) {
    const index = lineNumber - 1;
    if (index < 0 || index >= lines.length) {
      console.warn(
        `${filename}: line ${lineNumber} out of range (file has ${lines.length} lines), skipping.`,
      );
      continue;
    }
    lines[index] = content;
  }

  fs.writeFileSync(targetPath, lines.join("\r\n"), "utf8");
}

function main() {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET_DIR;

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(ORIGINAL_DIR, targetDir, { recursive: true });

  const patchFiles = fs.readdirSync(PATCH_DIR).filter((f) => f.endsWith(".patch"));

  for (const patchFile of patchFiles) {
    const filename = patchFile.slice(0, -".patch".length);
    const changes = parsePatch(fs.readFileSync(path.join(PATCH_DIR, patchFile), "utf8"));
    applyToFile(filename, changes, targetDir);
  }

  console.log(`Applied ${patchFiles.length} patch files into ${path.relative(ROOT, targetDir)}`);
}

main();

#!/usr/bin/env node
// Replaces multi-character Thai syllable sequences (base consonant + vowel/tone
// combining marks) in the extracted .ss script files with single precomposed
// codepoints from scripts/charmaps/charMap*.json, so the game's per-character
// glyph renderer (which can't stack combining marks) never sees the raw sequences.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CHARMAP_DIR = path.join(ROOT, "scripts", "charmaps");
// Priority order on word collisions across files: charMap3 > charMap2 > charMap.
const CHARMAP_FILES = ["charMap3.json", "charMap2.json", "charMap.json"];
const EXTRACTED_DIR = path.join(ROOT, "extracted");

function findLatestExtractedDir() {
  const entries = fs
    .readdirSync(EXTRACTED_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("output_"))
    .map((e) => {
      const full = path.join(EXTRACTED_DIR, e.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) {
    throw new Error(
      `No extracted/output_* directory found under ${EXTRACTED_DIR}. Run 'npm run extract' first.`,
    );
  }
  return entries[0].full;
}

const map = [];

function buildWordMap() {
  const files = CHARMAP_FILES.map((name) => path.join(CHARMAP_DIR, name));

  for (const file of files) {
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const { word, unicode, char } of entries) {
      if (char) map.push([word, char]);
      else {
        map.push([word, String.fromCodePoint(unicode)]);
      }
    }
  }

  // Longest words first so a shorter word can't consume characters that
  // belong to a longer word it's a prefix of (e.g. "กิ" inside "กิ่").
  return map;
}

function replaceInFile(filePath, replacements) {
  const original = fs.readFileSync(filePath, "utf8");
  let content = original;
  let count = 0;
  for (const [word, target] of replacements) {
    if (word === "…") continue;
    if (!content.includes(word)) continue;
    //console.log(`Replacing "${word}" with "${target}" in ${filePath}`);
    const parts = content.split(word);
    count += parts.length - 1;
    content = parts.join(target);
  }
  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
  }
  return count;
}

function main() {
  const replacements = buildWordMap();
  const dir = findLatestExtractedDir();
  const files = fs.readdirSync(dir).filter((f) => {
    return f.endsWith(".ss") || f.endsWith(".ini");
  });

  let changedFiles = 0;
  let totalReplacements = 0;
  for (const file of files) {
    const count = replaceInFile(path.join(dir, file), replacements);
    if (count > 0) {
      changedFiles++;
      totalReplacements += count;
    }
  }

  console.log(`Preprocessed ${files.length} .ss files in ${dir}`);
  console.log(
    `Changed ${changedFiles} files, ${totalReplacements} word replacements.`,
  );
}

main();

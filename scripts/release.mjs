#!/usr/bin/env node
// Create a release: set the version, test, build the .mcpb into releases/,
// commit, tag and push.
//
//   npm run release -- patch|minor|major|<x.y.z> [-m "notes"] [--no-push]
//
// Without -m the commit subjects since the last tag are used as notes.
// Result: releases/rocketchat-connector-X.Y.Z.mcpb and releases/rocketchat-connector-latest.mcpb
// (identical content – Git stores the file only once).

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "./build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION_FILES = ["package.json", "manifest.json", "plugin/.claude-plugin/plugin.json", "plugin/server/version.js"];

const sh = (cmd, args, { inherit = false } = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: inherit ? "inherit" : "pipe" })?.trim();
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const path = (p) => join(ROOT, p);

// --- Arguments
const args = process.argv.slice(2);
let bump, notes, push = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-m") notes = args[++i];
  else if (a === "--no-push") push = false;
  else if (!bump && !a.startsWith("-")) bump = a;
  else die(`Unknown argument: ${a}`);
}
if (!bump) die('Usage: npm run release -- patch|minor|major|<x.y.z> [-m "notes"] [--no-push]');

// --- Check repository state
if (sh("git", ["status", "--porcelain"])) die("Working tree not clean – commit or discard first.");
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") die(`Releases only from main (current: ${branch}).`);
sh("git", ["fetch", "--tags", "origin"]);
if (sh("git", ["rev-list", "--count", "HEAD..origin/main"]) !== "0") die("main is behind origin/main – pull first.");

// --- Determine the new version
const pkg = JSON.parse(readFileSync(path("package.json"), "utf8"));
const current = pkg.version;
const [maj, min, pat] = current.split(".").map(Number);
const next =
  bump === "major" ? `${maj + 1}.0.0`
  : bump === "minor" ? `${maj}.${min + 1}.0`
  : bump === "patch" ? `${maj}.${min}.${pat + 1}`
  : /^\d+\.\d+\.\d+$/.test(bump) ? bump
  : die(`Invalid version: ${bump}`);
const tag = `v${next}`;
if (sh("git", ["tag", "-l", tag])) die(`Tag ${tag} already exists.`);

// --- Release notes
if (!notes) {
  const last = sh("git", ["tag", "-l", "v*", "--sort=-v:refname"]).split("\n")[0];
  notes = sh("git", ["log", "--no-merges", "--format=- %s", ...(last ? [`${last}..HEAD`] : [])]) || `- Release ${tag}`;
}

// --- Set the version in all VERSION_FILES
// By replacement, so the compact formatting is kept. Checks for presence, not for a change:
// on the first release the version is already in place.
const setVersion = (file, re) => {
  const text = readFileSync(path(file), "utf8");
  if (!re.test(text)) die(`Version not found in ${file}.`);
  writeFileSync(path(file), text.replace(re, `$1${next}$2`));
};
const jsonVersion = /("version":\s*")[^"]+(")/;
setVersion("package.json", jsonVersion);
setVersion("manifest.json", jsonVersion);
setVersion("plugin/.claude-plugin/plugin.json", jsonVersion);
setVersion("plugin/server/version.js", /(VERSION = ")[^"]+(")/);

// --- Check and build
const file = `releases/rocketchat-connector-${next}.mcpb`;
const latest = "releases/rocketchat-connector-latest.mcpb";
console.log(`→ ${current} → ${next}: tests, manifest validation, build …`);
try {
  sh("npm", ["test"], { inherit: true });
  sh("npm", ["run", "validate"], { inherit: true });
  await buildBundle(path(file));
  copyFileSync(path(file), path(latest));
} catch (err) {
  sh("git", ["checkout", "--", ...VERSION_FILES, ...(sh("git", ["ls-files", latest]) ? [latest] : [])]);
  rmSync(path(file), { force: true });
  die(`Failed – version change reverted. ${err?.message ?? ""}`);
}

// --- Commit, Tag, Push
sh("git", ["add", "--", ...VERSION_FILES, file, latest]);
sh("git", ["commit", "-q", "-m", `Release ${tag}\n\n${notes}`]);
sh("git", ["tag", "-a", tag, "-m", notes]);
console.log(`✓ Built ${file}, created commit and tag ${tag}.\n${notes}`);

// origin is the main repository (git.leipzig.schule); "github" is the public mirror
// that serves the plugin marketplace, pushed too when that remote exists.
const remotes = ["origin", ...(sh("git", ["remote"]).split("\n").includes("github") ? ["github"] : [])];
if (push) {
  for (const remote of remotes) {
    sh("git", ["push", "--atomic", remote, "main", tag], { inherit: true });
    console.log(`✓ Pushed to ${remote}.`);
  }
} else {
  console.log(`Not pushed. Later: ${remotes.map((r) => `git push --atomic ${r} main ${tag}`).join(" && ")}`);
}

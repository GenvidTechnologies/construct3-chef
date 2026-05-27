#!/usr/bin/env node

// Download leaf package dependencies from Azure Blob Storage.
// Reads versions from .packages-version (format: name=version per line).
// Standalone — no npm dependencies, only Node.js built-ins + az CLI.
//
// Works both locally and on CI:
//   - Account name defaults to `burbankbuildwatcher`, override with AZURE_STORAGE_ACCOUNT.
//   - Auth defaults to `login` (uses the `az login` AD identity, no account key needed),
//     override with the first CLI arg, e.g. `node scripts/download-deps.mjs key`.
//
// Requires: az CLI, logged in with data-plane access to the storage account
// (interactive `az login` locally, or a service principal on CI).

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT ?? "burbankbuildwatcher";
const AUTH_MODE = process.argv[2] ?? "login";
const CONTAINER = "cordova";
const DEST_DIR = ".packages";
const VERSION_FILE = ".packages-version";
const CACHED_VERSION_FILE = `${DEST_DIR}/.versions`;

if (!existsSync(VERSION_FILE)) {
  console.error(`ERROR: ${VERSION_FILE} not found`);
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });

const lines = readFileSync(VERSION_FILE, "utf-8").split("\n");
const cachedVersions = loadCachedVersions();

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) continue;

  const name = trimmed.slice(0, eqIndex);
  const version = trimmed.slice(eqIndex + 1);
  const blob = `${name}/tags/${version}/${name}-${version}.tgz`;
  const dest = `${DEST_DIR}/${name}.tgz`;

  const cachedVersion = cachedVersions.get(name);

  if (existsSync(dest) && cachedVersion === version) {
    console.log(`Up to date: ${name}@${version}`);
    continue;
  }

  if (existsSync(dest)) {
    console.log(`Version changed: ${name} (${cachedVersion} -> ${version})`);
    unlinkSync(dest);
  }

  console.log(`Downloading ${blob}...`);
  execSync(
    `az storage blob download -c ${CONTAINER} -n "${blob}" --file "${dest}" --account-name ${STORAGE_ACCOUNT} --auth-mode ${AUTH_MODE} --no-progress`,
    { stdio: "inherit" },
  );
}

// Cache downloaded versions for next run
writeFileSync(CACHED_VERSION_FILE, readFileSync(VERSION_FILE, "utf-8"));

console.log(`Dependencies downloaded to ${DEST_DIR}/`);

function loadCachedVersions() {
  const map = new Map();
  if (!existsSync(CACHED_VERSION_FILE)) return map;

  for (const line of readFileSync(CACHED_VERSION_FILE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    map.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
  }
  return map;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAddons } from "./addonDiscovery.js";
import type { AceEntry } from "./c3Reference.js";

// ── Internal raw shapes ───────────────────────────────────────────────────────

interface RawParam {
  id?: unknown;
  type?: unknown;
}

interface RawAceItem {
  id?: unknown;
  scriptName?: unknown;
  expressionName?: unknown;
  params?: unknown;
}

interface RawCategory {
  conditions?: unknown;
  actions?: unknown;
  expressions?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function mapParam(p: unknown): { name: string; type: string } {
  const raw = isObject(p) ? (p as RawParam) : {};
  return {
    name: String(raw.id ?? ""),
    type: String(raw.type ?? ""),
  };
}

function mapAceItems(items: unknown[], kind: "action" | "condition" | "expression", objectClass: string): AceEntry[] {
  const out: AceEntry[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const raw = item as RawAceItem;
    if (typeof raw.id !== "string") continue;

    // Expressions use expressionName; conditions/actions use scriptName.
    const scriptName =
      kind === "expression"
        ? typeof raw.expressionName === "string"
          ? raw.expressionName
          : undefined
        : typeof raw.scriptName === "string"
          ? raw.scriptName
          : undefined;

    const params = isArray(raw.params) ? raw.params.map(mapParam) : [];

    const entry: AceEntry = {
      source: "addon",
      objectClass,
      kind,
      id: raw.id,
      params,
    };
    if (scriptName !== undefined) {
      entry.scriptName = scriptName;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Map a parsed `aces.json` object into a flat `AceEntry[]` for one addon
 * (`objectClass`). Exported so the per-addon `.c3addon` reader (addonReader.ts)
 * decodes hybrid-sourced aces.json bytes through the same parser the aggregate
 * `buildAddonAceRegistry` uses — keeping ACE parsing single-sourced.
 */
export function mapAcesJsonToEntries(raw: unknown, objectClass: string): AceEntry[] {
  if (!isObject(raw)) return [];
  const out: AceEntry[] = [];

  for (const [key, value] of Object.entries(raw)) {
    // Skip the $schema key (and any other non-category non-object values).
    if (key === "$schema") continue;
    if (!isObject(value)) continue;

    const category = value as RawCategory;

    if (isArray(category.conditions)) {
      out.push(...mapAceItems(category.conditions, "condition", objectClass));
    }
    if (isArray(category.actions)) {
      out.push(...mapAceItems(category.actions, "action", objectClass));
    }
    if (isArray(category.expressions)) {
      out.push(...mapAceItems(category.expressions, "expression", objectClass));
    }
  }

  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read each installed addon's extracted `aces.json` and return a flat
 * `AceEntry[]` across all addons. Addons without an `extractedDir` or without
 * a readable/valid `aces.json` are silently skipped.
 *
 * Order: addon discovery order (addons/plugin before addons/effect, then
 * filesystem order within each dir), then category order, then
 * conditions → actions → expressions within each category.
 */
export function buildAddonAceRegistry(projectRoot: string): AceEntry[] {
  const addons = discoverAddons(projectRoot);
  const out: AceEntry[] = [];

  for (const addon of addons) {
    if (addon.extractedDir === null) continue;

    const acesPath = path.join(addon.extractedDir, "aces.json");
    if (!fs.existsSync(acesPath)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(acesPath, "utf-8"));
    } catch {
      // Malformed JSON — skip this addon entirely.
      continue;
    }

    try {
      out.push(...mapAcesJsonToEntries(parsed, addon.name));
    } catch {
      // Unexpected shape — skip this addon.
      continue;
    }
  }

  return out;
}

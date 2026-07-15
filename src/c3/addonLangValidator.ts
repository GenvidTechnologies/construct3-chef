import type { DiscoveredAddon } from "./addonDiscovery.js";
import { extractPluginProperties } from "./addonPropertyExtractor.js";
import { listAddonEntries, readAddonEntry, readAddonMetadata } from "./addonReader.js";
import type { AddonFinding } from "./addonValidator.js";

// ── Types ────────────────────────────────────────────────────────────────────

type AceKind = "condition" | "action" | "expression";
type CategoryPlural = "conditions" | "actions" | "expressions";
type SectionKey = "plugins" | "effects" | "behaviors";

interface AceItem {
  kind: AceKind;
  aceId: string;
  paramIds: string[];
}

const CATEGORY_PLURAL: Record<AceKind, CategoryPlural> = {
  condition: "conditions",
  action: "actions",
  expression: "expressions",
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Walk a chain of plain-object property accesses, returning `undefined` the
 * moment any intermediate value isn't a (non-array) object. Never throws.
 */
function getNested(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Parse an addon's raw `aces.json` text into a flat list of `{ kind, aceId,
 * paramIds }`, walking every top-level object-class key (skipping
 * `"$schema"`) and each of its `conditions`/`actions`/`expressions` arrays.
 * Unlike `mapAcesJsonToEntries`, this deliberately keeps kind → category-
 * plural (`condition` → `conditions`, …) explicit, since that's exactly the
 * key the lang JSON addresses ACEs by. Any unreadable/malformed/unexpected
 * shape yields `[]`. Never throws.
 */
function parseAceItems(text: string | null): AceItem[] {
  if (text === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

  const items: AceItem[] = [];
  for (const [topKey, topValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (topKey === "$schema") continue;
    if (typeof topValue !== "object" || topValue === null || Array.isArray(topValue)) continue;
    const objectClass = topValue as Record<string, unknown>;

    for (const kind of Object.keys(CATEGORY_PLURAL) as AceKind[]) {
      const arr = objectClass[CATEGORY_PLURAL[kind]];
      if (!Array.isArray(arr)) continue;
      for (const raw of arr) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.id !== "string") continue;

        const paramIds: string[] = [];
        if (Array.isArray(entry.params)) {
          for (const rawParam of entry.params) {
            if (typeof rawParam !== "object" || rawParam === null || Array.isArray(rawParam)) continue;
            const paramId = (rawParam as Record<string, unknown>).id;
            if (typeof paramId === "string") paramIds.push(paramId);
          }
        }

        items.push({ kind, aceId: entry.id, paramIds });
      }
    }
  }
  return items;
}

/**
 * Fallback `pluginKey` resolution when `addon.json`'s `id` is absent: scan
 * each lang file's `text.<sectionKey>` root and, if it has exactly one key,
 * use that key. Ambiguous (0 or 2+ keys) or unparseable lang files are
 * skipped, trying the next. Never throws.
 */
function resolveFallbackPluginKey(
  addon: DiscoveredAddon,
  sectionKey: SectionKey,
  langFiles: string[],
): string | undefined {
  for (const name of langFiles) {
    const text = readAddonEntry(addon, name);
    if (text === null) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    const section = getNested(parsed, ["text", sectionKey]);
    if (typeof section === "object" && section !== null && !Array.isArray(section)) {
      const keys = Object.keys(section as Record<string, unknown>);
      if (keys.length === 1) return keys[0];
    }
  }
  return undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Cross-check a single addon's `aces.json` ACE/param ids and editor-side
 * `plugin.js` property/combo-item ids against every one of its shipped
 * `lang/*.json` locale files, reporting each id that has no corresponding
 * lang string. Inert (returns `[]`) when the addon ships no `lang/*.json`
 * files at all — independent of any caller-side gate.
 *
 * `pluginKey` (the key under `text.plugins`/`text.effects`/`text.behaviors`
 * a lang file addresses this addon's strings by) is resolved from `addon.json`'s `id`,
 * falling back to the sole key under the lang root when `id` is absent; if
 * neither resolves, no findings are produced (nothing to key into). Each
 * locale is checked independently, so a defect in one lang file never masks
 * (or is masked by) another being clean. A malformed/unreadable `aces.json`,
 * `plugin.js`, or individual lang file contributes no findings from that
 * source rather than raising an error. Never throws.
 */
export function checkAddonLang(addon: DiscoveredAddon): AddonFinding[] {
  try {
    const langFiles = listAddonEntries(addon, "lang/").filter((name) => name.endsWith(".json"));
    if (langFiles.length === 0) return [];

    const aceItems = parseAceItems(readAddonEntry(addon, "aces.json"));

    const pluginJsText = readAddonEntry(addon, "plugin.js");
    const properties = pluginJsText !== null ? extractPluginProperties(pluginJsText) : [];

    const sectionKey: SectionKey =
      addon.kind === "plugin" ? "plugins" : addon.kind === "effect" ? "effects" : "behaviors";
    const pluginKey = readAddonMetadata(addon)?.metadata.id ?? resolveFallbackPluginKey(addon, sectionKey, langFiles);
    if (pluginKey === undefined) return [];

    const findings: AddonFinding[] = [];

    for (const langFileName of langFiles) {
      const text = readAddonEntry(addon, langFileName);
      if (text === null) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }

      const langNode = getNested(parsed, ["text", sectionKey, pluginKey]);

      for (const aceItem of aceItems) {
        const categoryPlural = CATEGORY_PLURAL[aceItem.kind];
        const aceLangEntry = getNested(langNode, [categoryPlural, aceItem.aceId]);
        if (aceLangEntry === undefined) {
          findings.push({
            kind: "lang-missing-ace",
            addonId: pluginKey,
            lang: langFileName,
            aceId: aceItem.aceId,
            context: `${sectionKey}.${pluginKey}.${categoryPlural}.${aceItem.aceId}`,
            problem: `${aceItem.kind} '${aceItem.aceId}' has no lang entry`,
          });
          continue;
        }

        for (const paramId of aceItem.paramIds) {
          const nameVal = getNested(aceLangEntry, ["params", paramId, "name"]);
          if (typeof nameVal !== "string") {
            findings.push({
              kind: "lang-missing-param",
              addonId: pluginKey,
              lang: langFileName,
              aceId: aceItem.aceId,
              paramId,
              context: `${sectionKey}.${pluginKey}.${categoryPlural}.${aceItem.aceId}.params.${paramId}`,
              problem: `param '${paramId}' of ${aceItem.kind} '${aceItem.aceId}' has no lang name`,
            });
          }
        }
      }

      for (const prop of properties) {
        const nameVal = getNested(langNode, ["properties", prop.id, "name"]);
        if (typeof nameVal !== "string") {
          findings.push({
            kind: "lang-missing-property",
            addonId: pluginKey,
            lang: langFileName,
            propId: prop.id,
            context: `${sectionKey}.${pluginKey}.properties.${prop.id}`,
            problem: `property '${prop.id}' has no lang name`,
          });
        }

        if (prop.items === undefined) continue;
        for (const itemId of prop.items) {
          const itemVal = getNested(langNode, ["properties", prop.id, "items", itemId]);
          if (typeof itemVal !== "string") {
            findings.push({
              kind: "lang-missing-property",
              addonId: pluginKey,
              lang: langFileName,
              propId: prop.id,
              itemId,
              context: `${sectionKey}.${pluginKey}.properties.${prop.id}.items.${itemId}`,
              problem: `item '${itemId}' of property '${prop.id}' has no lang string`,
            });
          }
        }
      }
    }

    return findings;
  } catch {
    return [];
  }
}

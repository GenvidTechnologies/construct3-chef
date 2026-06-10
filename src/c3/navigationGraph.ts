import { readFileSync } from "node:fs";
import { find_all_files_path, find_all_layouts_path, type Layout } from "@genvid/c3source";
import { type NavConvention, defaultNavConvention } from "./navConvention.js";

/** Map from layoutName -> primary eventSheet name (from layout JSON) */
export function buildLayoutEventSheetMap(layoutsDir: string): Record<string, string> {
  const layoutPaths = find_all_layouts_path(layoutsDir);
  const map: Record<string, string> = {};

  for (const layoutPath of layoutPaths) {
    const content = readFileSync(layoutPath, "utf-8");
    const layout: Layout & { eventSheet?: string } = JSON.parse(content);
    if (layout.name && layout.eventSheet) {
      map[layout.name] = layout.eventSheet;
    }
  }

  return map;
}

/** One navigation call found in a DSL file */
export interface NavEntry {
  fromSheet: string; // event sheet name (from DSL header)
  targetLayout: string; // layout name from GoToLayout call
  lineNumber: number; // 1-indexed line number in DSL file
}

/**
 * Scan all .dsl.txt files under extractedDir for navigation calls.
 *
 * Each line is tested against the regexes in `convention.targetRegexes`; the
 * first regex that matches with a non-empty capture group 1 produces one
 * NavEntry for that line. Lines for which `convention.isDefinitionLine` returns
 * true are skipped entirely. Sheet names are parsed from the `# <name>` header
 * on line 1 and may contain spaces.
 *
 * Defaults to the built-in System go-to-layout / go-to-layout-by-name convention
 * when no second argument is supplied.
 */
export function findGoToLayoutCalls(
  extractedDir: string,
  convention: NavConvention = defaultNavConvention(),
): NavEntry[] {
  const dslFiles = find_all_files_path(extractedDir, (filename) => filename.endsWith(".dsl.txt"));
  const entries: NavEntry[] = [];

  for (const dslFile of dslFiles) {
    const content = readFileSync(dslFile, "utf-8");
    const lines = content.split("\n");

    // Parse the sheet name from the first line: "# Sheet Name (may contain spaces)"
    let fromSheet = "";
    if (lines.length > 0) {
      const headerMatch = /^#\s+(.+?)\s*$/.exec(lines[0]);
      if (headerMatch) {
        fromSheet = headerMatch[1];
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1; // 1-indexed

      if (convention.isDefinitionLine(line)) {
        continue;
      }

      // Try each regex; first match with a non-empty capture group 1 wins
      for (const re of convention.targetRegexes) {
        const match = re.exec(line);
        if (match && match[1] && match[1].length > 0) {
          entries.push({
            fromSheet,
            targetLayout: match[1],
            lineNumber,
          });
          break;
        }
      }
    }
  }

  return entries;
}

/**
 * Render navigation entries as a plain-text table and return the result as a string.
 *
 * Entries are sorted by sheet name then line number (a copy is sorted; the caller's
 * array is not mutated). Returns the single-line string `"(no navigation calls found)"`
 * when the input is empty. Otherwise returns the header line, a separator line, and
 * one row per entry, joined with `"\n"` (no trailing newline).
 */
export function formatNavTable(navEntries: NavEntry[], sheetToLayout: Record<string, string>): string {
  const sorted = [...navEntries].sort((a, b) => {
    const sheetCmp = a.fromSheet.localeCompare(b.fromSheet);
    if (sheetCmp !== 0) return sheetCmp;
    return a.lineNumber - b.lineNumber;
  });

  if (sorted.length === 0) {
    return "(no navigation calls found)";
  }

  const COL_FROM = 25;
  const COL_TO = 30;
  const COL_LINE = 6;
  const header = `${"From EventSheet".padEnd(COL_FROM)} → ${"Target Layout".padEnd(COL_TO)} ${"Line".padStart(COL_LINE)}`;
  const lines: string[] = [header, "─".repeat(header.length + 2)];

  for (const entry of sorted) {
    const fromPadded = entry.fromSheet.padEnd(COL_FROM);
    const toPadded = entry.targetLayout.padEnd(COL_TO);
    const linePadded = String(entry.lineNumber).padStart(COL_LINE);
    let annotation = "";
    const primaryLayout = sheetToLayout[entry.fromSheet];
    if (primaryLayout && primaryLayout !== entry.targetLayout) {
      annotation = `  ← primary sheet of ${primaryLayout}`;
    }
    lines.push(`${fromPadded} → ${toPadded} ${linePadded}${annotation}`);
  }

  return lines.join("\n");
}

/**
 * Build a PlantUML component diagram from navigation entries.
 *
 * Each source event sheet is resolved to its owning layout via `sheetToLayout`.
 * If no owning layout is found the sheet name is used as the source node.
 * Duplicate source→target edges are collapsed to a single directed arrow.
 * Edges are sorted alphabetically (source then target) for stable output.
 */
export function generatePlantUML(
  navEntries: NavEntry[],
  sheetToLayout: Record<string, string>,
  name = "NavigationGraph",
): string {
  const seen = new Set<string>();
  const edges: Array<[string, string]> = [];

  for (const entry of navEntries) {
    const source = sheetToLayout[entry.fromSheet] ?? entry.fromSheet;
    const target = entry.targetLayout;
    const key = `${source}\x00${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([source, target]);
    }
  }

  edges.sort(([a1, b1], [a2, b2]) => {
    const cmp = a1.localeCompare(a2);
    return cmp !== 0 ? cmp : b1.localeCompare(b2);
  });

  const lines: string[] = [`@startuml ${name}`, ""];
  for (const [source, target] of edges) {
    lines.push(`[${source}] --> [${target}]`);
  }
  lines.push("", "@enduml");
  return lines.join("\n");
}

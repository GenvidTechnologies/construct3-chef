import * as fs from "fs";
import * as path from "path";
import type { EventSheet, FunctionParameter } from "@genvid/c3source";
import { extractIncludes, extractFunctions as extractFunctionsUpstream, openProject } from "@genvid/c3source";

export interface IncludeTreeNode {
  /** Sheet name (e.g., "CommonEvents") */
  name: string;
  /** Relative path from project root (e.g., "eventSheets/Common/CommonEvents.json") */
  path: string;
  /** Direct includes from this sheet */
  includes: IncludeTreeNode[];
  /** Functions defined in this sheet (only populated when requested) */
  functions?: string[];
}

/**
 * Build a name → file path map by scanning the eventSheets directory.
 * Sheet names are filenames without extension (e.g., "CommonEvents").
 */
export function buildSheetNameMap(projectDir: string): Map<string, string> {
  const esDir = openProject(projectDir).eventSheetsDir;
  const map = new Map<string, string>();

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".json")) {
        const sheetName = entry.name.replace(/\.json$/, "");
        const relPath = path.relative(projectDir, path.join(dir, entry.name)).replace(/\\/g, "/");
        map.set(sheetName, relPath);
      }
    }
  }

  scan(esDir);
  return map;
}

/** Render a function's signature tail: "(a: number, b: string) -> returnType". */
function formatSignature(params: FunctionParameter[], returnType: string): string {
  const paramStr = (params ?? []).map((p) => `${p.name}: ${p.type}`).join(", ");
  return `(${paramStr}) -> ${returnType || "none"}`;
}

/**
 * Extract function signatures from an eventSheet's events, via c3source's
 * canonical event walk (extractFunctions descends every child-bearing event):
 * function-block → "name(params) -> ret"; custom-ace-block →
 * "ObjectClass.AceName(params) -> ret". c3source 1.1.0's enriched
 * ExtractedFunction supplies params/returnType; rendering stays local.
 */
export function extractFunctions(events: EventSheet["events"]): string[] {
  return extractFunctionsUpstream({ events } as EventSheet).map((fn) => {
    const name = fn.kind === "custom-ace" ? `${fn.objectClass}.${fn.name}` : fn.name;
    return `${name}${formatSignature(fn.params, fn.returnType)}`;
  });
}

/**
 * Resolve the transitive include tree for an eventSheet.
 *
 * @param sheetName - Sheet name (e.g., "GoalsEvents") or relative path (e.g., "eventSheets/Goals/GoalsEvents.json")
 * @param projectDir - Project root directory
 * @param options - Optional: includeFunctions (list functions at each level)
 * @returns Root IncludeTreeNode with resolved transitive includes
 */
export function resolveIncludeTree(
  sheetName: string,
  projectDir: string,
  options?: { includeFunctions?: boolean },
): IncludeTreeNode {
  const nameMap = buildSheetNameMap(projectDir);
  const visited = new Set<string>();

  // Normalize input: accept "eventSheets/Path/Sheet.json" or "Path/Sheet" or "Sheet"
  let rootName = sheetName;
  if (rootName.startsWith("eventSheets/")) {
    rootName = rootName.replace(/^eventSheets\//, "").replace(/\.json$/, "");
    // Extract just the filename part (last segment)
    const parts = rootName.split("/");
    rootName = parts[parts.length - 1];
  } else if (rootName.endsWith(".json")) {
    rootName = rootName.replace(/\.json$/, "");
    const parts = rootName.split("/");
    rootName = parts[parts.length - 1];
  }

  function resolve(name: string): IncludeTreeNode {
    const filePath = nameMap.get(name);
    const node: IncludeTreeNode = {
      name,
      path: filePath ?? `(not found: ${name})`,
      includes: [],
    };

    if (!filePath) return node;
    if (visited.has(name)) {
      // Already visited via another include path — not a real cycle,
      // just deduplication to prevent infinite traversal of diamond includes
      // (e.g., both B and C include Shared). Functions from this sheet are
      // still available; flattenIncludeTree() collects all unique names.
      node.path = `${filePath} (already included)`;
      return node;
    }

    visited.add(name);

    try {
      const fullPath = path.join(projectDir, filePath);
      const sheet: EventSheet = JSON.parse(fs.readFileSync(fullPath, "utf8"));

      if (options?.includeFunctions) {
        node.functions = extractFunctions(sheet.events);
      }

      // extractIncludes walks the whole tree (visitEvents), so includes nested
      // inside groups are discovered too — the prior top-level-only loop missed them.
      for (const ref of extractIncludes(sheet)) {
        node.includes.push(resolve(ref.includeSheet));
      }
    } catch {
      // File read/parse error — return partial node
    }

    return node;
  }

  return resolve(rootName);
}

/**
 * Format an include tree as a human-readable string.
 * Optionally includes function names at each level.
 */
export function formatIncludeTree(node: IncludeTreeNode, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];

  if (indent === 0) {
    lines.push(`# Include Tree: ${node.name}`);
    lines.push(`# Source: ${node.path}`);
    lines.push("");
  }

  const marker = indent === 0 ? "" : `${prefix}├─ `;
  const label = indent === 0 ? node.name : `${marker}${node.name}`;
  lines.push(label);

  if (node.functions && node.functions.length > 0) {
    for (const fn of node.functions) {
      lines.push(`${prefix}  │ fn ${fn}`);
    }
  }

  for (const child of node.includes) {
    lines.push(...formatIncludeTree(child, indent + 1).split("\n"));
  }

  return lines.join("\n");
}

/**
 * Collect all sheet names in the transitive include tree (flattened, deduplicated).
 * Useful for checking which functions are available from a given sheet.
 */
export function flattenIncludeTree(node: IncludeTreeNode): string[] {
  const names = new Set<string>();

  function walk(n: IncludeTreeNode): void {
    if (names.has(n.name)) return;
    names.add(n.name);
    for (const child of n.includes) {
      walk(child);
    }
  }

  walk(node);
  return [...names];
}

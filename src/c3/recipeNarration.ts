import type { Logger } from "@genvidtech/mcp-utils";
import type { PatchScriptOp, RenameSymbolOp, PrimitiveLayoutOp, FileOp } from "./recipeInterpreter.js";

/**
 * Mode-specific rendering of a recipe run (dry-run narration vs. apply narration).
 *
 * Off-barrel deliberately: NOT re-exported from `src/index.ts`, so nothing here
 * becomes public API. Only `recipeApplier.ts` consumes it.
 */

export type RecipeSection = "objectTypes" | "addInstVars" | "layouts" | "files";

export interface RecipeNarration {
  /** Selects the Io helpers' tense ONLY (CREATE vs CREATED), never whether they write. */
  readonly dryRun: boolean;
  /** Step lines. Dry-run: the caller's logger, live. Apply: the overlay journal's logger. */
  readonly log: Logger;
  /** applyLayoutOp's per-op line. Dry-run: silent. Apply: same as `log`. */
  readonly opLog: Logger;
  section(name: RecipeSection): void;
  sectionEnd(): void;
  layout(path: string, ops: PrimitiveLayoutOp[]): void;
  fileCreating(path: string, events: number): void;
  fileCreated(path: string): void;
  fileModifying(path: string, ops: FileOp[]): void;
  fileModified(path: string): void;
}

/** One dry-run line describing a primitive layout op. */
export function describeLayoutOp(op: PrimitiveLayoutOp): string {
  switch (op.op) {
    case "add-nonworld-instance":
      return `    - ${op.op} type=${op.type}`;
    case "add-sublayer":
      return `    - ${op.op} name="${op.name}" parent="${op.parent}"${op.after ? ` after="${op.after}"` : ""}`;
    case "add-layer":
      return `    - ${op.op} name="${op.name}"${op.after ? ` after="${op.after}"` : ""}`;
    case "copy-instance":
      return `    - ${op.op} type=${op.type} from=${op.from} targetLayer="${op.targetLayer}"`;
    case "templatize":
      return `    - ${op.op} type=${op.type} templateName="${op.templateName}"`;
    case "replicify":
      return `    - ${op.op} type=${op.type} sourceTemplateName="${op.sourceTemplateName}"`;
    case "add-replica":
      return `    - ${op.op} sourceTemplateName="${op.sourceTemplateName}" from=${op.from} targetLayer="${op.targetLayer}"`;
    case "remove-instance":
      return `    - ${op.op} type=${op.type}`;
    case "remove-layer": {
      const cascadeSuffix =
        op.cascade === true ? (op.removeInstances === true ? " (cascade + removeInstances)" : " (cascade)") : "";
      return `    - ${op.op} layer="${op.layer}"${cascadeSuffix}`;
    }
    case "move-instance":
      return `    - ${op.op} type=${op.type} targetLayer="${op.targetLayer}"`;
    case "rename-layer":
      return `    - ${op.op} "${op.currentName}" → "${op.newName}"`;
    default: {
      // Matches the exhaustiveness check in applyLayoutOp so a new
      // PrimitiveLayoutOp variant is a compile error here too. Workflow
      // ops never reach this switch — expandWorkflows replaces them
      // with primitive ops before the dry-run loop iterates.
      const exhaustive: never = op;
      throw new Error(`layouts dry-run: unsupported op ${(exhaustive as { op: string }).op}`);
    }
  }
}

/** The dry-run lines (header plus any detail lines) describing one file op. */
export function describeFileOp(op: FileOp): string[] {
  const lines: string[] = [];
  const opPath = "path" in op ? op.path : undefined;
  const opPaths = "paths" in op ? op.paths : undefined;
  const pathStr = opPath ?? (opPaths ? `[${opPaths.length} paths]` : "");
  const indexStr =
    "actionIndex" in op && (op as { actionIndex?: number }).actionIndex !== undefined
      ? ` [actionIndex: ${(op as { actionIndex: number }).actionIndex}]`
      : "";
  lines.push(`    - ${op.op}${pathStr ? ` @ ${pathStr}` : ""}${indexStr}`);
  if (op.op === "patch-script") {
    const patchOp = op as PatchScriptOp;
    if (patchOp.matchScript !== undefined) {
      lines.push(`      matchScript: ${JSON.stringify(patchOp.matchScript)}`);
    }
    lines.push(`      find:    ${JSON.stringify(patchOp.find)}`);
    lines.push(
      `      replace: ${JSON.stringify(Array.isArray(patchOp.replace) ? patchOp.replace.join("\n") : patchOp.replace)}`,
    );
  }
  if (op.op === "rename-symbol") {
    const renameOp = op as RenameSymbolOp;
    for (const r of renameOp.replacements) {
      lines.push(`      ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
    }
  }
  return lines;
}

/** Dry-run narration: present-tense preview lines through the caller's live logger. */
export function dryRunNarration(log: Logger): RecipeNarration {
  return {
    dryRun: true,
    log,
    opLog: () => {},
    section: (name) => log(`${name}:`),
    sectionEnd: () => log(),
    layout: (p, ops) => {
      log(`  MODIFY ${p} (${ops.length} ops)`);
      for (const op of ops) log(describeLayoutOp(op));
    },
    fileCreating: (p, events) => log(`  CREATE ${p} (${events} events)`),
    fileCreated: () => {},
    fileModifying: (p, ops) => {
      log(`  MODIFY ${p} (${ops.length} ops)`);
      for (const op of ops) for (const line of describeFileOp(op)) log(line);
    },
    fileModified: () => {},
  };
}

/** Apply narration: past-tense lines written to the overlay journal's logger. */
export function applyNarration(journal: Logger): RecipeNarration {
  return {
    dryRun: false,
    log: journal,
    opLog: journal,
    section: (name) => journal(`\n${name}:`),
    sectionEnd: () => {},
    layout: () => {},
    fileCreating: () => {},
    fileCreated: (p) => journal(`  CREATED ${p}`),
    fileModifying: () => {},
    fileModified: (p) => journal(`  MODIFIED ${p}`),
  };
}

import path from "node:path";
import { z, type ZodType } from "zod";
import { loadProjectConfig, isMcpError, resolveWithin } from "@genvidtech/mcp-utils";
import { reservedDeviceName, reservedPhrase } from "./pathSegments.js";

export const ChefConfigSchema = z.object({
  extractedDir: z.string().default("extracted"),
  navigation: z
    .object({
      targetPatterns: z.string().array().optional(),
      definitionMarkers: z.string().array().optional(),
    })
    .optional(),
  ops: z
    .object({
      dir: z.string().default("ops"),
      watch: z.boolean().default(true),
    })
    .default({}),
});
export type ChefConfig = z.infer<typeof ChefConfigSchema>;

const CONFIG_FILE = "construct3-chef.config.json";
const DEFAULT_EXTRACTED_DIR = "extracted";

/**
 * Load construct3-chef.config.json from projectRoot. Missing file => defaults.
 * Malformed / invalid / path-escaping config falls back to a safe default
 * (errors-as-values; never throws). `overrides` win over the file. An
 * `extractedDir` with a segment that is a Windows reserved device name (`NUL`,
 * `Con.txt`, `gen/COM1`) falls back to `extracted` with a warning, since the
 * generators would otherwise write to a device (#330).
 */
export async function loadChefConfig(projectRoot: string, overrides?: Partial<ChefConfig>): Promise<ChefConfig> {
  return refuseReservedExtractedDir(await loadChefConfigRaw(projectRoot, overrides));
}

/** The warning for an `extractedDir` whose segment is a reserved device name; the config falls back to `extracted`. */
export function formatExtractedDirReserved(value: string, segment: string, device: string): string {
  return `[chefConfig] extractedDir "${value}" contains ${reservedPhrase({ segment, device })}; falling back to "extracted"`;
}

function refuseReservedExtractedDir(config: ChefConfig): ChefConfig {
  for (const segment of config.extractedDir.split(/[/\\]/)) {
    const device = reservedDeviceName(segment);
    if (device !== undefined) {
      console.warn(formatExtractedDirReserved(config.extractedDir, segment, device));
      return { ...config, extractedDir: DEFAULT_EXTRACTED_DIR };
    }
  }
  return config;
}

async function loadChefConfigRaw(projectRoot: string, overrides?: Partial<ChefConfig>): Promise<ChefConfig> {
  const result = await loadProjectConfig<ChefConfig>(
    projectRoot,
    CONFIG_FILE,
    ChefConfigSchema as ZodType<ChefConfig>,
    overrides,
    { containedPaths: ["extractedDir"], optional: true },
  );
  if (isMcpError(result)) {
    // File-driven error (malformed JSON / schema violation / containment
    // escape) -> safe default. Honor a string override, else fall back to
    // the schema default. Kept branch-local so this never throws.
    const override = overrides?.extractedDir;
    const navOverride = overrides?.navigation;
    const opsOverride = overrides?.ops;
    return {
      extractedDir: typeof override === "string" ? override : DEFAULT_EXTRACTED_DIR,
      ...(navOverride !== undefined ? { navigation: navOverride } : {}),
      ops: opsOverride ?? { dir: "ops", watch: true },
    };
  }
  return result;
}

/**
 * Resolve the absolute path for the ops directory.
 * Enforces containment within projectRoot via resolveWithin.
 * If ops.dir escapes the root, falls back to <root>/ops with a warning.
 */
export async function resolveOpsDir(projectRoot: string): Promise<string> {
  const config = await loadChefConfig(projectRoot);
  const resolved = resolveWithin(projectRoot, config.ops.dir);
  if (resolved === null) {
    console.warn(`[chefConfig] ops.dir "${config.ops.dir}" escapes project root; falling back to <root>/ops`);
    return path.join(projectRoot, "ops");
  }
  return resolved;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_MANIFEST_FILE, readProjectManifestTolerant, serializeProjectManifest } from "@genvidtech/c3source";

/** One `usedAddons` entry's field(s) to overwrite with drift, keyed by addon id. */
export interface AddonDriftSeed {
  id: string;
  version?: string;
  author?: string;
}

/**
 * Copy `sourceFixtureRoot`'s `project.c3proj` + `addons/` tree into `tmpRoot`, then seed
 * `version`/`author` drift into the copy's `usedAddons` entries — structurally, not by
 * text patching.
 *
 * The seeding goes through the SAME read/mutate-in-place/write pair
 * `applyAddonMetadataSync` (`src/c3/addonMetadataSync.ts`) uses on a real sync:
 * `readProjectManifestTolerant` → mutate the parsed object's `usedAddons` entries IN
 * PLACE (never rebuilt via spread, which would reorder keys / drop unmodeled fields) →
 * `serializeProjectManifest`. That means the seeded file differs from
 * `sourceFixtureRoot`'s pristine `project.c3proj` ONLY in the seeded field values — so a
 * sync that successfully restores those fields produces a file byte-identical to the
 * pristine fixture. Tests can assert that equality directly instead of hand-modeling the
 * expected output.
 *
 * ⚠️ Never call this with `sourceFixtureRoot`/`tmpRoot` reversed, and never point
 * `tmpRoot` at a tracked fixture directory — this helper WRITES to `tmpRoot`. Callers own
 * the temp dir's lifecycle (`mkdtempSync` to create it, `rmSync` in a `finally` to clean
 * up).
 */
export function seedManifestDrift(sourceFixtureRoot: string, tmpRoot: string, seeds: AddonDriftSeed[]): void {
  fs.cpSync(path.join(sourceFixtureRoot, PROJECT_MANIFEST_FILE), path.join(tmpRoot, PROJECT_MANIFEST_FILE));

  const sourceAddonsDir = path.join(sourceFixtureRoot, "addons");
  if (fs.existsSync(sourceAddonsDir)) {
    fs.cpSync(sourceAddonsDir, path.join(tmpRoot, "addons"), { recursive: true });
  }

  const manifestPath = path.join(tmpRoot, PROJECT_MANIFEST_FILE);
  const { manifest } = readProjectManifestTolerant(manifestPath);
  const usedAddons = manifest.usedAddons;
  if (!Array.isArray(usedAddons)) {
    throw new Error(`seedManifestDrift: ${sourceFixtureRoot} has no usedAddons array to seed drift into`);
  }

  for (const seed of seeds) {
    const entry = usedAddons.find((e) => e !== null && typeof e === "object" && e.id === seed.id);
    if (entry === undefined) {
      throw new Error(`seedManifestDrift: no usedAddons entry with id '${seed.id}' in ${sourceFixtureRoot}`);
    }
    if (seed.version !== undefined) entry.version = seed.version;
    if (seed.author !== undefined) entry.author = seed.author;
  }

  fs.writeFileSync(manifestPath, serializeProjectManifest(manifest));
}

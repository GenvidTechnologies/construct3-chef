import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scenario builder for #310 (C3's nameless timelines "transitions" container).
 *
 * Each scenario copies the canonical fixture into a fresh temp dir, deletes the copy's
 * `timelines/transitions` and `timelines/Mixing`, rewrites the copy's `project.c3proj`
 * `timelines` block, and creates the on-disk files/dirs the scenario needs. The fixture
 * itself is never written. Callers must call `cleanupScenarios()` (e.g. in `afterEach`).
 */

export type ScenarioName = "F0" | "F1" | "S1" | "S2" | "MI" | "MV_in" | "MV_out" | "NF" | "NFN" | "NU" | "NOC";

export interface Scenario {
  root: string;
  manifestPath: string;
}

interface Folder {
  items: string[];
  subfolders: Folder[];
  name?: string;
}

const FIXTURE = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "construct3-chef-sample");

const folder = (items: string[], subfolders: Folder[] = []): Folder => ({ items, subfolders });

type Setup = (root: string) => Folder;

const tl = (root: string, ...parts: string[]): string => path.join(root, "timelines", ...parts);

/** Copy a real fixture timeline JSON to `timelines/<rel>` so the file is valid. */
function easeAt(root: string, rel: string): void {
  const dest = tl(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, "timelines", "Timeline 1.json"), dest);
}

const emptyDir = (root: string): void => fs.mkdirSync(tl(root, "transitions"), { recursive: true });

const SCENARIOS: Record<ScenarioName, Setup> = {
  F0: () => folder(["Timeline 1"], [folder([])]),
  F1: (r) => {
    emptyDir(r);
    return folder(["Timeline 1"], [folder([])]);
  },
  S1: (r) => {
    easeAt(r, "transitions/Ease.json");
    return folder(["Timeline 1"], [folder([])]);
  },
  S2: (r) => {
    emptyDir(r);
    return folder(["Timeline 1"], [folder(["Ghost"])]);
  },
  MI: () => folder(["Timeline 1"], [folder(["Ghost"])]),
  MV_in: (r) => {
    easeAt(r, "transitions/Ease.json");
    return folder(["Timeline 1", "Ease"], [folder([])]);
  },
  MV_out: (r) => {
    easeAt(r, "Ease.json");
    return folder(["Timeline 1"], [folder(["Ease"])]);
  },
  NF: (r) => {
    emptyDir(r);
    return folder(["Timeline 1"], [folder([], [{ items: [], subfolders: [], name: "Others" }])]);
  },
  NFN: () => folder(["Timeline 1"], [folder([], [{ items: [], subfolders: [], name: "Others" }])]),
  NU: (r) => {
    fs.mkdirSync(tl(r, "transitions", "Others"), { recursive: true });
    return folder(["Timeline 1"], [folder([])]);
  },
  NOC: (r) => {
    easeAt(r, "transitions/Ease.json");
    return folder(["Timeline 1"], []);
  },
};

const created: string[] = [];

/** Build the named scenario in a fresh temp dir (real, non-8.3 path). */
export function buildScenario(name: ScenarioName): Scenario {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "chef-i310-"));
  created.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.rmSync(tl(root, "transitions"), { recursive: true, force: true });
  fs.rmSync(tl(root, "Mixing"), { recursive: true, force: true });
  const manifestPath = path.join(root, "project.c3proj");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.timelines = SCENARIOS[name](root);
  // Tab-indented, no trailing newline, as the C3 editor writes it.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
  return { root, manifestPath };
}

/** Remove every temp dir built since the last call. */
export function cleanupScenarios(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

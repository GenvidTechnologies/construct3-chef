import { readFileSync, existsSync } from "node:fs";

const MIN_SID = 1e14;
const MAX_SID = 1e15;
const MAX_ATTEMPTS = 100;

let _usedSids: Set<number> | null = null;

/**
 * Initialize the SID context from a registry file.
 * Format: `sid TAB source-file TAB location` per line.
 * Ignores blank lines and lines starting with #.
 * Throws if the file does not exist.
 */
export function initSidContext(registryPath: string): void {
    if (!existsSync(registryPath)) {
        throw new Error(
            `SID registry not found at ${registryPath} — run 'npm run generate-c3' first`,
        );
    }
    const content = readFileSync(registryPath, "utf-8");
    const sids = new Set<number>();
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const firstCol = trimmed.split("\t")[0];
        const sid = parseInt(firstCol, 10);
        if (!isNaN(sid)) {
            sids.add(sid);
        }
    }
    _usedSids = sids;
}

/**
 * Initialize the SID context directly from a Set (for tests or when SIDs are
 * already collected in memory).
 */
export function initSidContextFromSet(existingSids: Set<number>): void {
    _usedSids = new Set(existingSids);
}

/**
 * Reset the SID context. After calling this, generateUniqueSid() will throw
 * until the context is re-initialized.
 */
export function resetSidContext(): void {
    _usedSids = null;
}

/**
 * Generate a unique random SID guaranteed to be distinct from all previously
 * seen and generated SIDs.
 *
 * - Returns a value in [1e14, 1e15) — never 0
 * - Adds the value to the internal used-SIDs set before returning
 * - Throws after 100 attempts on collision (should never happen in practice)
 * - Throws if the context has not been initialized
 */
export function generateUniqueSid(): number {
    if (_usedSids === null) {
        throw new Error(
            "SID context not initialized — call initSidContext() or initSidContextFromSet() first",
        );
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const sid = Math.floor(Math.random() * (MAX_SID - MIN_SID)) + MIN_SID;
        if (!_usedSids.has(sid)) {
            _usedSids.add(sid);
            return sid;
        }
    }
    throw new Error(
        `generateUniqueSid: failed to find a unique SID after ${MAX_ATTEMPTS} attempts (collision loop)`,
    );
}

/**
 * Recursively collect all numeric `sid` values from any C3 JSON value.
 * Returns an empty Set for null, undefined, or non-object inputs.
 */
export function collectSids(json: unknown): Set<number> {
    const result = new Set<number>();
    collectSidsInto(json, result);
    return result;
}

function collectSidsInto(value: unknown, result: Set<number>): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const item of value) {
            collectSidsInto(item, result);
        }
    } else if (typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === "sid" && typeof child === "number") {
                result.add(child);
            } else {
                collectSidsInto(child, result);
            }
        }
    }
}

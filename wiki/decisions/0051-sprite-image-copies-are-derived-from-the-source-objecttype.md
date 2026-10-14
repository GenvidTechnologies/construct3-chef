---
type: decision-record
title: "0051. Sprite image copies are derived from the source objectType"
description: >-
  `scaffold-sprite` picked a source's images by a filename glob, and the
  existing-target guard used the same plan, so both over-matched siblings and
  missed single-image and non-PNG forms. The copy set is now derived from the
  source objectType JSON with c3source `deriveExpectedImages`, through one
  function (`planSpriteImageCopies`) shared by the scaffold and its guard; the
  old function stays exported and deprecated
  ([#262](https://github.com/GenvidTechnologies/construct3-chef/issues/262))
tags: [decision, scaffold, images]
status: stable
generated: { by: process:tech-writer, at: 2026-10-14T00:00:00Z }
---

# 0051. Sprite image copies are derived from the source objectType

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issues:** [#262](https://github.com/GenvidTechnologies/construct3-chef/issues/262) (sprite image discovery), [#254](https://github.com/GenvidTechnologies/construct3-chef/issues/254) (the guard that shares the plan)
- **Amends:** ADR [0044](0044-scaffold-tools-refuse-existing-targets.md) (the `image-target` conflict now comes from the derived set). Follows the upstream-ownership posture of ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md).

## Context

The sprite scaffold chose a source's images by a filename glob over `images/`. Since #254 the guard used the same plan to decide `image-target` conflicts. The glob over-matched (a sibling image under a longer name was copied), missed the single-image form (tiled background, 9-patch, tilemap), and missed non-PNG files.

## Decision

Derive the copy set from the source objectType JSON with c3source's `deriveExpectedImages`, the same derivation c3source's `detectImageDrift` uses. Upstream owns the naming fact; chef owns the copy operation. The scaffold plan and the guard share the one function, `planSpriteImageCopies(imagesDir, sourceObjectType, targetName)`, so they cannot disagree.

## Compromise

| Decision | Option | Verdict | One-line reason |
|---|---|---|---|
| API surface | New fn + deprecate | chosen | Add `planSpriteImageCopies`; keep `discoverAndPlanImageCopies` exported, unchanged and `@deprecated`; non-breaking, ships in a minor |
| API surface | Change the signature | rejected | breaking: the function is public through the `src/index.ts` barrel, so the next release would be 3.0.0 |
| Legacy ext | Match by stem | chosen | an image whose node has no `fileType` is the on-disk file whose name minus its extension equals the stem, keeping its real extension; the same stem rule as c3source `detectImageDrift`, though chef matches case-insensitively and takes the first name in sorted order where `detectImageDrift` matches case-sensitively and keeps the last directory entry |
| Legacy ext | Assume .png | rejected | c3source's `C3_LEGACY_IMAGE_EXTENSION` default; a legacy `.jpg` would silently not be copied |

## Consequences

- On-disk names are matched case-insensitively. A missing expected image is skipped, as before.
- A present-but-unmapped `fileType` throws from `deriveExpectedImages`; both the CLI and MCP surfaces report it as an error. c3source maps PNG, JPEG, SVG and WebP. The throw happens only when `images/` exists, because image planning is skipped otherwise. Previously such a frame was silently not copied.
- The source JSON is now parsed before the existing-target check, so a source that doesn't parse errors even when the target also exists. Previously that case was refused as a conflict.
- The non-regular-file check (directory, junction, dangling link) is kept ([ADR 0019](0019-two-walk-primitives-one-classification-rule.md)). It now runs only on entries whose name already matched.
- **ADR 0019's editor-local decline was re-checked, and it holds.** That decline for this discovery said it reopens "if … the discovery widens beyond `.png`", and this change widens it to every mapped extension. The decline still holds because only derived image names can match:
  - a known extension matches the exact name `<stem><ext>`, and the mapped extensions are all image types, so a `.uistate.json` or `tsconfig.json` can never match;
  - the walk is flat, and directories fail the regular-file check, so the `uistate/` and `ts-defs/` directory dimension is unreachable;
  - the one theoretical opening is the stem match for an image with no `fileType`. It could select an editor-local file only for a legacy single-image objectType literally named `tsconfig`, or one whose name contains `.uistate`.

  Such a case is recorded rather than guarded, since `images/` is not project source (ADR 0019).
- `findSpriteScaffoldConflicts` (off-barrel) now takes the source objectType.
- Known limit, out of scope here: the sprite scaffold resolves `--source` only at the flat `objectTypes/<source>.json`, so an objectType kept in a subfolder cannot be a source. That is a separate follow-up.

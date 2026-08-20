# Process & contracts

How the backlog is groomed, and the version-by-version record of what each
upstream leaf-dependency release shipped and what chef did with it.

See the [wiki index](../index.md) for the other sections.

* [Backlog Triage Conventions](issue-triage.md) -
  Backlog-grooming conventions consumed by `/gvt-dev:triage-issues` (types,
  `priority/*` + `area:*` labels, required fields, split/duplicate/dependency
  policy, `gh` mutation recipes); pairs with the `bugTracker` block in
  `.gvt-agent.json`
* [Leaf-dependency ledger](leaf-dependency-ledger.md) -
  Version-by-version record of `@genvidtech/c3source` /
  `@genvidtech/mcp-utils` releases: what each shipped, what chef adopted, and
  the deliberate declines (adoption *posture* stays in CLAUDE.md § "Leaf
  dependencies")

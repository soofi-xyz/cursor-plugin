# Self-contained Elephant ingestion: install, verify, and publish

This is the team-facing evidence template for the bundled `skills/use-oracle/runtime/`
ingestion runtime. It covers every command an operator or reviewer runs to prove a change
is self-contained (no sibling `oracle-node`, `Counties-trasform-scripts`, or
`elephant-query-db` checkout, no portal network access, no credentials) end-to-end through
a real (gated) publish. Copy the relevant sections into a PR description and fill in the
`Record:` lines with actual command output — do not claim a step passed without running it.

All commands below assume the repository root as the working directory and Node.js
**22.18+** (`node -v`). Every path a bundled script resolves comes from that script's own
file location (`import.meta.url` in JS, `BASH_SOURCE[0]` in shell), never the caller's `cwd`
— see [`../scripts/oracle-paths.sh`](../scripts/oracle-paths.sh) for the shared shell helper.

## 1. Install

```bash
(cd skills/use-oracle/runtime && npm ci)
```

Record: npm version, Node version, install exit code, and dependency count. `npm ci` (not
`npm install`) so the lockfile is authoritative and the install fails closed on drift. Use `cd`
here, not `npm ci --prefix`: some npm releases (observed on 11.13.0) mis-derive the expected
lockfile package identity from the `--prefix` directory's basename instead of its
`package.json`, and fail every `ci` with a spurious `Missing: <basename>@<version> from lock
file` error. `npm test --prefix` (used below) is unaffected — it does no lockfile sync check.

## 2. Offline replay (credential-free, network-free)

Runs the full seed → capture/transform → export → dry-run-publish pipeline against a
committed fixture, for every bundled county adapter:

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs replay \
  --county pinellas --fixture skills/use-oracle/runtime/fixtures/pinellas-replay \
  --output "$(mktemp -d)"

node skills/use-oracle/runtime/bin/elephant-county.mjs replay \
  --county duval --fixture skills/use-oracle/runtime/fixtures/duval-replay \
  --output "$(mktemp -d)"
```

Or run the equivalent automated coverage:

```bash
npm test --prefix skills/use-oracle/runtime
```

Record: `replay_complete` event, row counts, and `publishResult.dryRun: true` for each
county, or the full `npm test` pass/fail summary (test file count, test count).

## 3. Bounded live pilot (only after readiness PASS)

Live fetch is rejected unless `--live-fetch` is explicit (fails closed by default). Only run
this after `python3 skills/use-oracle/scripts/validate-county-readiness.py
skills/use-oracle/runtime/docs/<county>-sources.yaml` reports `overall: PASS`, and only for a
small, explicitly bounded set of parcels — never a full county — writing into a `.gitignore`d
scratch directory, never `skills/use-oracle/runtime/downloads/` or any tracked path:

```bash
run_dir="$(mktemp -d)"
node skills/use-oracle/runtime/bin/elephant-county.mjs ingest \
  --county <key> --seed <one-or-two-row.csv> --html-dir "$run_dir/html" \
  --live-fetch --output "$run_dir"
```

Portal fetch during this step must run from an approved execution path with the source
county's expected egress — never assume the operator's laptop is an acceptable BBB/portal
execution environment for production ingestion (`reference/failure-modes.md`).

Record: the exact `--county`, seed row count, `run_dir` (ignored, not committed), the printed
`ingest_complete` manifest, and any portal blocker encountered (do not weaken this gate to
work around a blocker — report it).

## 4. Publish dry-run (credential-free)

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs export \
  --county <key> --seed <seed.csv> --run "$run_dir" --output "$publish_dir"

node skills/use-oracle/runtime/bin/elephant-county.mjs publish \
  --county <key> --input "$publish_dir" --dry-run
```

A dry-run never touches the network. Record the printed `publish_complete` result
(`dryRun: true`, `bucket`, `queryTableIpnsLabel`, `coverageIpnsLabel`) and confirm
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `FILEBASE_API_TOKEN` were **not** set in the
environment for this step.

## 5. Approval-gated publish (human-approved; do not execute during implementation)

A live publish (no `--dry-run`) is rejected unless **both** an approval manifest exists at
the path passed to `--approve` **and** Filebase credentials
(`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `FILEBASE_API_TOKEN`) are present in the
subprocess environment:

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs publish \
  --county <key> --input "$publish_dir" --approve <path-to-signed-approval-manifest.json>
```

**Do not run this command as part of implementing or verifying a change.** Record only the
exact command a human approver would run, the approval manifest's expected shape/location,
and — after a human has actually approved and run it — the resulting
`queryTableCid`/`coverageCid`/`queryTableIpns`/`coverageIpns` plus the remote readback used
to confirm the publish (`getOracleDatasetInfo` via MCP, or a direct fetch of the IPNS URL).

### Coverage-only repair

When a published county's query table is healthy but its coverage pointer is stale or
unreachable, do not run the combined publisher. Use the adapter-independent
`export-coverage` → `sign-coverage-approval` → `publish-coverage` flow in
[`coverage-only-publication.md`](./coverage-only-publication.md). It publishes one immutable
`dataset-coverage.json`, requires a trusted Ed25519 approval bound to its exact digest and
destination, and refuses to create or mutate a query-table object or IPNS label.

## 6. Catalog update

Add or refresh a published county (mandatory coverage URL; permit/places URLs may be
`null`):

```bash
npm run catalog:update --prefix skills/use-oracle/runtime -- \
  --county-key "<key>" --county-name "<Name>" --state-code "<ST>" \
  --county-fips "<fips>" --query-table-url "https://..." \
  --dataset-coverage-url "https://..." --updated-at "<ISO-8601>"
```

Then regenerate the root `mcp.json` env maps from the catalog + overlay:

```bash
npm run catalog:sync-mcp-json --prefix skills/use-oracle/runtime
```

Record: the catalog diff, and confirm a second run of `catalog:sync-mcp-json` produces no
further diff to `mcp.json` (idempotency).

## 7. MCP smoke test

After a publish is live and readback-verified, confirm the `elephant` MCP server serves it:

```bash
bash -c 'exec npx -y --package=github:elephant-xyz/elephant-mcp#main mcp'
```

(stdio server; Ctrl+C to stop — pre-warm once before relying on it in Cursor). Then, via the
`elephant` MCP server (`donphan`, or any MCP-capable client):

- `listPublishedCounties` — confirm the county appears (or, for an overlay-only county like
  `santa-clara`, confirm it is absent from this list but present in the property/permit maps).
- `getOracleDatasetInfo` with `county: "<key>"` — confirm `propertyCount`, a non-null
  `ipnsName`, and export timestamps.
- `queryProperties` — confirm a trivial `SELECT count(*)`-style query returns a plausible
  count for `<key>`.

Record: the three tool outputs (or errors), and cross-check `propertyCount` against the
coverage snapshot's `ingested_count`.

## Clean-room verification gate

Run this from a temporary clone with **no** access to sibling source repositories, the
portal network, or credentials — see `scripts/check-plugin-clean-room.py` for what it
checks and why:

```bash
tmp="$(mktemp -d)"
git clone --no-local . "$tmp/soofi-xyz-team-kit"
(cd "$tmp/soofi-xyz-team-kit/skills/use-oracle/runtime" && npm ci)
npm test --prefix "$tmp/soofi-xyz-team-kit/skills/use-oracle/runtime"
"$tmp/soofi-xyz-team-kit/scripts/validate-plugin.sh"
python3 "$tmp/soofi-xyz-team-kit/scripts/check-plugin-clean-room.py"
```

All five commands must exit `0`. Record the exit codes and the `npm test` summary line
(files/tests passed).

## Fixture size limit

`scripts/check-plugin-clean-room.py` rejects any tracked file under
`skills/use-oracle/runtime/` larger than **512 KiB** (`FIXTURE_SIZE_LIMIT_BYTES`), except
`package-lock.json`. Hand-authored source, transform scripts, and one-parcel replay fixtures
are all well under this; a real captured HTML page, ZIP, or Parquet shard is not — if one
trips this gate, it does not belong in Git. Publish it to Filebase/IPFS and reference the
public URL instead.

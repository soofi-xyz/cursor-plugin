# Coverage-only publication

Use this path to repair or refresh `dataset-coverage.json` without uploading,
overwriting, or re-pointing the county property query table.

The commands are adapter-independent. A published county such as Lee does not
need an entry in `bin/elephant-county.mjs`'s ingest adapter registry.

## Safety contract

- Build coverage only from frozen, reconciled evidence.
- Write the coverage object under an immutable, digest-addressed Filebase key.
- Derive the IPNS label as `oracle-dataset-coverage-<county>`; do not accept an
  override.
- Require the existing IPNS network key and refuse to create a new label.
- Require an Ed25519 signature from a trusted public key. Bind the signature to
  the county, artifact digest, evidence digest, bucket, object key, IPNS label,
  existing network key, approver, and approval time.
- Verify the Filebase bucket is accessible, read the immutable CID back, update
  only the coverage label, and read the IPNS result back before reporting
  success.
- Never pass a query-table path or label to this workflow.

## 1. Prepare frozen evidence

Do not run the export with guessed counts. First freeze the reconciled coverage
evidence and calculate the digest of the reconciliation/provenance manifest:

```bash
PROVENANCE_DIGEST="sha256:$(shasum -a 256 <frozen-reconciliation-manifest.json> | awk '{print $1}')"
```

Create a private, untracked evidence file with this shape. The values below are
a template and are not runnable data:

```jsonc
{
  "schemaVersion": "1.0",
  "county": "lee",
  "frozenAt": "REPLACE_WITH_ISO_8601_UTC_TIMESTAMP",
  "reconciled": true,
  "provenanceDigest": "REPLACE_WITH_sha256_64_HEX_DIGEST",
  "datasets": [
    {
      "county": "lee",
      "source": "appraisal",
      "ingested_count": "REPLACE_WITH_NON_NEGATIVE_INTEGER",
      "expected_count": "REPLACE_WITH_NON_NEGATIVE_INTEGER_OR_NULL",
      "first_loaded_at": "REPLACE_WITH_ISO_8601_UTC_TIMESTAMP_OR_NULL",
      "last_loaded_at": "REPLACE_WITH_ISO_8601_UTC_TIMESTAMP_OR_NULL"
    }
  ]
}
```

Include one row per reconciled source (`appraisal`, `permits`, `sunbiz`, `bbb`,
or another normalized source name). Keep `expected_count` null when no
authoritative denominator exists. Per-source load times may use ISO-8601 UTC or
PostgreSQL UTC (`YYYY-MM-DD HH:MM:SS[.ffffff]+00`) format; the exporter
normalizes both to ISO-8601. The top-level `frozenAt` remains strict ISO-8601.

## 2. Export and dry-run

Use an ignored scratch directory, never the repository:

```bash
publish_dir="$(mktemp -d)"

node skills/use-oracle/runtime/bin/elephant-county.mjs export-coverage \
  --county lee \
  --evidence <private-frozen-evidence.json> \
  --output "$publish_dir"
```

The command writes:

- `dataset-coverage.json`
- `coverage-manifest.json`, including the exact SHA-256 digest and immutable
  Filebase object key.

Set the real coverage bucket and the current Lee coverage IPNS network key, then
dry-run. A dry-run needs no credentials and makes no network calls:

```bash
COVERAGE_BUCKET="<real-lee-coverage-bucket>"
CURRENT_COVERAGE_IPNS="k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd"

node skills/use-oracle/runtime/bin/elephant-county.mjs publish-coverage \
  --county lee \
  --input "$publish_dir" \
  --bucket "$COVERAGE_BUCKET" \
  --expected-ipns-name "$CURRENT_COVERAGE_IPNS" \
  --dry-run
```

Confirm the report names only `oracle-dataset-coverage-lee` and contains no
query-table object or label.

## 3. Human approval

Keep approval keys outside the repository. Generate an Ed25519 key pair once if
the authorized approver does not already have one:

```bash
umask 077
openssl genpkey -algorithm ED25519 -out <private-approval-key.pem>
openssl pkey -in <private-approval-key.pem> -pubout -out <trusted-approval-public-key.pem>
```

Only the human approver runs the signing command:

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs sign-coverage-approval \
  --county lee \
  --input "$publish_dir" \
  --bucket "$COVERAGE_BUCKET" \
  --expected-ipns-name "$CURRENT_COVERAGE_IPNS" \
  --approver "<approver-identity>" \
  --private-key <private-approval-key.pem> \
  --output <signed-approval.json>
```

Do not commit the evidence, private key, signed approval, credentials, or
generated coverage artifacts.

## 4. Live publish

Inject Filebase credentials into a fresh process. The env file remains
untracked:

```dotenv
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

The token is derived from those two values. Run the approved publication:

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs publish-coverage \
  --county lee \
  --input "$publish_dir" \
  --bucket "$COVERAGE_BUCKET" \
  --expected-ipns-name "$CURRENT_COVERAGE_IPNS" \
  --approve <signed-approval.json> \
  --approval-public-key <trusted-approval-public-key.pem> \
  --env-file <private-filebase.env>
```

The command fails before mutation if the signature, artifact digest,
destination, credentials, bucket access, existing IPNS label, or existing
network key does not match. It returns `coverageCid` and `coverageIpns` only
after immutable-CID and IPNS readback succeed.

## 5. Catalog and MCP

Use the returned `coverageIpns` and the coverage artifact's real `exportedAt`.
The angle-bracket values below are placeholders; do not run this template
literally:

```bash
npm run catalog:update --prefix skills/use-oracle/runtime -- \
  --county-key lee --county-name Lee --state-code FL --county-fips 12071 \
  --query-table-url "https://ipfs.filebase.io/ipns/k51qzi5uqu5djd4ohcf3qm87dhlt0e270xw8ejhkyia62edr76uj0u05hrf7m5" \
  --dataset-coverage-url "<coverageIpns returned by publish-coverage>" \
  --updated-at "<real exportedAt from dataset-coverage.json>"

npm run catalog:sync-mcp-json --prefix skills/use-oracle/runtime
```

Run the sync command a second time and confirm it produces no diff. Then run
the runtime/plugin validation and install the local Cursor plugin:

```bash
npm test --prefix skills/use-oracle/runtime
scripts/validate-plugin.sh
python3 scripts/check-plugin-clean-room.py
scripts/local-cursor-plugin.sh install
```

Reload Cursor and verify:

1. `getOracleDatasetInfo { "county": "lee" }` returns coverage datasets and
   timestamps.
2. `getPropertyQuerySchema { "county": "lee" }` still returns 37 columns from
   the unchanged query-table URL.

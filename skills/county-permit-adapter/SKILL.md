---
name: county-permit-adapter
description: "Build a new county's permit-portal harvester as a vendor module for the permit-harvest service, by adapting the Accela template or writing a new vendor module, including source throughput checks and bulk-harvest vs runtime-retrieval decisions. Use when onboarding a county's permit portal, adding a permit vendor module, or debugging per-parcel permit harvest for a county."
metadata: {"author":"elephant-xyz"}
---
# County Permit Adapter

The `PermitHarvest` Restate service (`services/permit-harvest.ts`) exposes
`harvestParcel({county, jobId, parcel_id})` and dispatches to the county's vendor module — a plain
TypeScript module registered with the service. The Accela module is the template:
copy-and-adapt for Accela counties, reimplement navigation for other vendors.
Parameterize by county config (agency code, base URL, parcel-format rules) — **never
hardcode a per-county branch in the dispatch**; that lesson is paid for. The vendor,
base URLs, and jurisdiction list come from the county's sources catalog
(`skills/use-oracle/runtime/docs/<county>-sources.yaml`, from `county-discovery`). Eligibility
flow: a `PermitFeed` workflow (key `<CountyIngest key>-permits` — so a redrive pass feeds
`<county>-<jobId>-r2-permits`), started by `CountyIngest` after appraisal dispatch
completes, scans the eligibility artifacts (`eligible: true`), rebuilds the eligible-list
index (`data/artifacts/permits/<county>/<jobId>/eligible.idx`) atomically on every
PermitFeed pass — the index is stamped with the eligibility-policy fingerprint and never
reused across policy changes — and spawns `PermitFeedChunk` children (keyed
`<PermitFeed key>-c<N>`) that dispatch
`PermitHarvest.harvestParcel` in bounded windows. A malformed `eligibility.json` is
recorded and skipped, never thrown — one bad manifest must not poison the feeder.
`Parcel.process` does NOT send permit invocations directly — one send per
parcel would queue the whole eligible county.

**Jurisdiction routing.** A county spans dozens of municipal jurisdictions and
potentially SEVERAL permit vendors — the sources catalog models exactly this.
`PermitHarvest` loads the county's sources catalog, resolves each parcel's jurisdiction
from stored appraisal/seed data (situs city), groups by vendor, and dispatches to the
matching vendor adapter — multiple adapters per county are normal. An ambiguous or
unmatched jurisdiction is recorded in the parcel's status JSON as `unrouted` (falling
back to the county-level portal only when the catalog defines one), and per-jurisdiction
coverage lives in the status artifacts. The canonical `{county, jobId, parcel_id}`
payload is unchanged.

### Municipal Portal Adapter Patterns

1. **Accela Citizen Access** (`enrich-permits-accela.mjs`):
   - Deep detail endpoint: `CapDetail.aspx?Module=Building&TabName=Building&altId=<PERMIT_NUMBER>`.
   - Parse contractor tables, licensed professionals, trade materials (e.g. `Type of Material:` with multi-word capture `([A-Za-z0-9\s/]+)`), valuation, and inspection dates.
2. **Click2Gov** (`temple-terrace-click2gov.mjs`):
   - State cookie bootstrap (`SelectPermit.jsp`), parse 2-digit application year and permit sequence number (`YY - NNNN`).
   - Extract permit details, fees, and contractor names.
3. **MaintStar** (`plant-city-maintstar.mjs`):
   - JSON search endpoint: `POST api/Public/Record/Search` with `{ recordNumber }`.
   - Direct structured JSON extraction for status, issue dates, contractor license, and valuation.
4. **Tyler EnerGov Civic Access** (`tyler-civic-access.mjs`):
   - Bootstrap the anonymous public tenant in Chromium, verify the configured tenant ID/name,
     and preserve separate portal/API bases for tenant-slug variants.
   - Search Permit module `2` by exact parcel, fetch
     `api/energov/permits/permitdetail` plus
     `api/energov/entity/contacts/search/search`, and retain only
     contractor-role contacts in `contractors[]`.
   - Fail closed when tenant, CaseId, permit number, source URL, parcel evidence, pagination
     totals, or contact-page limits disagree. Keep a contractor name even when license or
     company matching is unavailable; never force an ambiguous company link.

### Distributed Cloud Scraper Architecture (AWS Lambda)

When deep permit enrichment exceeds local single-IP bandwidth (e.g. 500k+ permits across multiple portals taking 40-60+ hours locally), deploy a distributed AWS Lambda harvester (`lambdas/permit-enricher`):

- **Interactive AWS Credential Verification & Setup**:
  Before dispatching cloud scraping workers, verify authentication non-intrusively:
  ```javascript
  import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

  async function verifyAwsCredentials(region = "us-east-1") {
    try {
      const sts = new STSClient({ region });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      return { ok: true, account: identity.Account, arn: identity.Arn, userId: identity.UserId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  ```
  If unauthenticated, guide the operator through setting credentials (`aws configure`, `export AWS_PROFILE=...`, or `.env` variables). If the operator chooses not to configure AWS, fall back to the local warm worker pool.

- **High-Throughput Connection Pooling**:
  ```javascript
  import { NodeHttpHandler } from "@smithy/node-http-handler";
  import http from "node:http";
  import https from "node:https";

  const requestHandler = new NodeHttpHandler({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 300 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 300 }),
    socketAcquisitionWarningTimeout: 10000,
  });
  const lambda = new LambdaClient({ requestHandler });
  ```
- **Starvation-Free FIFO Queue Resolvers**:
  ```javascript
  const queueResolvers = [];
  function acquireSlot() {
    if (activeWorkers < MAX_CONCURRENCY) {
      activeWorkers++;
      return Promise.resolve();
    }
    return new Promise(resolve => queueResolvers.push(resolve));
  }
  function releaseSlot() {
    activeWorkers--;
    const next = queueResolvers.shift();
    if (next) { activeWorkers++; next(); }
  }
  ```
- **Accurate Cost Tracking & Budget Guard**:
  ```javascript
  function calculateLambdaCostUsd(durationMs, memoryMb = 512, architecture = "arm64") {
    const gbSeconds = (durationMs / 1000) * (memoryMb / 1024);
    const gbSecRate = architecture === "arm64" ? 0.0000133334 : 0.0000166667;
    const requestRate = 0.0000002;
    return (gbSeconds * gbSecRate) + requestRate;
  }
  ```
- **Self-Healing Retry Buffer**:
  Maintain in-flight retry queues for 429/500/timeouts; dynamically back off per-portal concurrency and sweep dead-letter records at end-of-stream before declaring completion.

## What a vendor module must provide

1. **Parcel search** — given a parcel id, find that parcel's permit records on the portal.
   Include a `normalizeParcelSearchValue` equivalent: appraisal parcel format usually
   differs from the permit portal's format (punctuation, separators, numeric-only).
2. **Permit list extraction** — record numbers, types, statuses, detail links; write a
   permit-list JSON to the artifact dir.
3. **Detail capture** — per permit: raw HTML + extracted JSON (status, dates, work
   location, description, contractors, inspections, fees, related records). Extract
   everything visible; fields without a lexicon home stay in the payload (see
   `validate-county-transform` class-(c) policy).
4. **Stable keys + resume** — deterministic artifact keys (`safeKeyPart()` for parcel
   ids), `skipExisting`/`skipCompleted` checks, and a per-parcel status JSON
   (`status/<folio>.json` — monitoring counts these against the eligible total). Work
   must be re-runnable without duplication (see `durable-workflow-builder` pattern 3).
   The harvester writes artifacts + `status/<folio>.json` only — it never merges into
   the DB and never signals publish itself; DB merging and publish signaling happen via
   `PermitFeed` → `Loader` (which calls `Publish.requestPublish()` after a permits merge).
5. **DB row mapping** — MAP extracted permits to `@elephant-xyz/query-db` (the npm
   package published from the `elephant-query-db` repo) row CSVs staged under the job
   dir. The actual merge runs via `Loader.load({jobId, tracks:["permits"],
   step:"incremental"})`, submitted per completed chunk by `PermitFeed` — the `Loader`
   is the single writer; never merge inline from the harvester.
   Link permits to the REQUESTED parcel via explicit target
   evidence (`propertyFirstTarget`), never via whatever parcel the detail page happens to
   display — Accela detail pages sometimes show a different parcel, which corrupted early
   Lee loads.
6. **Browser session where required** — some portals block curl entirely (Palm Beach's
   ePZB guest endpoints need a Playwright/Puppeteer session bootstrap first). Session
   setup belongs in the module; keep it reusable across parcels.

Artifact layout: `data/artifacts/permits/<county>/<jobId>/{permit-lists,raw,extracted,status}/…`.

**Date-window backfill (Accela).** Accela list searches cap at ~100 results per query, so
harvest permit LISTS by date window with binary splitting; workers truncate after page 1
when a split is pending. A window is **terminal** when its reported total is **below the
cap** — at ANY span, not only 1-day spans. A split is required only when the total ≥ cap
AND the span is > 1 day; a 1-day window at the cap cannot split further and is terminal
by exhaustion (page through it fully). A window whose reported total is UNAVAILABLE is
treated as at-cap: split it if its span is > 1 day, else paginate it to exhaustion.
Coverage = the union of days covered by terminal
windows. `2×totalDays − initialRoots` is a WORST-CASE upper bound on node count, not an
expected value. The reference county's (Lee) permit history reaches back to 1990-01-01,
so backfills start there. This is portable vendor knowledge for backfill/delta harvests.

## Failure handling

Classify per the `durable-workflow-builder` DEAD vs RETRYABLE taxonomy: a permit-less
parcel or permanently-gone record completes cleanly (recorded as done with zero permits
— never retried); timeouts, 5xx, and nav failures throw ordinary errors and retry with
backoff, pausing at max attempts — the paused invocation, visible in the Restate UI, is
the dead-letter view (fix, then `restate invocations resume`). For a single record
inside an otherwise-good parcel: a PERMANENT failure is recorded as a failure entry in
the parcel's status JSON; a TRANSIENT failure retries inside its `ctx.run` and, if
retries are exhausted, fails the invocation (which pauses) — never silently record a
transient failure as done. Long detail-heavy parcels either need the `PermitHarvest`
service's inactivity/abort timeouts raised (`durable-workflow-builder` rule 3) or the
vendor work split into journaled search → list → detail steps so no single `ctx.run`
exceeds the window.

## Testing before a full run

- Unit-test the module with vitest against captured fixture HTML/JSON from
  `county-discovery` samples; `npm run typecheck` and `npm run test`.
- Local probe: run the module directly (a small script driving Playwright/Puppeteer)
  against a handful of parcels: one known to have permits, a permit-less parcel (must
  complete cleanly, not retry), and one whose detail page shows extra/related records.
- Benchmark before any full harvest: measure permit search, list extraction, detail
  capture, session bootstrap, retry/failure rate, and bytes written for a representative
  sample. Estimate countywide elapsed time from eligible parcel count, expected permits
  per parcel, measured latency, safe concurrency, delays, and retry overhead.
- Smoke test the deployed service: `docker compose up -d`, `npm run dev`,
  `restate deployments register http://host.docker.internal:9080`, then invoke ONE parcel.
  Use a one-way `send`, not `call` — a harvest takes minutes, so a synchronous call times
  out client-side:

```bash
curl localhost:8080/restate/send/PermitHarvest/harvestParcel \
  --json '{"county":"lee","jobId":"smoke-1","parcel_id":"..."}'
```

  Capture the invocation id from the response, watch that invocation in the Web UI
  (`http://localhost:9070`) until it completes, then verify the parcel's status artifact
  (`data/artifacts/permits/<county>/<jobId>/status/<folio>.json`) and the other artifacts
  (`find data/artifacts/permits/<county>/ -type f`). The handler writes artifacts and
  status only — no DB rows exist yet. To check DB rows, run the merge explicitly:

```bash
curl localhost:8080/restate/send/Loader/<county>/load \
  --json '{"jobId":"smoke-1","tracks":["permits"],"step":"incremental"}'
```

  wait for that invocation to complete in the UI, THEN inspect DB rows.

## Throughput rules

- The `PermitHarvest` concurrency cap IS the portal-politeness control. It is NOT tunable
  in the Restate UI (server-side flow control is only a 1.7 preview behind experimental
  flags) — it is an in-process semaphore in the services process, limit from the
  `CONCURRENCY_PERMIT_<VENDOR>` env var (e.g. `CONCURRENCY_PERMIT_ACCELA=2`). To change
  it, edit `.env` and restart the services process — safe mid-run, because in-flight
  invocations resume from their journals (`durable-workflow-builder` pattern 2, the gate
  helper). Start at 2; raise one step at a time while watching error rates and portal
  timeouts in the Web UI. Lee Accela degraded above ~4; assume new portals are equally
  fragile.
- Long multi-week harvests need proxy capacity/rotation configured on the vendor module
  (proxy URL(s) in the module's config) BEFORE raising concurrency — a single datacenter
  IP gets rate-limited or blocked over a long harvest.
- Before scaling beyond the pilot, record the portal's safe concurrency and the estimated
  full permit-download time in the county findings doc. If the estimate is more than
  48 hours, stop and ask whether permits should be downloaded anyway, ingested into the
  query DB, or retrieved at runtime. For runtime retrieval, ask which app/service owns it
  and whether lookup should use direct portal/API calls, server-side scraping, cache,
  queued background fetch, or another pattern.

## Persist your work

Vendor modules and service changes are committed in `skills/use-oracle/runtime` on the county
branch. Anything outside the pipeline project — probe scripts, portal exploration notes,
endpoint/session documentation — gets committed and PR'd to
`github.com/elephant-xyz/Counties-trasform-scripts` under `<county>/` (`gh pr create`)
so it isn't lost when this machine moves on.

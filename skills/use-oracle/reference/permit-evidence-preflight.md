# Permit evidence preflight and decision contract

Apply this contract to every county, permit authority, source system, and historical
period before using permit data for a lead, status, lifecycle, scope, property-link,
longitudinal, company, or license conclusion. Run it after county readiness discovery
and before a permit pilot, targeted repair, investigation, load-derived conclusion, or
publication.

This preflight supplements the county readiness validator; it does not replace it.
Keep county-specific URLs, status mappings, identifier rules, date semantics, coverage
windows, thresholds, and safe throughput in the county/source catalog and permit
profile. Do not encode them in this generic contract.

## Keep status layers separate

Keep durable run states and source-access states from the existing Oracle vocabulary.
For each source record and decision-critical field, assign exactly one field evidence
state:

| Evidence state | Meaning |
|---|---|
| `confirmed_present` | An official, decision-capable source returned a usable value and its immutable capture is retained. |
| `confirmed_empty` | A successful official detail/contact lookup proved that the capable field or section was present but empty. A blank listing column is not enough. |
| `unavailable` | The source or endpoint does not expose the field, is inaccessible, or requires a custodian route. Never convert this state to empty. |
| `stale` | Evidence exists, but its observation time, source fingerprint, or detail fingerprint is outside the profile's accepted freshness contract. |
| `conflicting` | Eligible source observations disagree and the source profile does not establish a defensible precedence rule. |
| `invalid_quarantined` | A value fails source-profile format, chronology, range, or identity checks. Retain the raw value and provenance, but exclude it from decision anchors. This is the machine-safe spelling of “invalid/quarantined.” |
| `unknown` | The field was not observed well enough to classify into another state, including a nonterminal listing row with no filing date or detail. |

Use an existing decision outcome such as `needs_review` when a downstream schema already
provides it. Do not overload `supported`, `blocked`, `source_cap`, or other source/run
states as field evidence states.

## Build the capability and coverage matrix

Create or refresh one matrix row per `(county, jurisdiction, source, historical period)`.
Freeze it with the durable run manifest. Record:

- county, jurisdiction, source key/system, official source role, and observation time;
- catalog/profile digests, adapter key, source fingerprint, and
  `detailFingerprintVersion`;
- source coverage start/end, requested inference window, expected count when known,
  enumeration status, and current/predecessor/archive gaps;
- pagination, caps, stable record keys, list/detail/contact routes, and the official
  adapter used for each route;
- safe rate/concurrency and the profile evidence that established them;
- capabilities for indexed/list status, live detail status, filing/issue/final/
  completion dates, inspections/events, full description/scope, parcel identifier,
  contractor role/name/company/license, and source legal identifiers;
- per-field counts for every evidence state, plus detail candidates, attempted details,
  successful details, and terminal repair failures;
- immutable artifact/manifest locations, content digests, and reconciliation status.

Keep an unknown expected count as `null`, not zero. A supported adapter proves an
executable route; it does not prove field capability, historical completeness, or
successful capture.

## Repeat the preflight

1. Freeze the repository/tree, catalog, profile, adapter, schema, configuration, source,
   and checkpoint signatures in the durable run manifest.
2. Select a bounded, representative sample from stable source record keys. Include old
   and recent records, mapped and unmapped statuses, blank indexed fields, malformed
   identifiers, and records expected to have contractor/detail data. Do not begin a
   broad scrape.
3. Compare list/index evidence with live detail, contact, inspection, and event evidence
   through official adapters. Preserve every observation independently with its capture
   time and digest.
4. Prove the accessible historical start/end, expected inventory or explicit unknown,
   pagination/caps, and every predecessor/archive boundary needed by the requested
   inference.
5. Assign one field evidence state per sampled record and decision-critical field. Open
   or update the structured gap ledger for every non-`confirmed_present` result and for
   any decision that requires a confirmed absence.
6. Plan only decision-critical repairs. Bind the bounded candidate IDs and all input
   digests into an immutable plan before execution.
7. Run the acceptance checks below. Permit ingest may retain unknown/null fields, but no
   derived conclusion or publication may represent unresolved evidence as confirmed.

Re-run this preflight when a source, profile, detail fingerprint, status vocabulary,
historical boundary, or decision window changes.

## Apply decision gates

### Contractor assignment

- Confirm an assignment only from an official permit detail/contact record that names
  the contractor role and retains source evidence.
- Declare an “unassigned” lead only when a successful lookup against a source proven
  capable of contractor detail yields `confirmed_empty`.
- Treat a blank list/index column, listing-only route, failed detail, or source with
  `not-exposed`/`unknown` contractor capability as `unavailable` or `unknown`, then
  create bounded detail/contact repair work.
- Preserve source-name attribution when a historical permit names a contractor or
  qualifier but omits a license or immutable legal ID. Do not promote a likely license
  or entity to permit-proven.

### Current/open status

- Refresh decision-critical status from the live detail source. Preserve indexed status,
  indexed observation time, live status, live observation time, and both artifacts.
- If a newer authoritative detail supersedes an older index under the profile's
  precedence rule, mark the indexed evidence `stale` and use the live value.
- If observations disagree without proven order or precedence, mark the status
  `conflicting` and the open/terminal decision `needs_review`.
- Classify nonterminal rows with missing filing dates or missing details as `unknown`.
  Queue bounded source-specific detail work; do not include or exclude them by guess.

### Lifecycle and decision dates

- Fetch detail, event, and inspection evidence when issue, final inspection, close, or
  completion is decision-critical.
- Never synthesize a missing date from status, list order, permit number, application
  date, neighboring records, or another lifecycle date.
- Validate parsing, calendar validity, source-profile ranges, future dates, and chronology
  before using a date. Apply only chronology rules justified by that source's semantics.
- Mark impossible dates and migration artifacts `invalid_quarantined`. Preserve the raw
  value, field label, source record key, capture time, and digest. Do not use the value
  as an age, status, or work-window anchor.

### Scope and work classification

- Fetch detailed descriptions when flat type, trade, or scope fields cannot distinguish
  accessory work, replacement, repair/coating, or an ambiguous application.
- Require explicit source text for a positive work classification. An application/open
  date alone is not proof that work occurred.
- Keep unresolved or contradictory scope as `needs_review`; do not force it into an
  include/exclude class.
- Put source terms and classification mappings in the county/source profile and test
  them with fixtures.

### Property linkage

- Retain the raw parcel identifier. Apply only the county/source profile's proven,
  lossless normalization and record the normalization version.
- Prove that normalization is one-to-one for the source population and preserves
  meaningful leading zeros, segments, and check characters.
- Mark unsupported or malformed identifiers `invalid_quarantined` with raw evidence.
  Keep ambiguous records valid-unlinked; never choose a property link by guess.

### Longitudinal age or absence inference

- Require reconciled coverage for every applicable current authority, historical period,
  and predecessor/archive source across the full inference window.
- Record coverage start/end, expected count or explicit unknown, captured count,
  reconciliation, and predecessor gaps before treating permit absence as evidence.
- Require valid decision-relevant lifecycle/work dates. Do not use application dates or
  quarantined dates as proof of completed work.
- If any required window is partial, capped, unknown, or blocked, make the age/absence
  conclusion ineligible and report the residual uncertainty.

### Corporate and license attribution

- Apply the permit-to-company/license sequence below. Keep permit attribution,
  licensing-authority identity, and corporate-registry identity as separate evidence
  layers.
- Treat existing BBB name/license/phone matcher results as discovery candidates only.
  BBB reputation records are not authoritative DBPR license or qualified-business
  evidence.
- Never fuzzy-merge companies or infer a permit license/entity from a name alone.

## Resolve permit company and license identity

Run this sequence for every county/source when permit contractor attribution is in
scope. For Florida, use Sunbiz as the official corporate registry and DBPR as the
official contractor licensing authority. For another state, name equivalent official
authorities in the source profile and apply the same gates.

Start registry ingestion before permit identity matching. Permit capture may proceed in
parallel, but do not auto-resolve an edge until both registry prerequisites pass.

### Use the supported identity vocabulary

Verify the deployed schema before each run. The bundled query-DB schema currently uses:

- `companies.company_id` — the internal UUID for a company. This is the company edge
  target.
- `business_registrations.document_number` — the Sunbiz natural/legal registration
  identifier. `business_registrations.company_id` connects that registration to the
  internal company.
- `companies.request_identifier` — a source ingestion request key. Do not call it an
  official SID or use it as a government legal identifier.
- `source_identifier` — a parcel-seed request field in the runtime. It is not a company,
  license, permit, or person identity.
- `property_improvements.property_improvement_id` — the permit object's internal UUID.
  `(source_system, source_record_key)` is the permit's source uniqueness contract.
- `property_improvements.contractor_company_id` — the supported permit-level company
  foreign-key edge to `companies.company_id`.
- `permit_contacts.permit_contact_id` and `permit_contacts.company_id` — the supported
  contact-level company edge. `permit_contacts.property_improvement_id` connects the
  contact to the permit.
- `permit_contacts.raw_name`, `permit_contacts.license_number`,
  `permit_contacts.license_type`, `permit_contacts.contact_role`, and
  `permit_contacts.source_payload` — raw permit identity evidence. The runtime also
  extracts `qualifierName`; the bundled query schema has no dedicated qualifier column,
  so preserve it in raw artifacts/source payload unless a reviewed migration adds one.
- `permit_contacts.person_id` — a nullable person edge. Do not populate it from a permit
  name or Sunbiz party name alone.
- `business_reputation_license_id` — a BBB reputation-profile child-row ID. It is not a
  DBPR license identity and must not be used as one.

No field named `SID` exists in the bundled permit/company schema. No canonical DBPR
license-identity table, DBPR qualified-business relationship table, permit-to-license
foreign key, or dedicated resolver-provenance edge table exists in the bundled schema
snapshot. Record these as explicit schema/capability gaps. Do not fabricate a `license_id`,
an official SID, or a permit-license edge.

The existing `property_improvements.contractor_company_id` and
`permit_contacts.company_id` edges may be populated only when the resolution is backed
by an immutable resolution ledger described below. If the deployed schema/runtime
cannot retain and reconcile that provenance, record
`identity_edge_provenance_unsupported` and leave the edge unresolved.

### Pass the registry prerequisite gate

Before automatic resolution, require:

1. A loaded, reconciled Sunbiz snapshot containing `companies`,
   `business_registrations`, document numbers, public filing roles, source record keys,
   snapshot time, artifact digest, and freshness state.
2. A loaded, reconciled official DBPR snapshot containing normalized contractor license
   numbers, license status, qualifier identity evidence, qualified-business
   relationships, relationship effective dates, source record keys, snapshot time,
   artifact digest, and freshness state.
3. A documented as-of rule proving the snapshots and effective periods support the
   permit attribution date. A current snapshot without relationship history does not
   prove a historical company relationship.

Sunbiz is authoritative for Florida legal entities, document numbers, and public filing
roles. It is not the licensing authority and does not provide DBPR license IDs. A named
Sunbiz officer, registered agent, or other party is not a canonical individual identity
solely because the name appears in a filing.

DBPR is authoritative for contractor license number, status, qualifier, qualified
business, and effective relationship dates. Do not substitute BBB, a permit portal,
Sunbiz, a search engine, or name similarity for DBPR.

If either registry snapshot is missing, stale for the requested as-of decision, capped,
unreconciled, or unsupported, record the exact gap and do not auto-link. Continue raw
permit ingestion and bounded official-source preparation.

### Preserve the permit extraction contract

For every contractor/qualifier contact, retain:

- raw company/display name, qualifier name, license number/type, and contact role;
- permit number, stable permit and contact source record IDs, source system, source URL,
  municipality/jurisdiction, and capture time;
- application, issue, final inspection, close, completion, event, and inspection dates
  with their evidence states;
- immutable raw artifact URI/digest and source payload.

Do not replace raw values with normalized values or resolved IDs. Add resolution evidence
and edges separately. Exclude phone, email, and private contact data from identity
matching. Use only necessary official public identity fields.

### Apply the resolution ladder

Evaluate each permit contact in order and emit one exact terminal outcome:

1. **`verified_license`** — normalize the raw license only with the
   licensing-authority/source profile, then find exactly one official DBPR license
   record. Verify status and effective dates for the permit attribution date. This
   resolves the license identity in the immutable ledger, but it cannot stamp a
   permit-license database edge until a reviewed schema adds that edge.
2. **`verified_company_via_license_relationship`** — from the verified license, select
   exactly one DBPR qualified-business relationship effective on the permit attribution
   date, then resolve that legal business to exactly one Sunbiz document number and
   `companies.company_id`. Stamp the supported company edges only after all checks pass.
   A license may qualify different businesses over time; never use the current business
   for a historical permit without temporal proof.
3. **`accepted_company_qualifier_candidate`** — when the permit omits a license, require
   all of: an exact profile-normalized legal company name, exact official DBPR qualifier
   identity evidence, a DBPR qualified-business relationship, compatible effective
   dates, one exact Sunbiz legal entity/document number, and exactly one candidate after
   collision checks. Treat permit or Sunbiz name text alone as insufficient identity
   evidence.
4. **`unresolved`** — required evidence is absent or no candidate survives.
5. **`ambiguous`** — multiple candidates survive or the qualifier/name cannot be made
   unique.
6. **`conflicting`** — official sources or effective periods disagree.

Map `unresolved`, `ambiguous`, and `conflicting` to review-required/ineligible downstream
states. Do not lower thresholds to force a match. A historical permit display name
without a license/legal identifier remains source-name attribution only.

Choose the permit attribution date from a valid source-profile rule. Prefer an official
issue/work/lifecycle date when the profile supports it. If no valid attribution date
exists, temporal company resolution is `unresolved`; do not substitute the current date.

### Guard collisions

Treat punctuation folding, hyphenation, shared surnames, common officers, shared
addresses, brands, and regex/fuzzy similarity as collision signals, not merge evidence.

Use this fixed regression example:

- `Z Roofing & Waterproofing` — Sunbiz document `P10000010379`; license
  `CCC1333102`.
- `Z-ROOFING, INC.` — Sunbiz document `P05000095314`; license `CCC1326046`.

An exact verified `CCC1333102` may resolve the first license identity and then its
temporally valid qualified-business relationship. It must never resolve the second
company because normalized names look similar. A permit that says only “Z Roofing”
without a license and without unique official qualifier/effective-period evidence is
`ambiguous`, not linked. Keep historical display names without licenses as source-name
attribution.

### Stamp only supported edges

After a company outcome passes, write only these supported edges:

- contractor-role contact:
  `permit_contacts.company_id -> companies.company_id`;
- permit-level contractor, only when all relevant contractor-role contacts resolve to
  one company:
  `property_improvements.contractor_company_id -> companies.company_id`.

If contractor-role contacts resolve to different companies, retain valid contact-level
edges and leave the permit-level edge null with outcome `conflicting`. Never write
`permit_contacts.person_id` from name-only evidence.

Before writing, require:

- the target `companies.company_id` exists and resolves to the expected Sunbiz
  `business_registrations.document_number`;
- source-key uniqueness for the permit and contact;
- one immutable resolution-ledger record containing raw values, match outcome/method,
  evidence state, resolver/rule version, permit attribution date, effective dates,
  Sunbiz/DBPR snapshot IDs and digests, input/output digests, and superseded-resolution
  reference;
- a transaction or equivalent atomic operation that writes the edge, read-back receipt,
  and ledger handoff without losing source evidence;
- uniqueness, foreign-key, orphan, and count reconciliation after write.

Make resolution idempotent and versioned. Re-running with identical source snapshots,
raw source hashes, and resolver version must be a no-op. Re-resolve only when a source
snapshot/hash, effective relationship, schema capability, or resolver version changes.
Retain the superseded resolution and reason; never treat a prior edge as permanent.

Do not overwrite `source_payload`, raw names, raw licenses, qualifier text, source URLs,
or artifacts. Do not certify the existing private company matcher as satisfying this
contract merely because it writes company foreign keys: its BBB/name/phone candidate
logic and write-if-null behavior do not provide authoritative DBPR temporal proof or
versioned edge provenance.

### Query through verified edges

Build downstream contractor/company cohorts through verified
`property_improvements.contractor_company_id` or `permit_contacts.company_id` joins.
Use raw name/license regex searches only to discover repair candidates. A regex,
fuzzy-name, shared-address, phone, or raw display-name hit cannot count as resolved
attribution.

Do not query a verified permit-license cohort until the schema supports a canonical DBPR
license entity and permit-license edge with provenance. Report that capability as
unsupported rather than joining raw `license_number` text as if it were an ID.

### Reconcile identity resolution

Record these counters per county, source, resolver version, and source-snapshot set:

- Sunbiz company/registration rows, snapshot time/freshness, invalid rows, and
  reconciled document numbers;
- DBPR license and qualified-business relationship rows, snapshot time/freshness,
  invalid rows, and reconciled effective periods;
- permits and contractor-role contacts evaluated;
- exact license matches and rejected/invalid license values;
- temporally valid company links through verified license relationships;
- company+qualifier candidates accepted, rejected, ambiguous, conflicting, and
  review-required;
- name/address/officer/hyphenation/temporal collisions;
- contact-level and permit-level edges written, preserved, superseded, and skipped;
- orphan edges, duplicate source keys, stale resolutions, and unresolved permits.

Add every nonterminal or unsupported result to the existing structured gap ledger. Include
registry freshness/digests, affected permits/contacts, attempted official lookup, terminal
outcome, collision evidence, residual uncertainty, schema capability, and downstream
eligibility.

### Accept the resolver

Require fixture and bounded integration tests proving:

- missing/stale Sunbiz or DBPR snapshots block automatic linking;
- exact DBPR license normalization resolves one license and rejects zero/multiple
  matches;
- a license-to-business relationship is selected only inside its effective period;
- the two Z Roofing entities remain separate, including name-only and hyphen-folded
  cases;
- a unique company+qualifier+temporal candidate is accepted, while name-only, shared
  qualifier, and multiple-candidate cases require review;
- historical display names without license/legal ID remain source-name attribution;
- identical inputs/version produce no new edge or ledger row;
- changed snapshot/hash/version re-resolves and preserves the superseded result;
- all non-null company edges satisfy referential integrity, source-key uniqueness, and
  read-back count reconciliation;
- raw permit evidence is byte-for-byte preserved and no private contact data participates
  in matching;
- downstream cohort queries traverse verified company edges and reject regex-only
  attribution;
- absent DBPR license schema/edge support produces an explicit capability gap, never a
  fabricated ID.

Return registry revisions/freshness, resolver version, ladder outcome counts, collision
counts, edge write/read-back counts, orphan/stale/unresolved counts, schema gaps, allowed
queries, and required operator actions.

## Execute targeted repairs

Plan before execution. Select bounded candidates by immutable source record key and only
for fields that affect a named decision gate. Record candidate count, selection reason,
catalog/profile/source/detail fingerprints, input artifact digests, adapter route, and
the profile-approved rate/concurrency in the plan.

Use official source adapters and conservative source-profile limits. Honor source terms,
CAPTCHA/login/custodian states, cooldowns, leases, fencing, checkpoints, and bounded
retry budgets. Route access blockers through the named records/API request procedure
instead of broadening the scrape.

Do not turn a property-first repair into a countywide traversal. Do not substitute a
different source merely because the intended detail route is blocked. Write immutable
captures, receipts, terminal outcomes, and output digests. Reject changed inputs or plan
digests. Do not load or publish repaired conclusions until acceptance succeeds.

## Maintain the structured gap ledger

Reuse the existing investigation gap envelope when available:
`gapId`, `fact`, `scope`, `beforeState`, `blocker`, `evidence`, `proposedIngest`,
`afterState`, `status`, and `reviewer`.

For each county/source/field gap, record:

- county, jurisdiction, source, source period, field, and affected decision gate;
- observed totals and per-evidence-state counts;
- decision impact and the conclusions currently ineligible;
- immutable evidence references, capture times, and digests;
- attempted repair, bounded candidate count, plan digest, adapter, attempts, and terminal
  outcome;
- residual uncertainty and blocker/owner/fix;
- downstream eligibility for ingest, linkage, lead selection, inference, and publication.

Example:

```json
{
  "gapId": "permit-evidence-contractor-detail",
  "fact": "contractor assignment",
  "scope": {
    "countyKey": "example-county",
    "jurisdictionKey": "example-city",
    "sourceKey": "current-permits",
    "field": "contractor_license"
  },
  "beforeState": {
    "evidenceState": "unavailable",
    "observedCounts": {"listRows": 12, "blankListValues": 12, "detailRows": 0},
    "impact": "unassigned-lead conclusion ineligible"
  },
  "blocker": null,
  "evidence": [{"artifact": "immutable-manifest-key", "sha256": "<sha256>", "capturedAt": "<timestamp>"}],
  "proposedIngest": {
    "attemptedRepair": "official detail and contact lookup",
    "candidateCount": 12,
    "planDigest": "<sha256>"
  },
  "afterState": {
    "evidenceState": "confirmed_empty",
    "residualUncertainty": "none within the reconciled candidate set",
    "downstreamEligibility": {"unassignedLead": true, "legalEntityAttribution": false}
  },
  "status": "resolved",
  "reviewer": null
}
```

Use real immutable artifact references and digests at runtime. Keep unavailable exports
and blocked sources as null/unknown counts, never zero.

## Reconcile and accept

Require all of the following before enabling a decision or publishing its derivative:

- Existing source reconciliation passes for reported, received, normalized, unique,
  duplicate, linked, valid-unlinked, missing, excluded, and invalid counts.
- For each decision-critical field, the unique record count equals the sum of its seven
  evidence-state counts. Every record has exactly one state for that field.
- Detail candidates reconcile to successful details, confirmed source absences,
  unavailable/blocker outcomes, quarantines, and terminal failures. No candidate silently
  disappears.
- Indexed and live observations remain independently traceable; no refresh overwrites
  prior evidence.
- Every quarantined value retains raw provenance and is excluded from date, status,
  identity, linkage, and inference anchors.
- Every company/license join has exact official identifiers and compatible effective
  dates; source-name-only attribution remains separate.
- An identical analysis over the frozen inputs produces the same eligibility and counts.
- The gap ledger names every residual uncertainty and marks affected downstream
  conclusions ineligible.
- Publication validation represents unknown, stale, conflicting, and quarantined evidence
  honestly and omits unsupported conclusions. Unknown evidence does not become a zero,
  negative, or confirmed absence.

## Return the permit evidence report

Add this section to Oracle's operator status whenever permits or permit-backed decisions
are in scope:

- matrix revision/digest and source/profile/detail fingerprints;
- county, jurisdictions, sources, and historical periods evaluated;
- coverage start/end, expected/captured/reconciled counts, and predecessor/archive gaps;
- per-field evidence-state counts;
- detail repair planned/attempted/succeeded/blocked/exhausted counts and plan/output
  digests;
- ingested fields, remaining unknowns, quarantined values, and valid-unlinked records;
- conclusions allowed, conclusions ineligible, residual uncertainty, and exact blocker
  fixes;
- reconciliation and publication-validation results.

## Correct and incorrect decisions

**Incorrect:** “The listing has no contractor column value, so this is an unassigned
lead.”

**Correct:** “The listing field is `unavailable`; bounded official detail/contact repair
is required. Only a successful contractor-capable detail lookup returning no assignment
can set `confirmed_empty`.”

**Incorrect:** “The index says Issued, so the permit is open.”

**Correct:** “Preserve the indexed status, refresh live detail, apply the source-profile
status mapping and precedence, and return `needs_review` if the observations remain
conflicting.”

**Incorrect:** “Strip punctuation from every parcel ID and join the closest result.”

**Correct:** “Apply the county profile's proven lossless normalization. Quarantine an
unsupported format and preserve the permit as valid-unlinked.”

**Incorrect:** “No permit was found in the current portal, so the roof is older than the
requested window.”

**Correct:** “Make age inference ineligible until every relevant authority and predecessor
source reconciles across the full window with valid lifecycle/work dates.”

**Incorrect:** “The historical permit names Example Roofing, so attach the likely state
license and corporate entity.”

**Correct:** “Retain `Example Roofing` as source-name attribution only. Require exact
official license/legal IDs and effective-date evidence before legal entity attribution.”

**Incorrect:** “Sunbiz names this officer, so create a canonical person and use that
person to resolve every matching permit qualifier.”

**Correct:** “Keep the Sunbiz filing-party role as source evidence. Require separate
official identity evidence before writing `permit_contacts.person_id` or treating name
text as an exact qualifier identity.”

**Incorrect:** “The permit has `CCC1333102`, so permanently attach the company with the
closest current name.”

**Correct:** “Verify `CCC1333102` with DBPR, select the DBPR qualified-business
relationship effective on the permit attribution date, resolve that legal business to
one Sunbiz document and `companies.company_id`, then write a versioned company edge.”

**Incorrect:** “Normalize punctuation and merge `Z Roofing & Waterproofing`
(`P10000010379` / `CCC1333102`) with `Z-ROOFING, INC.`
(`P05000095314` / `CCC1326046`).”

**Correct:** “Keep both legal entities and licenses distinct. A name-only ‘Z Roofing’
permit remains ambiguous without unique official qualifier and temporal evidence.”

**Incorrect:** “Write the verified DBPR license into `business_reputation_license_id`
and call it the permit's license edge.”

**Correct:** “Keep the verified DBPR license in the immutable resolution ledger and
record the missing canonical DBPR license entity/permit-license edge as a schema
capability gap until a reviewed migration supports it.”

# Duval parcel-level HOA records request

Jacksonville's public subdivision search and neighborhood-association GIS
layers are not evidence of mandatory HOA membership. They must not populate
`hoa_flag`.

## Request text

> Please provide any current machine-readable records maintained by your
> office that identify Duval County real-estate/folio numbers subject to a
> mandatory homeowners association governed by Florida Chapter 720,
> including every master and sub-association identifier/name, effective
> declaration, annexation, release, withdrawal, preservation, or revival
> date, and instrument/book/page. Exclude Chapter 718 condominiums, Chapter
> 719 cooperatives, CDDs, and voluntary civic organizations. Please state the
> dataset's completeness, whether it includes authoritative negative
> membership, and any conditions on public redistribution. If no parcel-level
> dataset is maintained, please confirm that in writing.

Route the request to the Duval County Property Appraiser records custodian and
the Duval Clerk Official Records/Public Records department. A confirmation
that no responsive parcel-level dataset exists is valid blocker evidence; do
not replace it with subdivision-name inference.

Request routes:

- Duval Clerk Public Records Department: 904-255-1828, Room 2338
- Duval Clerk Official Records and Research: 501 W. Adams Street, Room 1253,
  Jacksonville, FL 32202; 904-255-2025;
  https://www.duvalclerk.gov/services/public-information
- Property Appraiser custodian: pacustserv@coj.net; 904-255-5900
- COJ Public Records Center: https://jacksonvillefl.govqa.us/WEBAPP/_rs/;
  prr@coj.net; 904-255-7674
- Neighborhood Services: Neighborhoodservices@coj.net; 904-255-8250
- Planning GIS Section: 904-255-7836

## Requested delivery contract

Provide newline-delimited JSON with:

- `parcel_identifier` — Duval folio/RE number
- `membership` — `true`, or `false` only when the source has authoritative
  negative coverage
- `association_id` — legal association or project identifier
- `association_type` — exactly `chapter_720_hoa`
- `membership_status` — `active`, or `not_member` only for an exhaustive
  custodian negative
- `instrument_action` — `declaration`, `annexation`, `preservation`, or
  `revival`; exhaustive negatives use `custodian_negative`
- `effective_on` — `YYYY-MM-DD`
- `inactive_on` — optional future termination date; records already released,
  withdrawn, terminated, or expired as of the extract date are rejected
- `evidence_reference` — declaration instrument, book/page, or immutable
  custodian record reference

Provide a separate source manifest:

```json
{
  "schemaVersion": "elephant.hoa-membership-source-manifest.v1",
  "county": "duval",
  "sourceProfileId": "<code-reviewed source profile>",
  "associationScope": "florida_chapter_720_mandatory_hoa",
  "asOfDate": "<YYYY-MM-DD>",
  "authority": "<records custodian>",
  "extractId": "<immutable delivery id>",
  "sourceRetrievedAt": "<ISO timestamp>",
  "recordsRequestReference": "<request/response reference>",
  "scopeDescription": "<associations and dates covered>",
  "authoritative": true,
  "publicationPermitted": true,
  "linkMethod": "parcel_identifier",
  "authoritativeNegativeCoverage": false,
  "recordCount": 0,
  "recordsSha256": "<sha256 of exact JSONL bytes>"
}
```

## Publication gates

- Exact parcel identifier matching only.
- The manifest must match a source profile approved in code; custodian and
  authority self-assertions are not sufficient.
- Positive membership may set `hoa_flag=true`.
- `hoa_flag=false` requires explicit negative records and authoritative
  negative coverage; absent records remain `null`.
- Reconcile source records, source folios, linked properties, positive
  memberships, active association relationships, authoritative negatives,
  and unknown properties.
- Preserve multiple active master/sub-association records per parcel; derive
  the Boolean as at least one effective Chapter 720 membership.
- Do not repoint Duval IPNS until source scope and exact bytes are reviewed.

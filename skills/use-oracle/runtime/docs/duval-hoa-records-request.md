# Duval parcel-level HOA records request

Jacksonville's public subdivision search and neighborhood-association GIS
layers are not evidence of mandatory HOA membership. They must not populate
`hoa_flag`.

## Request text

> Please provide any current machine-readable records maintained by your
> office that identify Duval County real-estate/folio numbers subject to a
> mandatory homeowners, condominium, or cooperative association, including
> the association identifier/name, effective dates, and declaration
> instrument/book/page. Please state the dataset's completeness, whether it
> includes authoritative negative membership, and any conditions on public
> redistribution. If no parcel-level dataset is maintained, please confirm
> that in writing.

Route the request to the Duval County Property Appraiser records custodian and
the Duval Clerk Official Records/Public Records department. A confirmation
that no responsive parcel-level dataset exists is valid blocker evidence; do
not replace it with subdivision-name inference.

## Requested delivery contract

Provide newline-delimited JSON with:

- `parcel_identifier` — Duval folio/RE number
- `membership` — `true`, or `false` only when the source has authoritative
  negative coverage
- `association_id` — legal association or project identifier
- `effective_on` — `YYYY-MM-DD`
- `evidence_reference` — declaration instrument, book/page, or immutable
  custodian record reference

Provide a separate source manifest:

```json
{
  "schemaVersion": "elephant.hoa-membership-source-manifest.v1",
  "county": "duval",
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
- Positive membership may set `hoa_flag=true`.
- `hoa_flag=false` requires explicit negative records and authoritative
  negative coverage; absent records remain `null`.
- Reconcile source records, source folios, linked properties, positive
  memberships, authoritative negatives, and unknown properties.
- Do not repoint Duval IPNS until source scope and exact bytes are reviewed.

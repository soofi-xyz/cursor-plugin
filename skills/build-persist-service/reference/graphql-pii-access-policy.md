# GraphQL PII Access Policy

The GraphQL surface (PRD §3.9, §4.5) can expose personally identifiable fields — today the last four digits of a social security number and the full number — that are never stored in the graph and are fetched live from an external vendor at resolve time. A principal-based access policy decides, per request, which of those fields the caller is allowed to resolve. The policy is a small JSON document injected as an environment variable, evaluated inside the external-source resolver adapter against the IAM principal that signed the request, and enforced fail-closed: a denied field resolves to `null` with a structured GraphQL error, the rest of the document is unaffected, and no vendor call is made for the denied field.

## 1. Purpose & scope

- Gate access to PII-bearing GraphQL fields by caller identity, with a conservative default (last-four only) and explicit per-principal grants for full values.
- Keep the gate inside the resolver pipeline so it applies identically to every query shape, alias, fragment, or batch.
- Keep the policy declarative and reviewable: one document, one enum of access levels, one matching rule.

Non-goals:

- Not transport authentication. The HTTP API's IAM authoriser already rejects unsigned or unauthorised callers; this policy only refines what an authenticated caller may read.
- Not field-level masking of graph-stored properties. Graph and DynamoDB entries accept an optional `pii_access` marker in the resolution map, but enforcement is currently implemented only by the external-vendor adapter (the only source that serves PII). Extend the other adapters before mapping PII onto them.
- Not an audit log of who read which value. Logs and metrics record error counts by source, never values; no log line names the denied caller.
- Not a per-record or row-level policy; grants are per principal and per access level.

## 2. Architecture

- **Where it is evaluated**: inside the external-vendor `SourceResolver` adapter's `batchLoad` (PRD §4.5.1). Before chunking keys or touching the vendor client, the adapter asks the policy service whether `ctx.principalArn` holds the entry's `pii_access` level. On denial it returns one `{ ok: false, error: GraphQlPiiAccessDenied }` per key; the executor's generic loader turns each into a `GraphQLError` and the field resolves to `null`. Graph-backed fields in the same document resolve normally.
- **Caller identity**: the GraphQL Lambda handler reads the HTTP API's IAM authoriser context (`requestContext.authorizer.iam.userArn`, falling back to `userId`, then the literal `"unknown"`) and passes it as `principalArn` in the execution input. The executor copies it into `GraphQlRequestContext`, which every adapter receives per batch. Identity is therefore derived from the SigV4 signature the API already verified — never from a header or body the caller controls.
- **Where the policy lives**: a JSON string in the GraphQL handler's `GRAPHQL_PII_ACCESS_POLICY_JSON` environment variable, set by the CDK stack. The policy service decodes it once at layer construction and exposes `allows(principalArn, access)` plus the parsed `policy`. When the variable is absent the built-in default applies (`default: ["ssn_last_four"]`, no principals).
- **Lexicon and resolution map**: the lexicon marks externally held properties with `persistence: "external"`; the resolution-map loader rejects any non-`graph` entry whose lexicon property is not marked external, and the ingest validators reject any attempt to write such properties into the graph. Each external entry names the access level it requires via `pii_access`; the adapter's `validateEntry` further pins vendor response paths to the correct level (full-value paths must require `full_ssn`, last-four paths must require `ssn_last_four`). The schema generator makes every externally resolved field nullable so denial can be expressed as `null`.

## 3. Contract

Policy document (`GRAPHQL_PII_ACCESS_POLICY_JSON`), placeholder values only:

```json
{
  "default": ["ssn_last_four"],
  "principals": [
    { "arn": "<principal-arn>", "access": ["full_ssn"] },
    { "arn": "<principal-arn-prefix>*", "access": ["full_ssn"] }
  ]
}
```

- `default` (optional array of access levels): levels every authenticated caller holds. Omitted → `["ssn_last_four"]`.
- `principals` (optional array): explicit grants. Each entry has `arn` (an IAM principal identifier, exact or with `*` wildcards) and `access` (array of levels). Omitted → `[]`.
- Non-enum access values, a non-string `arn`, or a wrong shape fail decoding (see malformed policy below). Unknown keys are ignored by the schema decoder, not rejected.

Access level enum (`GraphQlPiiAccess`):

| Level | Grants | Typical field |
| ----- | ------ | ------------- |
| `none` | Always allowed; the entry carries no PII. | non-PII external fields |
| `ssn_last_four` | Partial identifier — last four digits only. | `social_security_number_last_four` |
| `full_ssn` | Complete identifier. Never in `default` in a deployed environment. | `social_security_number_full` |

Levels are independent flags, not a ladder: granting `full_ssn` does not imply `ssn_last_four`; list both when both are intended (the default normally supplies the partial level).

Principal matching (`allows(principalArn, access)`):

1. `none` → allowed.
2. If `access` is in `default` → allowed.
3. Normalise the caller: an STS assumed-role session identifier (`…:sts::<account>:assumed-role/<role>/<session>`) is rewritten to its IAM role identifier (`…:iam::<account>:role/<role>`) so grants can name the role, not the session.
4. Allowed if any `principals` entry lists `access` and its `arn` matches **either** the raw or the normalised caller identifier. A pattern without `*` must match exactly; with `*`, it is anchored and every other character is literal (`.` and other regex metacharacters are escaped). Use trailing wildcards for platform-generated role names whose suffix is unstable.
5. Otherwise denied. The `"unknown"` fallback identity only ever receives `default` levels.

Malformed policy: a JSON or schema error fails the policy service's layer with `GraphQlPiiAccessPolicyConfigError` (message plus a formatted decode tree as `cause`). Because the vendor adapter and the handler layer depend on it, GraphQL requests fail at layer construction and surface on both routes as the unmapped-tag fallback `500 InternalServerError` ([error-catalogue-and-responses.md](./error-catalogue-and-responses.md) §4) — fail closed, never fall back to the built-in default.

Denied field: resolves to `null`; the response `errors[]` gains an entry with `message: "Caller is not authorized to resolve this GraphQL PII field"` and `extensions: { code: "GraphQlPiiAccessDenied", source: "interprose", retriable: false }`. The field is never omitted, the HTTP status stays 200, and sibling fields — including a permitted last-four field on the same node — are unaffected. Denial is decided before any key is sent to the vendor, so `extensions.sources` for that source reports the batch as used with a near-zero duration.

Missing context: if the key template's graph-resolved property (for example the owning debt identifier) is absent, the adapter returns `GraphQlExternalContextMissing` for that key; it is not an access decision.

## 4. Runtime behaviour

1. HTTP API authorises the SigV4 request (IAM authoriser) and invokes the GraphQL handler.
2. Handler extracts `principalArn` from the authoriser context, parses the body, and calls the executor with `{ payload, requestId, principalArn }`.
3. Executor runs guards ([graphql-read-surface.md](./graphql-read-surface.md) §7), builds a per-request context carrying `principalArn`, and executes the document.
4. For each externally sourced field, the DataLoader batch reaches the vendor adapter with the resolution-map entry and context.
5. Adapter calls `allows(ctx.principalArn, entry.pii_access)`; on `false` it returns a denial result per key without vendor I/O; on `true` it proceeds with chunking, concurrency limits, and the TTL cache.
6. Executor maps per-key failures to nulls plus `errors[]`, records field-failure metrics by source, and returns HTTP 200.

The policy is read once per container (layer construction); changing the environment variable requires a redeploy or configuration update that recycles containers.

## 5. Observability

- Never log, emit as a metric dimension, or include in error details any resolved PII value, vendor response body, or vendor URL. The structured completion log carries only `requestId`, `operationName`, `sdlHash`, `resolutionMapHash`, the list of sources used, error count, and duration.
- Denials are visible as `graphql_field_failures{source=interprose}` increments and as `GraphQlPiiAccessDenied` codes in the response; treat a sudden rise as a mis-scoped grant or an unexpected caller identity.
- Do not add `principalArn` as a metric dimension (unbounded cardinality). It is not logged today; if an operator needs to trace a denial it may be added to the structured completion log at `info` level — it is not sensitive, but it identifies the caller.
- `interprose_resolver_calls` stays flat for denied batches; use the gap between field resolutions and resolver calls to confirm denials are short-circuiting before vendor I/O.

## 6. Operations

Grant a new principal:

1. Identify the caller's IAM role identifier (not the session). For platform-generated role names with unstable suffixes, use a prefix plus `*`.
2. Add `{ "arn": "<principal-arn>", "access": ["full_ssn"] }` to `principals` in the stack's policy literal; keep `default` at `["ssn_last_four"]`.
3. Add or update the CDK assertion test that pins the rendered `GRAPHQL_PII_ACCESS_POLICY_JSON`, and a unit test in the policy suite covering the new pattern (exact, assumed-role normalisation, wildcard).
4. Deploy; run the GraphQL E2E suite once with `E2E_GRAPHQL_EXPECT_FULL_SSN_ACCESS=1` under the granted identity and once without it under an ungranted identity.

Revoke or rotate:

- Remove the entry and redeploy; there is no cache beyond container lifetime. Because matching normalises assumed-role sessions, rotating role *sessions* needs no policy change; renaming a role does.
- Never widen `default` to `full_ssn` to unblock a caller. Prefer a narrowly scoped wildcard over a broad one.
- Before any change, run the policy unit tests and the CDK assertion test that pins the rendered policy so an accidental JSON edit cannot ship a document that fails decoding and takes the whole GraphQL surface down.

## 7. Verification & acceptance criteria

- Policy unit: an ungranted principal is allowed `ssn_last_four` and denied `full_ssn`; an exactly listed role is allowed `full_ssn`; an assumed-role session of that role normalises to the role identifier and is allowed; a wildcard pattern matches a generated role name with an arbitrary suffix. (`none` short-circuits to allowed in `isPiiAccessAllowed` but has no unit test.)
- Adapter unit: with a policy that denies `full_ssn`, `batchLoad` returns `{ ok: false, error: GraphQlPiiAccessDenied }` for every key and makes zero vendor calls; with a permitting policy it resolves the full value using the debt identifier from key context; a missing key property yields `GraphQlExternalContextMissing`.
- Resolution-map load: an external entry whose full-value response path is not marked `full_ssn`, or whose lexicon property lacks `persistence: "external"`, fails the map load closed (code behaviour in `validateMap` and the adapter's `validateEntry`; no dedicated test exists).
- Stack: the GraphQL handler environment renders the expected policy JSON with `default: ["ssn_last_four"]` and only the intended principal patterns.
- E2E: a signed request selecting both the last-four and full fields returns 200; every error (if any) has `source: "interprose"` and code `InterproseResolverError` or `GraphQlPiiAccessDenied`; the full value is present only when the run is flagged as executing under a granted identity; no test output prints a resolved value.
- Malformed policy: providing an invalid document fails service construction with `GraphQlPiiAccessPolicyConfigError` rather than silently using the default (code behaviour; no unit test exercises the decode failure).

## 8. Source map

| Concern | Path (persist repo) |
| ------- | ------------------- |
| Policy decode, normalisation, matching, `allows` | `lambda/services/GraphQlPiiAccessPolicyService.ts` |
| Access-level enum, `pii_access` on resolution-map entries | `lambda/schemas/graphql.ts` |
| `persistence: external` lexicon marker | `lambda/schemas/lexicon.ts` |
| Enforcement point and entry validation | `lambda/services/GraphQlInterproseResolverService.ts` |
| Caller principal extraction | `lambda/graphql/handler.ts` |
| Request context shape, `SourceResolver` port | `lambda/services/GraphQlSourceResolver.ts` |
| Context construction, per-key error → `errors[]`, metrics | `lambda/services/GraphQlExecutorService.ts` |
| External-property enforcement at map load and ingest | `lambda/services/GraphQlResolutionMapService.ts`, `lambda/services/GraphSONSemanticValidationService.ts`, `lambda/services/NeptuneCsvLexiconValidationService.ts` |
| Nullability of externally resolved fields | `lambda/services/GraphQlSchemaService.ts` |
| Error tags (`GraphQlPiiAccessPolicyConfigError`, `GraphQlPiiAccessDenied`, `GraphQlExternalContextMissing`) | `lambda/schemas/errors.ts` |
| Env var injection and IAM authoriser | `lib/persist-stack.ts` |
| Example resolution map with PII entries | `config/graphql-resolution-map.json` |
| Layer wiring | `lambda/services/index.ts` |
| Tests | `test/services/GraphQlPiiAccessPolicyService.test.ts`, `test/services/GraphQlInterproseResolverService.test.ts`, `test/cdk/persist-stack.test.ts`, `test/e2e/persist-graphql.e2e.test.ts` |

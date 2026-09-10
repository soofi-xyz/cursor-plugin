---
title: Tenant-Neutral Sanitization
impact: CRITICAL
tags: sanitization, credentials, customer-data, ci
---

# Tenant-Neutral Sanitization

Keep the Hoopa agent and `build-portals` skill generic. Organization-specific
values belong only in the operator invocation and the generated portal
repository. They must not enter the reusable kit PR.

## Prohibited kit content

Reject:

- customer or organization names and abbreviations
- customer domains, portal URLs, source-repository URLs, and internal hosts
- AWS account identifiers, Amplify app identifiers, and customer resource IDs
- passwords, tokens, API keys, private keys, connection strings, and secret
  values
- customer records, production payloads, and organization-specific API
  contracts
- copied environment configuration from a reference implementation

Tenant-neutral placeholders, documented environment variable names, synthetic
`.invalid` examples used by scanner self-tests, and generic vendor
documentation links are allowed.

## Required workflow

1. Keep tenant values in Asana or the operator prompt during intake.
2. Normalize only required shapes and placeholder names into generic examples.
3. Run `scripts/check-build-portals-sanitization.py` before commit and in CI.
4. If the operator supplies additional prohibited literals, pass them one per
   line through `PORTAL_PROHIBITED_LITERALS`.
5. Perform a semantic diff review for tenant names, repository slugs, business
   contracts, and customer data that pattern matching cannot infer.
6. Treat every finding as blocking. Remove the value; do not add an allowlist
   entry for a customer value.

The scanner covers the Hoopa source agent and generated mirrors,
`skills/build-portals`, the Hoopa README row, and additions to those files in
the current git diff. It detects configured literals, URLs, cloud resource
references, account/app identifiers, credential shapes, and common organization
name forms. A passing scanner is necessary but does not replace semantic review.

## Credential handling

Use names such as `SECRET_PLACEHOLDER_API_TOKEN`, not realistic-looking sample
credentials. Never print discovered secret values to logs or evidence. Store
approved secret values in the organization-selected secret manager and grant
the generated runtime access by resource name.

## Allowlist policy

Allowlist only stable, public vendor documentation or assets required by the
generic plugin. An organization domain, account, repository, app ID, or API
host is never allowlisted. When uncertain, stop and ask for a tenant-neutral
replacement.

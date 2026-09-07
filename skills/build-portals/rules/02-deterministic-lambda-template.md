---
title: Deterministic Lambda Template
impact: CRITICAL
tags: lambda, cdk, api-gateway, iam, secrets, observability
---

# Deterministic Lambda Template

For `new_repository`, generate the portal backend from
`reference/portal-api-stack.ts`. For `existing_repository`, preserve the
project's established backend and IaC patterns; use this template only when the
change creates a new Lambda-backed service or explicitly adopts it through a
reviewed migration. Do not put tenant values back into this generic reference.

## Required inputs

Map these `portal-spec.json` values directly to `PortalApiStackProps`:

- `infra.apiName` and `infra.functionName`
- `infra.allowedOrigins`
- `infra.memoryMb` (default `512` MB)
- `infra.timeoutSeconds` (default `30`)
- `infra.provisionedConcurrency` (default `0`)
- `infra.logRetentionDays`
- `infra.alarmTopicArn`
- secret names from `secrets[]`
- non-secret `environment`

Account, region, origins, secret names, and environment values are
organization-supplied. Keep placeholders when the operator explicitly permits
them. Never infer or embed those values. An alarm-topic placeholder may
synthesize for code review, but it blocks deployment until replaced by an
approved SNS topic ARN.

## Deterministic infrastructure

The generated stack must contain:

1. One Node.js Lambda with active X-Ray tracing and Powertools service,
   metrics, and log-level environment variables.
2. An explicit `/aws/lambda/<functionName>` log group using the configured retention.
3. An HTTP API with operator-supplied CORS origins and a proxy route.
4. A `live` Lambda alias backed by `currentVersion` only when provisioned
   concurrency is greater than zero. With zero, integrate the unqualified
   function and do not publish an unnecessary version.
5. Named Secrets Manager references with `grantRead` on the execution target.
   Secret values never enter CDK source, CloudFormation parameters, or Lambda
   environment variables.
6. Lambda duration/error and HTTP API latency/5xx alarms, all connected to the
   operator-supplied SNS topic.
7. CloudFormation outputs for the API endpoint and function name.

## IAM policy

Use least-privilege grants from CDK resources, such as `secret.grantRead()`.
Wildcard IAM resources or actions are forbidden unless AWS does not support
resource-level scoping for the required action. Any unavoidable wildcard must
be narrowly action-scoped and explained inline beside the policy statement.
Do not attach managed administrator policies.

## Provisioned concurrency

`provisionedConcurrency: 0` is the safe default and means no alias is
created. A positive value on a **new** function creates alias `live` and
points API Gateway at that alias. The feature environment must use the
configured value from the portal spec; production sizing is not guessed.

On an **existing** function, do not create alias `live` if that alias
already exists outside this stack. CloudFormation `Alias already exists`
(409) rolls the deploy back. Use a new alias name (for example
`provisioned`) and point API Gateway at it. Do not delete `:live` without
explicit AWS ownership.

## Secrets

`secretNames` contains approved secret names or operator-approved placeholder
names, never secret values. The handler retrieves values from Secrets Manager
at runtime. Its execution role receives read access only to the listed secrets.

## Verification

Synthesize the generated stack and inspect the template before deployment:

```bash
pnpm --filter api-cdk cdk synth
pnpm --filter api-cdk cdk diff
```

Reject the generated stack if defaults became hardcoded constraints, origins
became `*`, secrets were placed in environment variables, or broad IAM was
introduced.

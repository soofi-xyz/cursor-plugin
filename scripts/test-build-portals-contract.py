#!/usr/bin/env python3
"""Contract tests for skills/build-portals intake and portal-spec schema.

Run standalone from the plugin repo root:

    python3 scripts/test-build-portals-contract.py
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from jsonschema import Draft202012Validator, FormatChecker
    from jsonschema.exceptions import SchemaError
except ModuleNotFoundError:
    print(
        "missing test dependency: install jsonschema",
        file=sys.stderr,
    )
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / "skills" / "build-portals"
HOOPA_AGENT = ROOT / "agents" / "hoopa.md"
SKILL_MD = SKILL_DIR / "SKILL.md"
INTAKE_RULES = SKILL_DIR / "rules" / "01-intake-and-portal-spec.md"
SCHEMA_PATH = SKILL_DIR / "reference" / "portal-spec.schema.json"
LAMBDA_RULES = SKILL_DIR / "rules" / "02-deterministic-lambda-template.md"
LAMBDA_REFERENCE = SKILL_DIR / "reference" / "portal-api-stack.ts"
REPO_PREVIEW_RULES = SKILL_DIR / "rules" / "03-repo-and-amplify-preview.md"
VERIFICATION_RULES = SKILL_DIR / "rules" / "04-verification-gates.md"
LATENCY_REFERENCE = SKILL_DIR / "reference" / "measure-latency.mjs"
EXISTING_REPOSITORY_RULES = (
    SKILL_DIR / "rules" / "06-existing-repository-changes.md"
)

SOURCE_TYPES = ("figma", "portal_url", "other_design", "source_repo")
DELIVERY_MODES = ("new_repository", "existing_repository")
REQUIRED_SCHEMA_FIELDS = (
    "deliveryMode",
    "sourceType",
    "changeRequest",
    "openQuestions",
)
REQUIRED_SKILL_TOKENS = (
    "new_repository",
    "existing_repository",
    "changeRequest",
    "figma",
    "portal_url",
    "other_design",
    "source_repo",
    "Figma MCP",
)
HARD_STOP_FIELDS = (
    "designSource",
    "deliveryContext",
    "openQuestions",
    "GitHub org",
    "repository name",
    "AWS account",
    "Amplify",
    "auth model",
    "API contract",
    "testPersonas",
    "datasetRef",
    "BrowserStack",
    "do not scaffold",
)
PIPELINE_STAGES = (
    "Intake",
    "Normalize",
    "Prepare repository",
    "Plan or scaffold",
    "Frontend",
    "Backend",
    "Integrate or deploy",
    "Verify",
    "Pull request and handoff",
)
LAMBDA_TEMPLATE_TOKENS = (
    "PortalApiStackProps",
    "PortalApiStack",
    "memoryMb",
    "memorySize",
    "timeoutSeconds",
    "provisionedConcurrency",
    "provisionedConcurrentExecutions",
    "logRetentionDays",
    "alarmTopicArn",
    "'live'",
    "grantRead",
    "LogGroup",
    "Tracing.ACTIVE",
    "p95",
    "DurationAlarm",
    "ErrorAlarm",
    "ApiLatencyAlarm",
    "Http5xxAlarm",
    "SnsAction",
)
REPO_PREVIEW_TOKENS = (
    "gh repo create",
    "--add-readme",
    "feat/portal-v1",
    "apps/web",
    "apps/api",
    "apps/api/cdk/lib",
    "packages/shared",
    ".github",
    "ci.yml",
    "amplify.yml",
    "gh pr create",
    "feature-branch API",
    "deployment output",
    "custom domain",
    "out of scope",
)
VERIFICATION_TOKENS = (
    "repository's required gates",
    "scope-appropriate",
    "not applicable",
    "no coverage regression",
    "pull request",
    "100%",
    "80%",
    "mobile",
    "tablet",
    "desktop",
    "BrowserStack",
    "preview",
    "real feature",
    "p95",
    "< 200",
    "coverage",
    "latency JSON",
)
LATENCY_SCRIPT_TOKENS = (
    "API_URL",
    "EXPECTED_API_URL",
    "ALLOW_MUTATING_REQUESTS",
    "DATASET_PATH",
    "REQUEST_COUNT",
    ".sort(",
    "p95",
    ">= 200",
)
EXISTING_REPOSITORY_TOKENS = (
    "git status --short",
    "git worktree",
    "base branch",
    "feature branch",
    "preserve user changes",
    "existing architecture",
    "minimum necessary",
    "gh pr create",
    "update an existing PR",
    "never merge",
    "integration branch",
    "API_V2_HTTP_API_ID",
    "conkeldurr",
    "hoothoot",
    "sibling-style",
    "JWT authorizer",
    "Cognito ID token",
    "address bar",
    "legacy session token",
)


def fail(message: str) -> None:
    raise AssertionError(message)


def read_text(path: Path) -> str:
    if not path.is_file():
        fail(f"missing required file: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def load_schema() -> dict:
    text = read_text(SCHEMA_PATH)
    try:
        schema = json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"{SCHEMA_PATH.relative_to(ROOT)}: invalid JSON ({exc})")
    if not isinstance(schema, dict):
        fail(f"{SCHEMA_PATH.relative_to(ROOT)}: schema root must be an object")
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        fail(f"{SCHEMA_PATH.relative_to(ROOT)}: invalid JSON Schema ({exc})")
    return schema


def validate_against_schema(schema: dict, document: dict, label: str) -> None:
    errors = sorted(
        Draft202012Validator(
            schema,
            format_checker=FormatChecker(),
        ).iter_errors(document),
        key=lambda error: list(error.absolute_path),
    )
    if errors:
        details = "; ".join(
            f"{'/'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
            for error in errors
        )
        fail(f"{label}: schema validation failed: {details}")


def assert_schema_rejects(schema: dict, document: dict, label: str) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    if validator.is_valid(document):
        fail(f"{label}: schema unexpectedly accepted invalid document")


def assert_skill_corpus_contains_tokens(corpus: str) -> None:
    lowered = corpus.lower()
    for token in REQUIRED_SKILL_TOKENS:
        if token.lower() not in lowered:
            fail(f"skill corpus must mention {token!r}")

    for field in HARD_STOP_FIELDS:
        if field.lower() not in lowered:
            fail(f"skill corpus must document hard-stop field {field!r}")

    for stage in PIPELINE_STAGES:
        if stage.lower() not in lowered:
            fail(f"skill corpus must include pipeline stage {stage!r}")

    stop_phrases = (
        "stop if `openquestions` is non-empty",
        "stop if openquestions is non-empty",
        "do not scaffold while `openquestions` is non-empty",
        "do not scaffold while openquestions is non-empty",
    )
    if not any(phrase in lowered for phrase in stop_phrases):
        fail("skill corpus must state stop-before-scaffold when openQuestions is non-empty")


def assert_intake_rules(corpus: str) -> None:
    lowered = corpus.lower()
    if "new_repository" not in lowered or "existing_repository" not in lowered:
        fail("intake rules must resolve new vs existing repository intent first")
    if "backend" not in lowered or "change request" not in lowered:
        fail("intake rules must support scoped backend changes")
    if "exactly one" not in lowered:
        fail("intake rules must require exactly one primary design source")
    if "other_design" not in lowered:
        fail("intake rules must describe other_design for exported screenshots")
    if "figma mcp" not in lowered:
        fail("intake rules must route Figma URLs through Figma MCP")
    if "exported" not in lowered and "screenshot" not in lowered:
        fail("intake rules must state exported screenshots are other_design, not figma")


def assert_schema_contract(schema: dict) -> None:
    required = schema.get("required", [])
    for field in REQUIRED_SCHEMA_FIELDS:
        if field not in required:
            fail(f"schema required must include {field!r}")

    source_enum = schema.get("properties", {}).get("sourceType", {}).get("enum", [])
    for source_type in SOURCE_TYPES:
        if source_type not in source_enum:
            fail(f"schema sourceType enum must include {source_type!r}")

    delivery_mode_enum = (
        schema.get("properties", {}).get("deliveryMode", {}).get("enum", [])
    )
    for delivery_mode in DELIVERY_MODES:
        if delivery_mode not in delivery_mode_enum:
            fail(f"schema deliveryMode enum must include {delivery_mode!r}")

    conditional_contract = json.dumps(schema.get("allOf", []))
    for token in (
        "new_repository",
        "existing_repository",
        "repositoryContext",
        "source_repo",
    ):
        if token not in conditional_contract:
            fail(f"schema conditionals must include {token!r}")

    breakpoint_schema = schema.get("properties", {}).get("breakpoints", {})
    breakpoint_constraints = json.dumps(breakpoint_schema.get("allOf", []))
    for breakpoint_name in ("mobile", "tablet", "desktop"):
        if f'"const": "{breakpoint_name}"' not in breakpoint_constraints:
            fail(
                "schema breakpoints must require one "
                f"{breakpoint_name!r} breakpoint"
            )

    valid_example = {
        "deliveryMode": "new_repository",
        "sourceType": "portal_url",
        "changeRequest": {
            "summary": "Create a portal from the supplied design",
            "scopes": ["frontend", "backend", "infrastructure"],
            "acceptanceCriteria": ["Open a reviewed pull request"],
        },
        "designSource": {"reference": "https://example.com/reference-portal"},
        "deliveryContext": {
            "repository": "example-org/example-portal",
            "repositoryVisibility": "private",
            "createRepositoryAuthorized": True,
            "pullRequestAuthorized": True,
            "deploymentAuthorized": False,
            "aws": {"mode": "placeholders"},
            "amplify": {"mode": "configure"},
        },
        "screens": [
            {
                "route": "/",
                "purpose": "Landing page",
                "states": ["logged-out"],
            }
        ],
        "breakpoints": [
            {"name": "mobile", "widthPx": 390},
            {"name": "tablet", "widthPx": 768},
            {"name": "desktop", "widthPx": 1280},
        ],
        "auth": {"mode": "none", "callbackEnvKeys": []},
        "apis": [],
        "secrets": [],
        "infra": {
            "apiName": "example-portal-api",
            "functionName": "example-portal-handler",
            "allowedOrigins": ["https://example.com"],
            "memoryMb": 512,
            "timeoutSeconds": 30,
            "provisionedConcurrency": 0,
            "logRetentionDays": 30,
            "alarmTopicArn": "SECRET_PLACEHOLDER_ALARM_TOPIC_ARN",
        },
        "testPersonas": [{"name": "anonymous", "role": "visitor"}],
        "datasetRef": {"location": "s3://example-bucket/example-dataset", "format": "json"},
        "hosting": {"mode": "amplify-preview", "customDomain": "out_of_scope_v1"},
        "openQuestions": [],
    }
    validate_against_schema(schema, valid_example, "valid example")

    existing_example = {
        "deliveryMode": "existing_repository",
        "sourceType": "source_repo",
        "changeRequest": {
            "summary": "Add one backend endpoint",
            "scopes": ["backend"],
            "acceptanceCriteria": ["Open a pull request with API tests"],
        },
        "repositoryContext": {
            "repository": "example-org/example-portal",
            "baseBranch": "main",
            "featureBranch": "feat/add-backend-endpoint",
            "writeAuthorized": True,
            "pullRequestAuthorized": True,
        },
        "openQuestions": [],
    }
    validate_against_schema(schema, existing_example, "existing repository example")

    blocked_example = dict(valid_example)
    blocked_example["openQuestions"] = ["Need GitHub org and repository name"]
    validate_against_schema(schema, blocked_example, "blocked example")

    assert_schema_rejects(schema, {"sourceType": "figma"}, "incomplete example")

    wrong_existing_source = copy.deepcopy(existing_example)
    wrong_existing_source["sourceType"] = "figma"
    assert_schema_rejects(
        schema,
        wrong_existing_source,
        "existing repository with non-repository source",
    )

    unauthorized_existing = copy.deepcopy(existing_example)
    unauthorized_existing["repositoryContext"]["pullRequestAuthorized"] = False
    assert_schema_rejects(
        schema,
        unauthorized_existing,
        "existing repository without PR authorization",
    )

    missing_new_context = copy.deepcopy(valid_example)
    del missing_new_context["deliveryContext"]
    assert_schema_rejects(
        schema,
        missing_new_context,
        "new repository without delivery context",
    )

    missing_acceptance_criteria = copy.deepcopy(existing_example)
    del missing_acceptance_criteria["changeRequest"]["acceptanceCriteria"]
    assert_schema_rejects(
        schema,
        missing_acceptance_criteria,
        "change request without acceptance criteria",
    )

    invalid_infra = copy.deepcopy(valid_example)
    invalid_infra["infra"]["memoryMb"] = 10_241
    invalid_infra["infra"]["timeoutSeconds"] = 901
    assert_schema_rejects(schema, invalid_infra, "invalid Lambda limits")


def assert_lambda_template_contract() -> None:
    rules_text = read_text(LAMBDA_RULES)
    reference_text = read_text(LAMBDA_REFERENCE)
    corpus = "\n".join([rules_text, reference_text])

    for token in LAMBDA_TEMPLATE_TOKENS:
        if token not in corpus:
            fail(f"deterministic Lambda template must include {token!r}")

    if "512" not in reference_text or "30" not in reference_text:
        fail("Lambda reference must default to 512 MB and 30 seconds")
    if "provisionedConcurrency = 0" not in reference_text:
        fail("Lambda reference must default provisioned concurrency to 0")
    if "wildcard" not in rules_text.lower() or "least-privilege" not in rules_text.lower():
        fail("Lambda rules must document least-privilege and wildcard IAM policy")


def assert_repo_preview_contract() -> None:
    rules_text = read_text(REPO_PREVIEW_RULES)
    lowered = rules_text.lower()

    for token in REPO_PREVIEW_TOKENS:
        if token.lower() not in lowered:
            fail(f"repo and Amplify preview rules must include {token!r}")

    if "production api" not in lowered or "reject" not in lowered:
        fail("preview rules must reject production API URLs")
    if "embedded app id" not in lowered or "returned metadata" not in lowered:
        fail("preview origin must use returned Amplify metadata, not embedded IDs")

    ordered_tokens = (
        "--add-readme",
        'base_branch="$(git branch --show-current)"',
        "git switch -c feat/portal-v1",
        "gh pr create",
    )
    positions = [lowered.find(token) for token in ordered_tokens]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        fail("new-repository workflow must establish a base before branch and PR")


def assert_verification_contract() -> None:
    rules_text = read_text(VERIFICATION_RULES)
    latency_text = read_text(LATENCY_REFERENCE)

    for token in VERIFICATION_TOKENS:
        if token.lower() not in rules_text.lower():
            fail(f"verification rules must include {token!r}")
    for token in LATENCY_SCRIPT_TOKENS:
        if token not in latency_text:
            fail(f"latency reference must include {token!r}")
    if (
        "for `existing_repository`, apply only" not in rules_text.lower()
        or "`deployment` is in `changerequest.scopes`" not in rules_text.lower()
    ):
        fail("live gates must be opt-in for existing-repository changes")


def assert_latency_runner_safety() -> None:
    syntax = subprocess.run(
        ["node", "--check", str(LATENCY_REFERENCE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if syntax.returncode != 0:
        fail(f"latency reference has invalid JavaScript: {syntax.stderr}")

    with tempfile.TemporaryDirectory() as temp_dir:
        dataset_path = Path(temp_dir) / "dataset.json"
        dataset_path.write_text(
            json.dumps([{"method": "POST", "path": "/records"}]),
            encoding="utf-8",
        )
        base_env = {
            **os.environ,
            "API_URL": "https://feature.example.com",
            "EXPECTED_API_URL": "https://feature.example.com",
            "DATASET_PATH": str(dataset_path),
            "REQUEST_COUNT": "1",
        }

        mutation = subprocess.run(
            ["node", str(LATENCY_REFERENCE)],
            cwd=ROOT,
            env=base_env,
            capture_output=True,
            text=True,
            check=False,
        )
        if mutation.returncode == 0 or "ALLOW_MUTATING_REQUESTS" not in mutation.stderr:
            fail("latency runner must reject mutating requests without opt-in")

        mismatch_env = {
            **base_env,
            "EXPECTED_API_URL": "https://other.example.com",
        }
        mismatch = subprocess.run(
            ["node", str(LATENCY_REFERENCE)],
            cwd=ROOT,
            env=mismatch_env,
            capture_output=True,
            text=True,
            check=False,
        )
        if mismatch.returncode == 0 or "must match" not in mismatch.stderr:
            fail("latency runner must reject a target mismatch")

        insecure_env = {
            **base_env,
            "API_URL": "http://feature.example.com",
            "EXPECTED_API_URL": "http://feature.example.com",
        }
        insecure = subprocess.run(
            ["node", str(LATENCY_REFERENCE)],
            cwd=ROOT,
            env=insecure_env,
            capture_output=True,
            text=True,
            check=False,
        )
        if insecure.returncode == 0 or "must use https" not in insecure.stderr:
            fail("latency runner must reject insecure API URLs")


def assert_existing_repository_contract() -> None:
    rules_text = read_text(EXISTING_REPOSITORY_RULES)

    for token in EXISTING_REPOSITORY_TOKENS:
        if token.lower() not in rules_text.lower():
            fail(f"existing-repository rules must include {token!r}")


def assert_hoopa_agent_contract() -> None:
    agent_text = read_text(HOOPA_AGENT)
    lowered = agent_text.lower()
    required = (
        "new_repository",
        "existing_repository",
        "state the selected mode",
        "repository's own agent and engineering rules",
        "preserve the existing checkout",
        "feature branch",
        "open or update the pr",
        "never merge",
        "backend-only work is valid",
        "integration branch",
        "api_v2_http_api_id",
        "conkeldurr",
        "hoothoot",
        "jwt authorizer",
        "cognito id token",
    )
    for token in required:
        if token not in lowered:
            fail(f"Hoopa agent contract must include {token!r}")

    prohibited = (
        "skills/apply-engineering-guidelines/",
        "skills/build-frontend-backends/",
        "default and only v1 path",
    )
    for token in prohibited:
        if token in lowered:
            fail(f"Hoopa agent must not impose conflicting directive {token!r}")


def main() -> int:
    skill_text = read_text(SKILL_MD)
    rules_text = read_text(INTAKE_RULES)
    corpus = "\n".join([skill_text, rules_text])

    assert_skill_corpus_contains_tokens(corpus)
    assert_intake_rules(corpus)

    schema = load_schema()
    assert_schema_contract(schema)
    assert_lambda_template_contract()
    assert_repo_preview_contract()
    assert_verification_contract()
    assert_latency_runner_safety()
    assert_existing_repository_contract()
    assert_hoopa_agent_contract()

    print("build-portals contract tests passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"build-portals contract tests failed: {exc}", file=sys.stderr)
        raise SystemExit(1)

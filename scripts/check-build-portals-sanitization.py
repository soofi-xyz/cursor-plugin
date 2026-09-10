#!/usr/bin/env python3
"""Reject machine-detectable tenant or credential content in Hoopa files."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SCANNED_FILES = (
    ROOT / "agents" / "hoopa.md",
    ROOT / "agents-copilot" / "hoopa.agent.md",
    ROOT / ".codex" / "agents" / "hoopa.toml",
)
BUILD_PORTALS_DIR = ROOT / "skills" / "build-portals"
README_PATH = ROOT / "README.md"

ALLOWED_URL_HOSTS = {
    "assets.pokemon.com",
    "example.com",
    "json-schema.org",
    "soofi.xyz",
}
URL_PATTERN = re.compile(r"https?://[^\s<>)\]\"'`]+", re.IGNORECASE)
ACCOUNT_ID_PATTERN = re.compile(r"(?<!\d)\d{12}(?!\d)")
CREDENTIAL_PATTERNS = (
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    (
        "private key",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ),
)
CREDENTIAL_ASSIGNMENT_PATTERN = re.compile(
    r"""(?ix)
    \b(?:password|passwd|secret|token|api[_-]?key)\b
    \s*[:=]\s*
    ["']([^"']+)["']
    """
)
SAFE_ASSIGNMENT_MARKERS = ("placeholder", "example", "${", "process.env")
CLOUD_RESOURCE_URI_PATTERN = re.compile(
    r"\b(?:s3|ssm|secretsmanager)://[^\s<>)\]\"'`]+|"
    r"\barn:aws(?:-[a-z]+)?:[a-z0-9-]+:[^\s<>)\]\"'`]+",
    re.IGNORECASE,
)
AMPLIFY_ID_ASSIGNMENT_PATTERN = re.compile(
    r"""(?ix)
    \b(?:amplify[_-]?app[_-]?id|app[_-]?id)\b
    \s*[:=]\s*
    ["'](d[a-z0-9]{8,})["']
    """
)
ORGANIZATION_NAME_PATTERN = re.compile(
    r"\b(?:[A-Z][A-Za-z0-9&.-]*\s+){1,5}"
    r"(?:LLC|Inc\.?|Corporation|Corp\.?|Holdings|Capital)\b"
)
SAFE_TENANT_MARKERS = ("example", "placeholder", "invalid")


def configured_literals() -> tuple[str, ...]:
    raw = os.environ.get("PORTAL_PROHIBITED_LITERALS", "")
    return tuple(value.strip() for value in raw.splitlines() if value.strip())


def scan_text(label: str, text: str, literals: tuple[str, ...]) -> list[str]:
    findings: list[str] = []
    lowered = text.casefold()

    for literal in literals:
        if literal.casefold() in lowered:
            findings.append(f"{label}: prohibited configured literal found")

    for match in URL_PATTERN.finditer(text):
        host = (urlparse(match.group(0)).hostname or "").casefold()
        if host not in ALLOWED_URL_HOSTS:
            findings.append(f"{label}: non-allowlisted URL host {host!r}")

    if ACCOUNT_ID_PATTERN.search(text):
        findings.append(f"{label}: possible 12-digit cloud account identifier")

    for credential_type, pattern in CREDENTIAL_PATTERNS:
        if pattern.search(text):
            findings.append(f"{label}: possible {credential_type}")

    for match in CREDENTIAL_ASSIGNMENT_PATTERN.finditer(text):
        value = match.group(1).casefold()
        if not any(marker in value for marker in SAFE_ASSIGNMENT_MARKERS):
            findings.append(f"{label}: possible plain-text credential assignment")

    for match in CLOUD_RESOURCE_URI_PATTERN.finditer(text):
        value = match.group(0).casefold()
        if not any(marker in value for marker in SAFE_TENANT_MARKERS):
            findings.append(f"{label}: possible tenant cloud resource reference")

    if AMPLIFY_ID_ASSIGNMENT_PATTERN.search(text):
        findings.append(f"{label}: possible Amplify app identifier")

    for match in ORGANIZATION_NAME_PATTERN.finditer(text):
        value = match.group(0).casefold()
        if not any(marker in value for marker in SAFE_TENANT_MARKERS):
            findings.append(f"{label}: possible organization name")

    return findings


def read_scanned_content() -> list[tuple[str, str]]:
    content: list[tuple[str, str]] = []
    paths = [*SCANNED_FILES, *sorted(BUILD_PORTALS_DIR.rglob("*"))]

    for path in paths:
        if path.is_file():
            content.append((str(path.relative_to(ROOT)), path.read_text("utf-8")))

    if README_PATH.is_file():
        hoopa_rows = [
            line
            for line in README_PATH.read_text("utf-8").splitlines()
            if "hoopa" in line.casefold()
        ]
        content.append(("README.md (Hoopa rows)", "\n".join(hoopa_rows)))

    return content


def added_diff_content() -> str:
    commands = (
        ["git", "diff", "--cached", "--unified=0", "--", *relative_targets()],
        ["git", "diff", "--unified=0", "--", *relative_targets()],
    )
    additions: list[str] = []

    for command in commands:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        additions.extend(
            line[1:]
            for line in result.stdout.splitlines()
            if line.startswith("+") and not line.startswith("+++")
        )

    return "\n".join(additions)


def relative_targets() -> list[str]:
    return [
        "agents/hoopa.md",
        "agents-copilot/hoopa.agent.md",
        ".codex/agents/hoopa.toml",
        "skills/build-portals",
        "README.md",
    ]


def self_test() -> None:
    customer_url_fixture = "Reference: https://customer-portal.invalid/sign-in"
    if not scan_text("customer URL fixture", customer_url_fixture, ()):
        raise AssertionError("scanner self-test failed to reject a customer URL")

    credential_fixture = 'password = "' + "fixture" + "-real-value" + '"'
    findings = scan_text("credential fixture", credential_fixture, ())
    if not any("credential assignment" in finding for finding in findings):
        raise AssertionError("scanner self-test failed to reject a credential")

    resource_fixture = "dataset = s3://tenant-prod/customer-records.json"
    if not scan_text("resource fixture", resource_fixture, ()):
        raise AssertionError("scanner self-test failed to reject a cloud resource")

    organization_fixture = "Customer: Acme Debt Holdings"
    if not scan_text("organization fixture", organization_fixture, ()):
        raise AssertionError("scanner self-test failed to reject an organization")


def main() -> int:
    self_test()
    literals = configured_literals()
    findings: list[str] = []

    for label, text in read_scanned_content():
        findings.extend(scan_text(label, text, literals))

    diff = added_diff_content()
    if diff:
        findings.extend(scan_text("current git diff additions", diff, literals))

    if findings:
        for finding in sorted(set(findings)):
            print(f"sanitization failed: {finding}", file=sys.stderr)
        return 1

    print("build-portals sanitization passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

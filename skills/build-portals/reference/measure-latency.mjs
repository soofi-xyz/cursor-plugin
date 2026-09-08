#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const API_URL = normalizeApiUrl(requireEnv('API_URL'), 'API_URL');
const EXPECTED_API_URL = normalizeApiUrl(
  requireEnv('EXPECTED_API_URL'),
  'EXPECTED_API_URL',
);
if (API_URL !== EXPECTED_API_URL) {
  throw new Error('API_URL must match the recorded EXPECTED_API_URL');
}

const DATASET_PATH = requireEnv('DATASET_PATH');
const REQUEST_COUNT = parsePositiveInteger(
  requireEnv('REQUEST_COUNT'),
  'REQUEST_COUNT',
);
const outputPath = process.env.LATENCY_OUTPUT_PATH;
const allowMutatingRequests = process.env.ALLOW_MUTATING_REQUESTS === 'true';
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const dataset = JSON.parse(await readFile(DATASET_PATH, 'utf8'));
if (!Array.isArray(dataset) || dataset.length === 0) {
  throw new Error('DATASET_PATH must contain a non-empty JSON array');
}

const durations = [];
let failedResponses = 0;

for (let index = 0; index < REQUEST_COUNT; index += 1) {
  const request = dataset[index % dataset.length];
  validateRequest(request, index % dataset.length);
  const method = (request.method ?? 'GET').toUpperCase();
  if (mutatingMethods.has(method) && !allowMutatingRequests) {
    throw new Error(
      `dataset request ${index % dataset.length} uses ${method}; set ` +
        'ALLOW_MUTATING_REQUESTS=true only for an approved synthetic/test target',
    );
  }

  const headers = new Headers(request.headers ?? {});
  for (const [headerName, envName] of Object.entries(request.headerEnv ?? {})) {
    headers.set(headerName, requireEnv(envName));
  }
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(10_000),
  };

  if (request.body !== undefined) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    init.body =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);
  }

  const startedAt = performance.now();
  const response = await fetch(`${API_URL}${request.path}`, init);
  await response.arrayBuffer();
  durations.push(performance.now() - startedAt);

  if (!response.ok) {
    failedResponses += 1;
  }
}

const sortedDurations = durations.toSorted
  ? durations.toSorted((left, right) => left - right)
  : [...durations].sort((left, right) => left - right);
const p95Index = Math.ceil(sortedDurations.length * 0.95) - 1;
const p95 = sortedDurations[p95Index];

const evidence = {
  apiUrl: API_URL,
  datasetPath: DATASET_PATH,
  requestCount: REQUEST_COUNT,
  failedResponses,
  p95Ms: round(p95),
  minMs: round(sortedDurations[0]),
  maxMs: round(sortedDurations.at(-1)),
  meanMs: round(
    durations.reduce((total, duration) => total + duration, 0) /
      durations.length,
  ),
  thresholdMs: 200,
  passed: failedResponses === 0 && p95 < 200,
  measuredAt: new Date().toISOString(),
};

const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
process.stdout.write(serializedEvidence);
if (outputPath) {
  await writeFile(outputPath, serializedEvidence, 'utf8');
}

if (failedResponses > 0) {
  process.stderr.write(`${failedResponses} API responses were not successful\n`);
  process.exitCode = 1;
} else if (p95 >= 200) {
  process.stderr.write(`p95 ${round(p95)} ms must be below 200 ms\n`);
  process.exitCode = 1;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeApiUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} cannot contain credentials, query, or fragment`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function validateRequest(request, index) {
  if (
    request === null ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    throw new Error(`dataset request ${index} must be an object`);
  }
  if (typeof request.path !== 'string' || !request.path.startsWith('/')) {
    throw new Error(`dataset request ${index}.path must start with "/"`);
  }
  if (request.path.startsWith('//')) {
    throw new Error(`dataset request ${index}.path cannot be protocol-relative`);
  }
  if (
    request.method !== undefined &&
    (typeof request.method !== 'string' ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
        request.method.toUpperCase(),
      ))
  ) {
    throw new Error(`dataset request ${index}.method is not supported`);
  }
  if (
    request.headerEnv !== undefined &&
    (request.headerEnv === null ||
      typeof request.headerEnv !== 'object' ||
      Array.isArray(request.headerEnv))
  ) {
    throw new Error(`dataset request ${index}.headerEnv must be an object`);
  }
  for (const [headerName, envName] of Object.entries(request.headerEnv ?? {})) {
    if (!headerName || typeof envName !== 'string' || !envName) {
      throw new Error(
        `dataset request ${index}.headerEnv must map header names to environment variable names`,
      );
    }
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

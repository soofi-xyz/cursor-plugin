import { createHash } from "node:crypto";

import { BlackHoleBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";

function canonicalize(value) {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8");
}

export async function computeUnixFsCid(body) {
  let result = null;
  for await (const entry of importer(
    [{ content: body }],
    new BlackHoleBlockstore(),
    {
      cidVersion: 0,
      rawLeaves: false,
      reduceSingleLeafToSelf: true,
    },
  )) {
    result = entry.cid.toString();
  }
  if (result === null) throw new Error("UnixFS importer produced no CID");
  return result;
}

export async function contentReceipt(value) {
  const body = canonicalJsonBuffer(value);
  return {
    body,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    cid: await computeUnixFsCid(body),
  };
}

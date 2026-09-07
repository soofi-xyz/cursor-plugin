import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  getVerifiedJson,
  putImmutableJson,
} from "../src/batch/s3-integrity.js";

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
}

function memoryS3(): S3Client {
  const objects = new Map<string, StoredObject>();
  return {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const key = `${command.input.Bucket}/${command.input.Key}`;
        if (objects.has(key)) {
          const error = new Error("precondition");
          Object.assign(error, { $metadata: { httpStatusCode: 412 } });
          throw error;
        }
        const body = Buffer.from(command.input.Body as Uint8Array);
        objects.set(key, {
          body,
          metadata: command.input.Metadata ?? {},
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const value = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (!value) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return {
          Body: {
            transformToByteArray: async () => value.body,
          },
          Metadata: value.metadata,
        };
      }
      if (command instanceof HeadObjectCommand) {
        const value = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (!value) throw Object.assign(new Error("missing"), { name: "NotFound" });
        return {
          ContentLength: value.body.length,
          Metadata: value.metadata,
        };
      }
      throw new Error("unsupported command");
    },
  } as unknown as S3Client;
}

describe("immutable S3 JSON integrity", () => {
  it("writes create-only canonical JSON and accepts an identical replay", async () => {
    const client = memoryS3();
    const receipt = await putImmutableJson(
      client,
      "bucket",
      "requests/digest/request.json",
      { second: 2, first: 1 },
    );
    const replay = await putImmutableJson(
      client,
      "bucket",
      "requests/digest/request.json",
      { second: 2, first: 1 },
    );

    expect(replay).toEqual(receipt);
    await expect(
      getVerifiedJson(
        client,
        "bucket",
        "requests/digest/request.json",
        receipt.sha256,
      ),
    ).resolves.toEqual({ first: 1, second: 2 });
  });
});

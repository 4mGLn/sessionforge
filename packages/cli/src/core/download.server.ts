import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

/**
 * Fetches a URL and streams it to disk, verifying the transferred byte count against the response's own
 * Content-Length (when the server sends one) before treating the write as successful — a connection reset
 * or truncated proxy response can otherwise leave a corrupt, incomplete file on disk that still looks like
 * a normal successful download to a caller that only checked `response.ok`. Shared by
 * `paseo-wire.server.ts` (plugin archive) and `update.server.ts` (CLI binary) since both hand their result
 * straight to something high-stakes: `paseo plugin install` or replacing the running executable.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }

  const expectedLength = response.headers.get("content-length");
  let receivedBytes = 0;
  const countBytes = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), countBytes, createWriteStream(destPath));

  if (expectedLength !== null && receivedBytes !== Number(expectedLength)) {
    throw new Error(`Download incomplete: expected ${expectedLength} bytes, got ${receivedBytes} (${url})`);
  }
}

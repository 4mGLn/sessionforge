import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "./download.server.js";

describe("downloadFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-download-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("writes the response body to the destination path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello world", { status: 200 })),
    );

    const destPath = join(root, "file.bin");
    await downloadFile("https://example.com/file.bin", destPath);

    expect(await readFile(destPath, "utf8")).toBe("hello world");
  });

  it("throws with the status when the request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
    );

    await expect(downloadFile("https://example.com/file.bin", join(root, "file.bin"))).rejects.toThrow(/404/);
  });

  it("succeeds silently when the server sends no Content-Length to check against", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no length header on this one", { status: 200 })),
    );

    await expect(downloadFile("https://example.com/file.bin", join(root, "file.bin"))).resolves.toBeUndefined();
  });

  it("throws when fewer bytes arrive than the server's own Content-Length promised — a truncated transfer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("short", { status: 200, headers: { "content-length": "9999" } })),
    );

    await expect(downloadFile("https://example.com/file.bin", join(root, "file.bin"))).rejects.toThrow(/incomplete/i);
  });

  it("succeeds when the transferred bytes match a real Content-Length", async () => {
    const body = "exact content";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-length": String(Buffer.byteLength(body)) } })),
    );

    const destPath = join(root, "file.bin");
    await downloadFile("https://example.com/file.bin", destPath);

    expect(await readFile(destPath, "utf8")).toBe(body);
  });
});

import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { AuditService, binaryUrl, DEFAULT_DUCKDB_VERSION, parseDescriptor, readBinaryMetadata } from "./service";

function binaryFooter() {
  const footer = Buffer.alloc(512);
  footer.write("abc1234", 128);
  footer.write("v1.5.5", 160);
  footer.write("linux_amd64", 192);
  footer.write("4", 224);
  return Buffer.concat([Buffer.from("binary payload"), footer]);
}

describe("community extension metadata", () => {
  test("parses an EOF repo section and applies platform settings", () => {
    const descriptor = `extension:\n  name: demo\n  description: Demo extension\n  excluded_platforms: wasm_mvp;osx_amd64\n  opt_in_platforms: windows_arm64\nrepo:\n  github: duckdb/demo\n  ref: abc1234`;
    expect(parseDescriptor(descriptor)).toEqual({
      name: "demo",
      description: "Demo extension",
      repo: "duckdb/demo",
      ref: "abc1234",
      platforms: ["linux_amd64", "linux_arm64", "osx_arm64", "windows_amd64", "windows_amd64_mingw", "windows_arm64"],
    });
  });


  test.each([["gzip", gzipSync(binaryFooter()), false], ["brotli", brotliCompressSync(binaryFooter()), true]] as const)("reads the %s binary footer", async (_format, bytes, isWasm) => {
    await expect(readBinaryMetadata(new Response(bytes), isWasm)).resolves.toEqual({
      extensionVersion: "abc1234",
      duckdbVersion: "v1.5.5",
      platform: "linux_amd64",
    });
  });

  test("reads a raw WASM artifact served as application/wasm", async () => {
    const footer = binaryFooter().subarray(-512);
    const bytes = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.alloc(64), footer]);
    await expect(readBinaryMetadata(new Response(bytes, { headers: { "content-type": "application/wasm" } }), true)).resolves.toEqual({
      extensionVersion: "abc1234",
      duckdbVersion: "v1.5.5",
      platform: "linux_amd64",
    });
  });

  test("builds binary URLs with a wasm suffix for wasm platforms", () => {
    expect(binaryUrl("v1.5.5", "linux_amd64", "demo")).toBe("https://community-extensions.duckdb.org/v1.5.5/linux_amd64/demo.duckdb_extension.gz");
    expect(binaryUrl("v1.5.5", "wasm_mvp", "demo")).toBe("https://community-extensions.duckdb.org/v1.5.5/wasm_mvp/demo.duckdb_extension.wasm");
  });

  test("resolveDuckdbVersion prefers explicit versions and rejects malformed ones", async () => {
    const service = new AuditService((() => {
      throw new Error("must not hit the network");
    }) as unknown as typeof fetch);
    await expect(service.resolveDuckdbVersion("v1.5.5")).resolves.toBe("v1.5.5");
    await expect(service.resolveDuckdbVersion("nope")).rejects.toThrow();
  });

  test("resolveDuckdbVersion caches the latest stable release", async () => {
    let calls = 0;
    const service = new AuditService((async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }) as unknown as typeof fetch);
    await expect(service.resolveDuckdbVersion()).resolves.toBe("v9.9.9");
    await expect(service.resolveDuckdbVersion()).resolves.toBe("v9.9.9");
    expect(calls).toBe(1);
  });

  test("resolveDuckdbVersion falls back when the release lookup fails", async () => {
    const service = new AuditService((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    await expect(service.resolveDuckdbVersion()).resolves.toBe(DEFAULT_DUCKDB_VERSION);
  });
});

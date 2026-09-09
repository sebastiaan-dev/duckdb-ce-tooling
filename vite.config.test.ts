import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { parseDescriptor, readBinaryMetadata } from "./server/service";

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
});

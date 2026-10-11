import { createBrotliDecompress, createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { BinaryStatus, Extension } from "@ce-map/contracts";
import type { Cached, PersistentCache } from "./cache";

export const DEFAULT_DUCKDB_VERSION = "v1.5.5";
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const RELEASE_URL = "https://api.github.com/repos/duckdb/duckdb/releases/latest";
const VERSION_TTL = 60 * 60_000;

export function isDuckdbVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}
export const STANDARD_PLATFORMS = [
  "linux_amd64",
  "linux_arm64",
  "osx_amd64",
  "osx_arm64",
  "windows_amd64",
  "windows_amd64_mingw",
  "wasm_mvp",
] as const;
const OPT_IN_PLATFORMS = ["linux_amd64_musl", "linux_arm64_musl", "windows_arm64"] as const;
const RAW_ROOT = "https://raw.githubusercontent.com/duckdb/community-extensions";
const TREE_URL = "https://api.github.com/repos/duckdb/community-extensions/git/trees/main?recursive=1";

const BINARY_ROOT = "https://community-extensions.duckdb.org";

type DescriptorFields = Omit<Extension, "descriptorSha">;

export function binaryUrl(version: string, platform: string, name: string) {
  const suffix = platform.startsWith("wasm") ? "wasm" : "gz";
  return `${BINARY_ROOT}/${version}/${platform}/${name}.duckdb_extension.${suffix}`;
}

type TreeItem = { path: string; type: string; sha?: string };
type TreeResponse = { sha?: string; tree?: TreeItem[] };

export function parseDescriptor(source: string): DescriptorFields | null {
  const section = (name: string) => source.match(new RegExp(`^${name}:\\s*\\n([\\s\\S]*?)(?=^[a-z][\\w-]*:\\s*(?:\\n|$)|(?![\\s\\S]))`, "m"))?.[1] ?? "";
  const scalar = (body: string, key: string) => {
    const value = body.match(new RegExp(`^\\s{2}${key}:\\s*([^\\n#]+)`, "m"))?.[1];
    return value ? value.trim().replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, "$1$2") : "";
  };
  const extension = section("extension");
  const repo = section("repo");
  const name = scalar(extension, "name");
  const ref = scalar(repo, "ref");
  if (!name || !ref || !/^[\w.-]+$/.test(name) || !/^[0-9a-f]{7,40}$/i.test(ref)) return null;

  const excluded = new Set(scalar(extension, "excluded_platforms").split(";").filter(Boolean));
  const optedIn = new Set(scalar(extension, "opt_in_platforms").split(";").filter(Boolean));
  return {
    name,
    ref,
    repo: scalar(repo, "github"),
    description: scalar(extension, "description"),
    platforms: [...STANDARD_PLATFORMS, ...OPT_IN_PLATFORMS.filter((item) => optedIn.has(item))].filter((item) => !excluded.has(item)),
  };
}

export async function readBinaryMetadata(response: Response, isWasm: boolean) {
  if (!response.body) throw new Error("Binary response had no body");
  const rawWasm = isWasm && response.headers.get("content-type")?.includes("application/wasm");
  const decompressor = rawWasm ? null : isWasm ? createBrotliDecompress() : createGunzip();
  const source = Readable.fromWeb(response.body as never);
  source.on("error", (error) => decompressor?.destroy(error));
  const stream = rawWasm ? source : source.pipe(decompressor!);
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = value as Buffer;
    tail = chunk.length >= 512 ? chunk.subarray(-512) : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - 512)), chunk]);
  }
  if (tail.length !== 512) throw new Error("Binary metadata footer is incomplete");
  const field = (offset: number) => tail.subarray(offset, offset + 32).toString("utf8").replace(/\0.*$/s, "");
  if (field(224) !== "4") throw new Error("Unsupported binary metadata version");
  return { extensionVersion: field(128), duckdbVersion: field(160), platform: field(192) };
}

export class AuditService {
  private readonly catalogCache = new Map<string, Cached<Extension[]>>();
  private versionCache?: Cached<string>;
  private readonly statusCache = new Map<string, Cached<BinaryStatus>>();
  private readonly inFlightChecks = new Map<string, Promise<BinaryStatus>>();

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly persistence?: PersistentCache) {}

  async resolveDuckdbVersion(requested?: string): Promise<string> {
    if (requested !== undefined) {
      if (!isDuckdbVersion(requested)) throw new Error(`Unsupported DuckDB version "${requested}"`);
      return requested;
    }
    if (this.versionCache && this.versionCache.expires > Date.now()) return this.versionCache.data;
    try {
      const response = await this.fetcher(RELEASE_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ce-map" } });
      if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
      const release: unknown = await response.json();
      const tag = typeof release === "object" && release !== null && "tag_name" in release ? release.tag_name : undefined;
      if (!isDuckdbVersion(tag)) throw new Error("Release response had no valid tag");
      this.versionCache = { data: tag, expires: Date.now() + VERSION_TTL };
      return tag;
    } catch {
      return DEFAULT_DUCKDB_VERSION;
    }
  }

  async getCatalog(version: string, force = false): Promise<Extension[]> {
    if (!force) {
      const cached = this.catalogCache.get(version);
      if (cached && cached.expires > Date.now()) return cached.data;
    }
    if (!force && this.persistence) {
      const cached = await this.persistence.getCatalog(version);
      if (cached) {
        this.catalogCache.set(version, cached);
        return cached.data;
      }
    }
    const treeResponse = await this.fetcher(TREE_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ce-map" } });
    if (!treeResponse.ok) throw new Error(`GitHub catalog request failed (${treeResponse.status})`);
    const tree = (await treeResponse.json()) as TreeResponse;
    const snapshotSha = tree.sha;
    if (!snapshotSha || !/^[0-9a-f]{40}$/i.test(snapshotSha)) throw new Error("GitHub catalog response had no valid snapshot");
    const descriptors = tree.tree?.filter((item) => item.type === "blob" && /^extensions\/[^/]+\/description\.yml$/.test(item.path)).map((item) => {
      return item.sha && /^[0-9a-f]{40}$/i.test(item.sha) ? { path: item.path, descriptorSha: item.sha } : null;
    }).filter((item): item is { path: string; descriptorSha: string } => item !== null) ?? [];
    const results: Extension[] = [];
    for (let offset = 0; offset < descriptors.length; offset += 24) {
      const batch = await Promise.all(descriptors.slice(offset, offset + 24).map(async ({ path, descriptorSha }): Promise<Extension | null> => {
        const response = await this.fetcher(`${RAW_ROOT}/${snapshotSha}/${path}`);
        if (!response.ok) return null;
        const descriptor = parseDescriptor(await response.text());
        return descriptor ? { ...descriptor, descriptorSha, descriptorPath: path } : null;
      }));
      results.push(...batch.filter((item): item is Extension => item !== null));
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    const cached = { data: results, expires: Date.now() + 5 * 60_000 };
    this.catalogCache.set(version, cached);
    if (this.persistence) await this.persistence.saveCatalog(version, results, cached.expires);
    return cached.data;
  }

  async checkBinary(extension: Extension, platform: string, version: string): Promise<BinaryStatus> {
    const key = `${version}/${platform}/${extension.name}/${extension.ref}/${extension.descriptorSha}`;
    const cached = this.statusCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    const inFlight = this.inFlightChecks.get(key);
    if (inFlight) return inFlight;

    const request = (async () => {
      if (this.persistence) {
        const cached = await this.persistence.getBinary({
          version,
          platform,
          extension: extension.name,
          ref: extension.ref,
          descriptorSha: extension.descriptorSha,
        });
        if (cached) {
          this.statusCache.set(key, cached);
          return cached.data;
        }
      }
      const checkedAt = new Date().toISOString();
      const isWasm = platform.startsWith("wasm");
      const url = binaryUrl(version, platform, extension.name);
      let data: BinaryStatus;
      try {
        const head = await this.fetcher(url, { method: "HEAD" });
        if (head.status === 404) {
          data = { status: "missing", checkedDescriptorRef: extension.ref, checkedDescriptorSha: extension.descriptorSha, checkedAt, binaryUrl: url, detail: "No deployed binary" };
        } else if (!head.ok && head.status !== 405) {
          data = { status: "error", checkedDescriptorRef: extension.ref, checkedDescriptorSha: extension.descriptorSha, checkedAt, binaryUrl: url, detail: `Registry returned HTTP ${head.status}` };
        } else {
          const response = await this.fetcher(url);
          if (response.status === 404) {
            data = { status: "missing", checkedDescriptorRef: extension.ref, checkedDescriptorSha: extension.descriptorSha, checkedAt, binaryUrl: url, detail: "No deployed binary" };
          } else if (!response.ok) {
            data = { status: "error", checkedDescriptorRef: extension.ref, checkedDescriptorSha: extension.descriptorSha, checkedAt, binaryUrl: url, detail: `Registry returned HTTP ${response.status}` };
          } else {
            const metadata = await readBinaryMetadata(response, isWasm);
            const current = extension.ref.startsWith(metadata.extensionVersion) || metadata.extensionVersion.startsWith(extension.ref);
            data = {
              status: current ? "current" : "stale",
              checkedDescriptorRef: extension.ref,
              checkedDescriptorSha: extension.descriptorSha,
              binaryUrl: url,
              builtRef: metadata.extensionVersion,
              duckdbVersion: metadata.duckdbVersion,
              platform: metadata.platform,
              size: Number(head.headers.get("content-length") || response.headers.get("content-length")) || undefined,
              checkedAt,
            };
          }
        }
      } catch (error) {
        data = { status: "error", checkedDescriptorRef: extension.ref, checkedDescriptorSha: extension.descriptorSha, checkedAt, binaryUrl: url, detail: error instanceof Error ? error.message : "Binary check failed" };
      }
      const cached = { data, expires: Date.now() + 30 * 60_000 };
      this.statusCache.set(key, cached);
      if (this.persistence) await this.persistence.saveBinary({
        version,
        platform,
        extension: extension.name,
        ref: extension.ref,
        descriptorSha: extension.descriptorSha,
      }, data, cached.expires);
      return data;
    })();

    this.inFlightChecks.set(key, request);
    try {
      return await request;
    } finally {
      this.inFlightChecks.delete(key);
    }
  }
}

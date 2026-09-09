import postgres from "postgres";
import type { BinaryStatus, Extension } from "./service";

export type Cached<T> = { expires: number; data: T };

export type PersistentCache = {
  getCatalog(version: string): Promise<Cached<Extension[]> | undefined>;
  saveCatalog(version: string, extensions: Extension[], expires: number): Promise<void>;
  getBinary(key: {
    version: string;
    platform: string;
    extension: string;
    ref: string;
    descriptorSha: string;
  }): Promise<Cached<BinaryStatus> | undefined>;
  saveBinary(key: {
    version: string;
    platform: string;
    extension: string;
    ref: string;
    descriptorSha: string;
  }, status: BinaryStatus, expires: number): Promise<void>;
};

type CatalogRow = { extensions: unknown; expires_at: Date | string };
type BinaryRow = { status: unknown; expires_at: Date | string };

function timestamp(value: Date | string) {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

export class PostgresCache implements PersistentCache {
  private readonly sql;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5, idle_timeout: 20 });
  }

  async initialize() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS ce_catalog_cache (
        duckdb_version text PRIMARY KEY,
        extensions jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS ce_binary_cache (
        duckdb_version text NOT NULL,
        platform text NOT NULL,
        extension_name text NOT NULL,
        extension_ref text NOT NULL,
        descriptor_sha text NOT NULL,
        status jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (duckdb_version, platform, extension_name, extension_ref, descriptor_sha)
      )
    `;
  }

  async getCatalog(version: string) {
    const [row] = await this.sql<CatalogRow[]>`
      SELECT extensions, expires_at
      FROM ce_catalog_cache
      WHERE duckdb_version = ${version} AND expires_at > now()
    `;
    if (!row || !Array.isArray(row.extensions)) return undefined;
    return { data: row.extensions as Extension[], expires: timestamp(row.expires_at) };
  }

  async saveCatalog(version: string, extensions: Extension[], expires: number) {
    await this.sql`
      INSERT INTO ce_catalog_cache (duckdb_version, extensions, expires_at, updated_at)
      VALUES (${version}, ${this.sql.json(extensions)}, ${new Date(expires)}, now())
      ON CONFLICT (duckdb_version) DO UPDATE SET
        extensions = EXCLUDED.extensions,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;
  }

  async getBinary(key: {
    version: string;
    platform: string;
    extension: string;
    ref: string;
    descriptorSha: string;
  }) {
    const [row] = await this.sql<BinaryRow[]>`
      SELECT status, expires_at
      FROM ce_binary_cache
      WHERE duckdb_version = ${key.version}
        AND platform = ${key.platform}
        AND extension_name = ${key.extension}
        AND extension_ref = ${key.ref}
        AND descriptor_sha = ${key.descriptorSha}
        AND expires_at > now()
    `;
    if (!row || !row.status || typeof row.status !== "object") return undefined;
    return { data: row.status as BinaryStatus, expires: timestamp(row.expires_at) };
  }

  async saveBinary(key: {
    version: string;
    platform: string;
    extension: string;
    ref: string;
    descriptorSha: string;
  }, status: BinaryStatus, expires: number) {
    await this.sql`
      INSERT INTO ce_binary_cache (
        duckdb_version, platform, extension_name, extension_ref, descriptor_sha,
        status, expires_at, updated_at
      )
      VALUES (
        ${key.version}, ${key.platform}, ${key.extension}, ${key.ref}, ${key.descriptorSha},
        ${this.sql.json(status)}, ${new Date(expires)}, now()
      )
      ON CONFLICT (duckdb_version, platform, extension_name, extension_ref, descriptor_sha) DO UPDATE SET
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }
}

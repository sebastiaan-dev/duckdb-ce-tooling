// Wire contract shared by @ce-map/api, @ce-map/web, and the future Rust CLI in
// crates/*. The HTTP paths and JSON shapes defined here are the CLI's
// consumption surface: adding or changing an endpoint means updating this file
// first, then the owner of each side.

export type Extension = {
  name: string;
  description: string;
  repo: string;
  ref: string;
  platforms: string[];
  descriptorSha: string;
  descriptorPath?: string;
};

export type BinaryState = "current" | "stale" | "missing" | "error";

export type BinaryStatus = {
  status: BinaryState;
  checkedDescriptorRef: string;
  checkedDescriptorSha: string;
  builtRef?: string;
  platform?: string;
  duckdbVersion?: string;
  size?: number;
  checkedAt: string;
  detail?: string;
  binaryUrl?: string;
};

export type CatalogResponse = {
  duckdbVersion: string;
  extensions: Extension[];
};

export const ApiPaths = {
  catalog: "/api/catalog",
  check: "/api/check",
} as const;

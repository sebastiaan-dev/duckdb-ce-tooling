import { Elysia, t } from "elysia";
import { ApiPaths } from "@ce-map/contracts";
import { AuditService } from "./service";

const versionQuery = t.Optional(t.String({ pattern: "^v\\d+\\.\\d+\\.\\d+$" }));

export function createApi(service = new AuditService()) {
  return new Elysia({ name: "community-extension-audit-api" })
    .get(ApiPaths.catalog, async ({ query }) => {
      const version = await service.resolveDuckdbVersion(query.duckdb);
      return {
        duckdbVersion: version,
        extensions: await service.getCatalog(version, query.refresh === "1"),
      };
    }, {
      query: t.Object({ refresh: t.Optional(t.Literal("1")), duckdb: versionQuery }),
    })
    .get(ApiPaths.check, async ({ query, set }) => {
      const version = await service.resolveDuckdbVersion(query.duckdb);
      const catalog = await service.getCatalog(version);
      const extension = catalog.find((item) => item.name === query.extension);
      if (!extension || !extension.platforms.includes(query.platform)) {
        set.status = 400;
        return { error: "Unknown extension or platform" };
      }
      return service.checkBinary(extension, query.platform, version);
    }, {
      query: t.Object({ extension: t.String(), platform: t.String(), duckdb: versionQuery }),
    })
    .onError(({ code, error, set }) => {
      set.status = code === "VALIDATION" ? 400 : 502;
      return { error: error instanceof Error ? error.message : "Upstream request failed" };
    });
}

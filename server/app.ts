import { Elysia, t } from "elysia";
import { AuditService, DUCKDB_VERSION } from "./service";

export function createApi(service = new AuditService()) {
  return new Elysia({ name: "community-extension-audit-api" })
    .get("/api/catalog", async ({ query }) => ({
      duckdbVersion: DUCKDB_VERSION,
      extensions: await service.getCatalog(query.refresh === "1"),
    }), {
      query: t.Object({ refresh: t.Optional(t.Literal("1")) }),
    })
    .get("/api/check", async ({ query, set }) => {
      const catalog = await service.getCatalog();
      const extension = catalog.find((item) => item.name === query.extension);
      if (!extension || !extension.platforms.includes(query.platform)) {
        set.status = 400;
        return { error: "Unknown extension or platform" };
      }
      return service.checkBinary(extension, query.platform);
    }, {
      query: t.Object({ extension: t.String(), platform: t.String() }),
    })
    .onError(({ code, error, set }) => {
      set.status = code === "VALIDATION" ? 400 : 502;
      return { error: error instanceof Error ? error.message : "Upstream request failed" };
    });
}

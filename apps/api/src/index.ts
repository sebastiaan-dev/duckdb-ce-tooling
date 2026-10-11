import { createApi } from "./app";
import { PostgresCache } from "./cache";
import { AuditService } from "./service";

const port = Number(process.env.PORT ?? "3001");
const hostname = process.env.HOST ?? "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://ce_map:ce_map@127.0.0.1:5432/ce_map";
const cache = new PostgresCache(databaseUrl);

try {
  await cache.initialize();
  const app = createApi(new AuditService(fetch, cache)).listen({ hostname, port });
  console.log(`Audit API listening on http://${hostname}:${app.server?.port ?? port}`);

  const shutdown = async () => {
    await app.stop();
    await cache.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  await cache.close();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

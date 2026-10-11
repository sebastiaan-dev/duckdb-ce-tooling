import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcess } from "node:child_process";
const apiPort = Number(process.env.CE_API_PORT ?? "3001");
const apiHost = process.env.CE_API_HOST ?? "127.0.0.1";
const childEnv = { ...process.env, HOST: apiHost, PORT: String(apiPort) };
const api = spawn(process.execPath, ["run", new URL("./index.ts", import.meta.url).pathname], { env: childEnv, stdio: "inherit" });
let web: ChildProcess | undefined;

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://${apiHost}:${apiPort}/`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Audit API did not start on ${apiHost}:${apiPort}`);
}

async function waitForExit(child: ChildProcess) {
  const [code] = await once(child, "exit");
  return (code as number | null) ?? 1;
}

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  web?.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await waitForApi();
  web = spawn(process.execPath, ["x", "vite", ...process.argv.slice(2)], { env: process.env, stdio: "inherit", cwd: new URL("../../web", import.meta.url).pathname });
  const exitCode = await waitForExit(web);
  shutdown();
  process.exit(exitCode);
} catch (error) {
  shutdown();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

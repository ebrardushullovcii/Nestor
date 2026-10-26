import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createServer } from "vite";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(path.dirname(packageRoot));
dotenv.config({
  path: path.join(repositoryRoot, ".env.local"),
  override: false,
});

const server = await createServer({
  root: packageRoot,
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const lane = await server.ssrLoadModule("/src/resume-lane/cli.ts");
  await lane.runResumeLaneCli(process.argv.slice(2));
} finally {
  await server.close();
}

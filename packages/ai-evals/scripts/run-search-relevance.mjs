import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createServer } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.resolve(root, "../../.env.local"), override: false });
const server = await createServer({
  root, logLevel: "silent", server: { middlewareMode: true }, appType: "custom",
});
try {
  const { runSearchRelevanceCli } = await server.ssrLoadModule("/src/search-relevance/cli.ts");
  await runSearchRelevanceCli(process.argv.slice(2), root);
} finally {
  await server.close();
}

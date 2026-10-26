import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
async function load(run) {
  const server = await createServer({
    root: packageRoot,
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    return await run(
      await server.ssrLoadModule("/src/assistant-outcomes/run.ts"),
    );
  } finally {
    await server.close();
  }
}
export default async function journey(ctx) {
  return load(async (module) => {
    const options = JSON.parse(ctx.args[0] ?? "{}");
    const report = await module.run(ctx, options);
    if (!report.passed)
      throw Error(
        `Outcome eval has gaps: ${JSON.stringify(report.counts)}. Full map and evidence are in ${ctx.evidenceDir}`,
      );
    return report.counts;
  });
}
if (process.argv[2] === "--list") await load((module) => module.list());

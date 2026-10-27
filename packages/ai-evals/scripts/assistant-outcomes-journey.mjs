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
if (process.argv[2] === "--merge") {
  const server = await createServer({
    root: packageRoot,
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/assistant-outcomes/merge.ts",
    );
    const report = await module.merge(JSON.parse(process.argv[3]));
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await server.close();
  }
}

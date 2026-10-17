import { spawn, execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const output = await mkdtemp(join(tmpdir(), "nordri-embedded-browser-test-"));
const discoveryCleanup = process.argv.includes("--discovery-cleanup");
await build({
  configFile: false,
  root: desktop,
  logLevel: "warn",
  plugins: [
    {
      name: "external-runtime-dependencies",
      enforce: "pre",
      resolveId(source, importer) {
        if (isBuiltin(source) || source === "electron")
          return { id: source, external: true };
        if (
          !importer ||
          source.startsWith(".") ||
          source.startsWith("/") ||
          source.startsWith("\0") ||
          /^[A-Za-z]:/.test(source) ||
          source.startsWith("@nordri/")
        )
          return null;
        return { id: createRequire(importer).resolve(source), external: true };
      },
    },
  ],
  resolve: {
    alias: {
      playwright: require.resolve("playwright"),
      ws: require.resolve("ws"),
    },
  },
  ssr: { noExternal: true },
  build: {
    ssr: join(
      desktop,
      discoveryCleanup
        ? "scripts/fixtures/embedded-browser-discovery-cleanup.ts"
        : "scripts/fixtures/embedded-browser.ts",
    ),
    outDir: output,
    emptyOutDir: false,
    rollupOptions: {
      external: [
        "electron",
        require.resolve("playwright"),
        require.resolve("ws"),
      ],
      output: { format: "cjs", entryFileNames: "probe.cjs" },
    },
  },
});
const env = { ...process.env, EMBEDDED_BROWSER_TEST_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(output, "probe.cjs")], {
  env,
  windowsHide: true,
  stdio: "inherit",
});
console.log(`Embedded browser fixture PID ${child.pid}; output: ${output}`);
const timeout = setTimeout(() => {
  console.error(
    "Embedded browser fixture timed out; stopping only its own process tree.",
  );
  if (child.pid && process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else child.kill();
}, 60_000);
child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});

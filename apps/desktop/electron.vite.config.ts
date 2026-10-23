import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "electron-vite";
import type { PluginOption, UserConfig as ViteUserConfig } from "vite";
import {
  devBuildCache,
  hashFiles,
  listBuildKeyFiles,
  readDevBuildFlags,
  skipTargetTranspilePlugin,
} from "./scripts/dev-build-cache";
import { withReactRefreshCache } from "./scripts/dev-react-refresh-cache";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const devCacheDir = path.resolve(currentDir, "node_modules/.cache/nestor-dev");
const configFile = fileURLToPath(import.meta.url);
const devHelperFiles = [
  path.resolve(currentDir, "scripts/dev-build-cache.ts"),
  path.resolve(currentDir, "scripts/dev-react-refresh-cache.ts"),
];
const aiProvidersPath = path.resolve(
  currentDir,
  "../../packages/ai-providers/src/index.ts",
);
const browserAgentPath = path.resolve(
  currentDir,
  "../../packages/browser-agent/src/index.ts",
);
const browserRuntimePath = path.resolve(
  currentDir,
  "../../packages/browser-runtime/src/index.ts",
);
const contractsPath = path.resolve(
  currentDir,
  "../../packages/contracts/src/index.ts",
);
const corePath = path.resolve(currentDir, "../../packages/core/src/index.ts");
const dbPath = path.resolve(currentDir, "../../packages/db/src/index.ts");
const liveAssistantPath = path.resolve(
  currentDir,
  "../../packages/live-assistant/src/index.ts",
);
const jobFinderDiscoveryOrderingPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/discovery-ordering.ts",
);
const jobFinderDiscoveryResultBandsPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/discovery-result-bands.ts",
);
const jobFinderPlanSafeguardPausesPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/plan-safeguard-pauses.ts",
);
const jobFinderResumeRecordIdentityPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/resume-record-identity.ts",
);
const jobFinderResumeIdentityPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/internal/resume-identity.ts",
);
const jobFinderApplyRunRecoveryPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/internal/workspace-apply-run-recovery.ts",
);
const jobFinderSourceHealthPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/source-health.ts",
);
const jobFinderApplicationSubmissionRuntimeMainPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/application-submission-runtime-main.ts",
);
const jobFinderPath = path.resolve(
  currentDir,
  "../../packages/job-finder/src/index.ts",
);
const knowledgeBasePath = path.resolve(
  currentDir,
  "../../packages/knowledge-base/src/index.ts",
);
const osIntegrationPath = path.resolve(
  currentDir,
  "../../packages/os-integration/src/index.ts",
);

const workspaceAliases = {
  "@nestor/ai-providers": aiProvidersPath,
  "@nestor/browser-agent": browserAgentPath,
  "@nestor/browser-runtime": browserRuntimePath,
  "@nestor/contracts": contractsPath,
  "@nestor/core": corePath,
  "@nestor/db": dbPath,
  "@nestor/live-assistant": liveAssistantPath,
  "@nestor/job-finder/assistant-attention": path.resolve(
    currentDir,
    "../../packages/job-finder/src/assistant/attention.ts",
  ),
  "@nestor/job-finder/discovery-ordering": jobFinderDiscoveryOrderingPath,
  "@nestor/job-finder/discovery-result-bands":
    jobFinderDiscoveryResultBandsPath,
  "@nestor/job-finder/resume-record-identity":
    jobFinderResumeRecordIdentityPath,
  "@nestor/job-finder/resume-identity": jobFinderResumeIdentityPath,
  "@nestor/job-finder/apply-run-recovery": jobFinderApplyRunRecoveryPath,
  "@nestor/job-finder/source-health": jobFinderSourceHealthPath,
  "@nestor/job-finder/plan-safeguard-pauses": jobFinderPlanSafeguardPausesPath,
  "@nestor/job-finder": jobFinderPath,
  "@nestor/knowledge-base": knowledgeBasePath,
  "@nestor/os-integration": osIntegrationPath,
};

const mainWorkspaceAliases = {
  "@nestor/job-finder/discovery-cpu": path.resolve(
    currentDir,
    "../../packages/job-finder/src/discovery-cpu.ts",
  ),
  ...workspaceAliases,
  "@nestor/job-finder/application-submission-runtime-main":
    jobFinderApplicationSubmissionRuntimeMainPath,
};

const mainConfig = {
  resolve: {
    alias: mainWorkspaceAliases,
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(currentDir, "src/main/index.ts"),
        "discovery-cpu-worker": path.resolve(
          currentDir,
          "src/main/services/job-finder/discovery-cpu-worker.ts",
        ),
      },
      external: [
        "playwright",
        "playwright-core",
        "chromium-bidi",
        "jsdom",
        "@mozilla/readability",
        // Bundling ws turns its optional native `bufferutil` require into an
        // empty module, so masked frames over 48 bytes from the CDP client
        // crash main ("bufferUtil.unmask is not a function"). Load it as
        // the installed dependency instead.
        "ws",
      ],
      output: {
        format: "cjs" as const,
        entryFileNames: "[name].cjs",
        chunkFileNames: "[name]-[hash].cjs",
      },
    },
  },
} satisfies ViteUserConfig;

const preloadConfig = {
  resolve: {
    alias: workspaceAliases,
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(currentDir, "src/preload/index.ts"),
        // Bridge-free page preload for the embedded browser (ADR 0017).
        "browser-page": path.resolve(currentDir, "src/preload/browser-page.ts"),
      },
      output: {
        format: "cjs" as const,
        entryFileNames: "[name].cjs",
        chunkFileNames: "[name]-[hash].cjs",
      },
    },
  },
} satisfies ViteUserConfig;

// `pnpm desktop:dev` only. The main and preload bundles are reused from the
// last dev start when nothing they are built from changed, and otherwise
// built without the production-only syntax pass. The renderer keeps its
// Fast Refresh compile output between starts.
function devConfig(mode: string): UserConfig {
  const flags = readDevBuildFlags(mode);
  const bundleKey = hashFiles(
    [configFile, ...devHelperFiles, ...listBuildKeyFiles(currentDir)],
    flags.key,
  );
  const devBundle = (name: string, config: ViteUserConfig) => {
    const cache = devBuildCache({
      name,
      cacheDir: devCacheDir,
      key: bundleKey,
    });
    if (cache.reusable && !flags.watch) {
      console.log(
        `Reusing the ${name} bundle from the last dev start: nothing it is built from changed.`,
      );
      return null;
    }
    return { ...config, plugins: [cache.plugin, skipTargetTranspilePlugin] };
  };
  const main = devBundle("main", mainConfig);
  const preload = devBundle("preload", preloadConfig);
  const reactPlugins = withReactRefreshCache(react(), {
    cacheFile: path.join(devCacheDir, "react-refresh-transforms.json"),
    namespace: hashFiles(
      [
        path.resolve(currentDir, "../../pnpm-lock.yaml"),
        configFile,
        ...devHelperFiles,
      ],
      "react-refresh",
    ),
  });
  return {
    ...(main ? { main } : {}),
    ...(preload ? { preload } : {}),
    renderer: rendererConfig([tailwindcss(), ...reactPlugins]),
  };
}

export default defineConfig(({ command, mode }) =>
  command === "serve"
    ? devConfig(mode)
    : {
        main: mainConfig,
        preload: preloadConfig,
        renderer: rendererConfig([tailwindcss(), react()]),
      },
);

function rendererConfig(plugins: PluginOption[]): ViteUserConfig {
  return {
    resolve: {
      alias: {
        ...workspaceAliases,
        "@renderer": path.resolve(currentDir, "src/renderer/src"),
      },
    },
    plugins,
    // electron-vite leaves the renderer unminified. Loading that 4.5 MB
    // bundle kept the window blank for about a second on every cold start;
    // minified it paints about a second sooner. Names stay as written so
    // error stacks still read, and the stylesheet is left as Tailwind
    // writes it.
    build: {
      cssMinify: false,
      minify: "esbuild",
    },
    esbuild: {
      minifyIdentifiers: false,
    },
    // `pnpm desktop:dev` serves the renderer as a few hundred modules, each
    // compiled when the window first asks for it, six requests at a time.
    // Compiling the opening screen's module graph as soon as the server is up
    // overlaps that work with Electron starting, so the window is not left
    // waiting on it module by module.
    server: {
      warmup: {
        clientFiles: [
          "./src/main.tsx",
          "./src/features/job-finder/screens/job-search-home/job-search-home-screen.tsx",
        ],
      },
    },
  };
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nestor/job-list-policy/text": path.resolve(
        currentDir,
        "packages/job-list-policy/src/shared.ts",
      ),
      "@nestor/job-list-policy/identity": path.resolve(
        currentDir,
        "packages/job-list-policy/src/job-identity.ts",
      ),
      "@nestor/job-list-policy/tie-break-reason": path.resolve(
        currentDir,
        "packages/job-list-policy/src/tie-break-reason.ts",
      ),
      "@nestor/job-list-policy/ordering": path.resolve(
        currentDir,
        "packages/job-list-policy/src/ordering.ts",
      ),
      "@nestor/job-list-policy/sources": path.resolve(
        currentDir,
        "packages/job-list-policy/src/sources.ts",
      ),
      "@nestor/job-list-policy": path.resolve(
        currentDir,
        "packages/job-list-policy/src/index.ts",
      ),
      "@nestor/ai-providers": path.resolve(
        currentDir,
        "packages/ai-providers/src/index.ts",
      ),
      "@renderer": path.resolve(currentDir, "apps/desktop/src/renderer/src"),
      "@nestor/browser-agent/listing-detail-extraction": path.resolve(currentDir, "packages/browser-agent/src/search/listing-detail-extraction.ts"),
      "@nestor/browser-agent": path.resolve(
        currentDir,
        "packages/browser-agent/src/index.ts",
      ),
      "@nestor/browser-runtime": path.resolve(
        currentDir,
        "packages/browser-runtime/src/index.ts",
      ),
      "@nestor/contracts": path.resolve(
        currentDir,
        "packages/contracts/src/index.ts",
      ),
      "@nestor/db/applications": path.resolve(
        currentDir,
        "packages/db/src/job-store/applications.ts",
      ),
      "@nestor/db/job-store": path.resolve(
        currentDir,
        "packages/db/src/job-store/job-store.ts",
      ),
      "@nestor/db": path.resolve(currentDir, "packages/db/src/index.ts"),
      "@nestor/job-finder/assistant-attention": path.resolve(
        currentDir,
        "packages/job-finder/src/assistant/attention.ts",
      ),
      "@nestor/job-finder/discovery-cpu": path.resolve(
        currentDir,
        "packages/job-finder/src/discovery-cpu.ts",
      ),
      "@nestor/job-finder/discovery-ordering": path.resolve(
        currentDir,
        "packages/job-finder/src/discovery-ordering.ts",
      ),
      "@nestor/job-finder/discovery-result-bands": path.resolve(
        currentDir,
        "packages/job-finder/src/discovery-result-bands.ts",
      ),
      "@nestor/job-finder/resume-record-identity": path.resolve(
        currentDir,
        "packages/job-finder/src/resume-record-identity.ts",
      ),
      "@nestor/job-finder/plan-safeguard-pauses": path.resolve(
        currentDir,
        "packages/job-finder/src/plan-safeguard-pauses.ts",
      ),
      "@nestor/job-finder/resume-identity": path.resolve(
        currentDir,
        "packages/job-finder/src/internal/resume-identity.ts",
      ),
      "@nestor/job-finder/apply-run-recovery": path.resolve(
        currentDir,
        "packages/job-finder/src/internal/workspace-apply-run-recovery.ts",
      ),
      "@nestor/job-finder/source-health": path.resolve(
        currentDir,
        "packages/job-finder/src/source-health.ts",
      ),
      "@nestor/job-finder/application-submission-runtime-main": path.resolve(
        currentDir,
        "packages/job-finder/src/application-submission-runtime-main.ts",
      ),
      "@nestor/job-finder": path.resolve(
        currentDir,
        "packages/job-finder/src/index.ts",
      ),
      "@nestor/knowledge-base": path.resolve(
        currentDir,
        "packages/knowledge-base/src/index.ts",
      ),
    },
  },
  test: {
    setupFiles: [path.resolve(currentDir, "apps/desktop/src/test/setup.ts")],
    include: ["**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.tmp/**",
      "**/apps/desktop/.tmp/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportOnFailure: true,
      include: [
        "apps/desktop/src/**/*.{js,jsx,mjs,cjs,ts,tsx}",
        "packages/*/src/**/*.{js,jsx,mjs,cjs,ts,tsx}",
      ],
      exclude: [
        "**/*.test.*",
        "**/*.d.*",
        "**/*fixtures.*",
        "**/test-fixtures/**",
        "**/.tmp/**",
        "**/coverage/**",
        "packages/job-finder/src/internal/workspace-discovery-ledger.performance.test.ts",
        "packages/job-finder/src/workspace-service.discovery-ledger-performance.test.ts",
      ],
    },
  },
});

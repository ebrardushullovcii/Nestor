import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptanceEnvironment } from "./release-acceptance-harness.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..", "..");
const providerSourcePath = path.join(
  repositoryRoot,
  "packages",
  "ai-providers",
  "src",
  "live-assistant.ts",
);
const captureScriptName = "capture-live-assistant.mjs";
const fastWrapperName = "capture-live-assistant-fast.mjs";

// Narrowly named live-AI opt-in for Live Assistant under the desktop test
// API. Must stay identical across the provider factory, the Live Assistant
// capture harness, and the release acceptance harness.
const OPT_IN_ENV = "NESTOR_INTERVIEW_TEST_USE_LIVE_AI";
const INTERVIEW_CREDENTIAL_NAMES = [
  "NESTOR_INTERVIEW_AI_API_KEY",
  "NESTOR_INTERVIEW_VISION_API_KEY",
];
const SHARED_CREDENTIAL_NAMES = [
  "NESTOR_AI_API_KEY",
  "NESTOR_AI_VISION_API_KEY",
  "NESTOR_RESUME_VISION_API_KEY",
];
const ALL_CREDENTIAL_NAMES = [
  ...INTERVIEW_CREDENTIAL_NAMES,
  ...SHARED_CREDENTIAL_NAMES,
];

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("release acceptance environment", () => {
  it("strips every ambient Live Assistant/shared credential and the live-AI opt-in so no ambient credential wins", () => {
    const poisonedNames = [
      ...ALL_CREDENTIAL_NAMES,
      // Future interview key variants must fall under the wildcard sweep.
      "NESTOR_INTERVIEW_TRANSCRIPTION_API_KEY",
      OPT_IN_ENV,
    ];
    const saved = new Map<string, string | undefined>();
    for (const name of poisonedNames) {
      saved.set(name, process.env[name]);
      process.env[name] = "ambient-secret";
    }
    try {
      const env = acceptanceEnvironment({
        NESTOR_USER_DATA_DIR: "/isolated/acceptance-user-data",
      });

      for (const name of poisonedNames) {
        expect(
          name in env,
          `${name} must never survive into the acceptance environment`,
        ).toBe(false);
      }
      expect(env.NESTOR_ENABLE_TEST_API).toBe("1");
      expect(env.NESTOR_BROWSER_AGENT).toBe("0");
      expect(env.NESTOR_USER_DATA_DIR).toBe(
        "/isolated/acceptance-user-data",
      );
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("pins its credential-stripping contract in source so refactors cannot silently drop it", async () => {
    const source = await readFile(
      path.join(scriptDir, "release-acceptance-harness.mjs"),
      "utf8",
    );

    expect(source).toContain(
      'ACCEPTANCE_INTERVIEW_CREDENTIAL_PREFIX = "NESTOR_INTERVIEW_"',
    );
    expect(source).toContain('ACCEPTANCE_CREDENTIAL_SUFFIX = "_API_KEY"');
    for (const name of SHARED_CREDENTIAL_NAMES) {
      expect(
        source.includes(`"${name}"`),
        `acceptanceEnvironment must strip shared credential ${name}`,
      ).toBe(true);
    }
    expect(source).toContain(`"${OPT_IN_ENV}"`);
  });
});

describe("Live Assistant capture harness provider defaults", () => {
  it("uses the typed apply-copilot preload action object", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );

    expect(source).toContain(
      'startApplyCopilotRun({\n        jobId: "job_ready",\n        visualCheckpointsEnabled: false,',
    );
    expect(source).not.toContain('startApplyCopilotRun("job_ready")');
  });

  it("defaults to deterministic providers instead of configured", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );

    expect(
      source.includes('process.env[PROVIDER_MODE_ENV] ?? "deterministic"'),
      "the capture harness must default UI_LIVE_ASSISTANT_PROVIDER_MODE to deterministic",
    ).toBe(true);
    expect(
      source.includes('Use "deterministic" (default) or "configured".'),
      "the capture harness must fail closed on unsupported provider-mode values",
    ).toBe(true);
  });

  it("blanks all interview and shared AI credentials in deterministic mode", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );

    const listStart = source.indexOf("const deterministicProviderEnv = {");
    const listEnd = source.indexOf("};", listStart);
    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);
    const blankList = source.slice(listStart, listEnd);
    for (const name of ALL_CREDENTIAL_NAMES) {
      expect(
        blankList.includes(`${name}: ""`),
        `deterministic mode must blank ${name}`,
      ).toBe(true);
    }
    expect(
      blankList.includes('NESTOR_INTERVIEW_LOCAL_STT_COMMAND: ""'),
    ).toBe(true);
  });

  it("enables the narrow live-AI opt-in only for explicitly requested configured mode and announces both modes", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );

    expect(source).toContain(`"${OPT_IN_ENV}"`);
    expect(source).toContain('[INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV]: "1"');
    expect(source).toContain('[INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV]: ""');
    expect(source).toContain(
      "Configured/live provider mode requested explicitly via",
      "configured mode must be announced as an explicit request",
    );
    expect(source).toContain(
      "Deterministic provider mode (default)",
      "deterministic mode must be announced as the default",
    );
  });

  it("applies the provider-mode app environment after the ambient environment", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );

    const launchIndex = source.indexOf("async function runCapture()");
    const envSpreadOrder = source
      .slice(launchIndex)
      .indexOf("...providerModeAppEnv,");
    const ambientIndex = source.slice(launchIndex).indexOf("...process.env,");
    expect(ambientIndex).toBeGreaterThan(-1);
    expect(envSpreadOrder).toBeGreaterThan(ambientIndex);
  });

  it("keeps the fast wrapper pinned to deterministic providers", async () => {
    const source = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", fastWrapperName),
    );

    expect(source).toContain(
      'process.env.UI_LIVE_ASSISTANT_PROVIDER_MODE = "deterministic";',
    );
  });
});

describe("Live Assistant test-API live-AI boundary consistency", () => {
  it("uses one narrowly named opt-in literal across the provider factory, capture harness, and acceptance harness", async () => {
    const providerSource = await readFile(providerSourcePath, "utf8");
    const captureSource = await readRepositoryFile(
      path.posix.join("apps", "desktop", "scripts", captureScriptName),
    );
    const harnessSource = await readFile(
      path.join(scriptDir, "release-acceptance-harness.mjs"),
      "utf8",
    );

    for (const [label, source] of [
      ["provider factory", providerSource],
      ["capture harness", captureSource],
      ["acceptance harness", harnessSource],
    ] as const) {
      expect(
        source.includes(`"${OPT_IN_ENV}"`),
        `${label} must reference the same ${OPT_IN_ENV} literal`,
      ).toBe(true);
    }
  });

  it("gates Live Assistant provider construction on the desktop test API flag", async () => {
    const providerSource = await readFile(providerSourcePath, "utf8");

    expect(providerSource).toContain('"NESTOR_ENABLE_TEST_API"');
    expect(providerSource).toContain(
      "Desktop test API forces deterministic Live Assistant AI providers",
    );
  });
});

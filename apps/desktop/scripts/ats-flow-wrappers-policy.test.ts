import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const WRAPPERS = {
  greenhouse: "test-job-finder-complete-flow.mjs",
  ashby: "test-job-finder-ashby-flow.mjs",
  workday: "test-job-finder-workday-flow.mjs",
} as const;

type WrapperName = keyof typeof WRAPPERS;

const OPT_IN_ENV = "JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC";
const AUTHORIZE_ENV = "JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES";

const POLICY_START = "const authorizedWriteDiagnostic";
const POLICY_END =
  "process.env.JOB_FINDER_PREPARE_ONLY_EXPECT_EXACT_SOURCE_JOB";

const LIMITATION_PHRASE =
  "resumeUploadVerified is not expected evidence" as const;

const SMOKE_SCRIPT = "test-job-finder-prepare-only.mjs";

async function readSmokeSource(): Promise<string> {
  return readFile(path.join(scriptDir, SMOKE_SCRIPT), "utf8");
}

async function readWrapper(name: WrapperName): Promise<string> {
  return readFile(path.join(scriptDir, WRAPPERS[name]), "utf8");
}

// The smoke auto-runs on import unless this variable is set; validation
// tooling uses the exported safety helpers without launching Electron.
async function loadSmokeModule() {
  process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN = "1";
  try {
    return await import("./test-job-finder-prepare-only.mjs");
  } finally {
    delete process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN;
  }
}

function extractPolicyBlock(source: string): string {
  const startIndex = source.indexOf(POLICY_START);
  const endIndex = source.indexOf(POLICY_END);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function applyPolicy(source: string, env: Record<string, string>) {
  const stdoutChunks: string[] = [];
  vm.runInNewContext(extractPolicyBlock(source), {
    process: {
      env,
      stdout: {
        write: (value: string) => {
          stdoutChunks.push(value);
        },
      },
    },
  });
  return { env, stdout: stdoutChunks.join("") };
}

describe.each(Object.keys(WRAPPERS) as WrapperName[])(
  "%s prepare-only acceptance wrapper",
  (name) => {
    it("defaults to strict prepare-only mode even with an ambient authorized-write value", async () => {
      const source = await readWrapper(name);
      const { env, stdout } = applyPolicy(source, {
        [AUTHORIZE_ENV]: "1",
        JOB_FINDER_PREPARE_ONLY_LABEL: "custom-label",
      });

      expect(env[AUTHORIZE_ENV]).toBe("0");
      expect(env.JOB_FINDER_PREPARE_ONLY_LABEL).toBe("custom-label");

      expect(stdout).toContain(LIMITATION_PHRASE);
    });

    it("requires the clearly named diagnostic opt-in before authorizing intermediate writes", async () => {
      const source = await readWrapper(name);
      expect(source).toContain(`${OPT_IN_ENV} === "1"`);

      const { env } = applyPolicy(source, {
        [OPT_IN_ENV]: "1",
      });
      expect(env[AUTHORIZE_ENV]).toBe("1");
    });

    it("labels authorized-write diagnostics as diagnostic_only", async () => {
      const source = await readWrapper(name);
      const defaultLabel = source.match(
        /\?\?\s*"(complete-flow-current-[a-z]+)"/u,
      )?.[1];
      expect(defaultLabel).toBeTruthy();

      const { env } = applyPolicy(source, {
        [OPT_IN_ENV]: "1",
      });
      expect(env.JOB_FINDER_PREPARE_ONLY_LABEL).toBe(
        `${defaultLabel}-diagnostic-only`,
      );
    });

    it("never double-suffixes an already diagnostic_only label", async () => {
      const source = await readWrapper(name);
      const { env } = applyPolicy(source, {
        [OPT_IN_ENV]: "1",
        JOB_FINDER_PREPARE_ONLY_LABEL: "nightly-diagnostic-only",
      });
      expect(env.JOB_FINDER_PREPARE_ONLY_LABEL).toBe("nightly-diagnostic-only");
    });

    it("cannot elevate final submit or account creation authority", async () => {
      const source = await readWrapper(name);
      expect(source).not.toMatch(/NESTOR_[A-Z0-9_]+/u);
      expect(source).not.toMatch(/FINAL_SUBMIT|ACCOUNT_CREAT/iu);
      expect(countOccurrences(source, `${AUTHORIZE_ENV} = "1"`)).toBe(1);
      expect(countOccurrences(source, `${AUTHORIZE_ENV} = "0"`)).toBe(1);
      expect(source.indexOf(`${AUTHORIZE_ENV} = "1"`)).toBeGreaterThan(
        source.indexOf(OPT_IN_ENV),
      );
    });

    it("does not require resumeUploadVerified and reports that limitation once", async () => {
      const source = await readWrapper(name);
      expect(countOccurrences(source, "resumeUploadVerified")).toBe(
        countOccurrences(source, LIMITATION_PHRASE),
      );
      expect(countOccurrences(source, LIMITATION_PHRASE)).toBe(1);
    });
  },
);

describe("ATS wrapper strictness expectations", () => {
  it("keeps Greenhouse and Ashby strict about reaching the final checkpoint without submission", async () => {
    for (const name of ["greenhouse", "ashby"] as const) {
      const source = await readWrapper(name);
      expect(source).toContain(
        'JOB_FINDER_PREPARE_ONLY_REQUIRE_FINAL_CHECKPOINT = "1"',
      );
      expect(source).not.toContain(
        "JOB_FINDER_PREPARE_ONLY_EXPECT_BLOCKER_CODE",
      );
    }
  });

  it("keeps the Workday anonymous login human handoff as the expected outcome", async () => {
    const source = await readWrapper("workday");
    expect(source).toContain(
      'JOB_FINDER_PREPARE_ONLY_REQUIRE_FINAL_CHECKPOINT = "0"',
    );
    expect(source).toContain(
      'JOB_FINDER_PREPARE_ONLY_EXPECT_BLOCKER_CODE = "site_login_required"',
    );
    expect(source).not.toMatch(/\b(password|passwd|secret|api[_-]?key)\b/iu);
  });

  it("shares one diagnostic opt-in name across all wrappers", async () => {
    for (const name of Object.keys(WRAPPERS) as WrapperName[]) {
      const source = await readWrapper(name);
      expect(countOccurrences(source, OPT_IN_ENV)).toBe(1);
    }
  });
});

describe("prepare-only smoke strict outcome contract", () => {
  it("accepts exactly two safe outcomes for require-final-checkpoint runs", async () => {
    const source = await readSmokeSource();
    expect(source).toContain(
      'const SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD = "intermediate_write_guard";',
    );
    expect(source).toContain('"passed_final_checkpoint_without_submit"');
    expect(source).toContain('"passed_safe_blocker_without_submit"');
    // The gate evaluates a classified guard handoff, never a bare outcome.
    expect(source).toMatch(
      /passed_safe_blocker_without_submit"\s*&&\s*\n\s*isIntermediateWriteGuardHandoff/u,
    );
    // The report must carry blocker/checkpoint classification evidence.
    expect(source).toContain(
      "report.application.safeBlocker = classifyApplicationSafeBlocker(",
    );
  });

  it("refuses gated acceptance when safety preconditions are not met", async () => {
    const source = await readSmokeSource();
    expect(source).toContain("collectStrictAcceptanceViolations({");
    expect(source).toContain(
      "capabilities.intermediateAtsWritesAuthorized === true",
    );
    expect(source).toContain("assertions.submittedNeverOccurred !== true");
    expect(source).toContain("assertions.isolationCleanedUp !== true");
    expect(source).toContain("assertions.finalSubmitAuthorized !== false");
    expect(source).toContain("assertions.accountCreationAuthorized !== false");
  });

  it("never lets a write-guard handoff claim completion evidence", async () => {
    const source = await readSmokeSource();
    expect(source).toMatch(
      /application\.finalControl\?\.state === "reached_without_submit"/u,
    );
    expect(source).toMatch(/resumeUploadVerified === true/u);
    expect(source).toMatch(/application\.state === "submitted"/u);
  });

  it("keeps the Workday expected-blocker gate wired through the shared conjunction", async () => {
    const source = await readSmokeSource();
    expect(source).toContain(
      "JOB_FINDER_PREPARE_ONLY_EXPECT_BLOCKER_CODE?.trim() || null",
    );
    expect(source).toContain("expectedBlockerCode,");
    expect(source).toContain('"passed_expected_human_handoff_without_submit"');
    expect(source).toMatch(
      /expectedBlockerCode[\s\S]*!truthfulWriteGuardHandoff/u,
    );
  });
});

describe("prepare-only smoke launch safety", () => {
  it("sanitizes the child environment through one pure builder", async () => {
    const source = await readSmokeSource();
    expect(source).toContain("export function buildChildLaunchEnv(");
    // Dev-server routing and run-as-node can never reach the child.
    expect(source).toContain("delete env.ELECTRON_RUN_AS_NODE;");
    expect(source).toContain("delete env.ELECTRON_RENDERER_URL;");
    // Wrapper-level intent never reaches the child either.
    expect(source).toContain(
      "delete env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES;",
    );
    // Secrets are deleted by name from a single exported list.
    expect(source).toContain("NESTOR_AI_API_KEY");
    expect(source).toContain("for (const name of CHILD_ENV_SECRET_VARS)");
    // Self-assertion guards the no-writes invariant.
    expect(source).toContain(
      "intermediate-write authorization survived sanitization",
    );
    // Report authority derives from the final child env.
    expect(source).toMatch(
      /launchAuthorities = \[[^\]]*\]\.map\(\s*childEnvAuthorizesIntermediateWrites,/u,
    );
    // Both launches consume prebuilt sanitized environments.
    expect(source).toContain("launchApp(initialLaunchEnv)");
    expect(source).toContain("launchApp(relaunchEnv)");
  });

  it("persists strict-gate refusals", async () => {
    const source = await readSmokeSource();
    expect(source).toContain("acceptanceViolations: []");
    expect(source).toContain("report.strictGate = {");
    expect(source).toContain("collectStrictAcceptanceViolations({");
    expect(source).toContain('outcome = "failed_strict_gate";');
  });

  it("reserves passed_ for classified outcomes only", async () => {
    const source = await readSmokeSource();
    expect(source).toContain('"stopped_unclassified_without_submit"');
    expect(source).not.toContain('? "passed_safe_blocker_without_submit"');
  });

  it("keeps absolute local paths out of portable report fields", async () => {
    const source = await readSmokeSource();
    // Retained profile path is redacted to a basename.
    expect(source).toContain("path.basename(userDataDirectory)");
    // Resume evidence uses the id/name/digest summary without storagePath.
    expect(source).toContain(
      "summarizeOriginalResumeEvidence(latestWorkspace.profile.baseResume)",
    );
    expect(source).not.toContain("baseResume.storagePath");
  });
});

describe("typed preload calls in the prepare-only smoke", () => {
  it("unwraps the typed discovery result before reading workspace state", async () => {
    const source = await readSmokeSource();
    const runIndex = source.indexOf(
      'const discoveryResult = await runPhase(\n      "fast_configured_source_discovery"',
    );
    // The route answers with what changed; the smoke reads the whole
    // workspace when the reply carries no snapshot.
    const unwrapIndex = source.indexOf(
      "latestWorkspace =\n      discoveryResult.snapshot ??",
    );
    const summarizeIndex = source.indexOf(
      "report.discovery = buildDiscoverySummary(latestWorkspace);",
    );

    expect(runIndex).toBeGreaterThan(-1);
    expect(unwrapIndex).toBeGreaterThan(runIndex);
    expect(summarizeIndex).toBeGreaterThan(unwrapIndex);
  });

  it("passes the typed apply-copilot action object through the preload bridge", async () => {
    const source = await readSmokeSource();

    expect(source).toContain(
      "window.nestor.jobFinder.startApplyCopilotRun({\n              jobId,\n              visualCheckpointsEnabled: false,\n            })",
    );
    expect(source).not.toContain(
      "window.nestor.jobFinder.startApplyCopilotRun(jobId,",
    );
  });
});

describe("ATS wrappers validate board inputs before the live fetch", () => {
  it.each(Object.keys(WRAPPERS) as WrapperName[])(
    "%s keeps the extracted policy block pure env/stdout code",
    async (name) => {
      // The policy block is executed in a sandbox with only a process stub;
      // preflight/fetch/import calls must never leak into that region.
      const policyRegion = extractPolicyBlock(await readWrapper(name));
      expect(policyRegion).not.toContain("await fetch(");
      expect(policyRegion).not.toContain("smokePreflight");
      expect(policyRegion).not.toContain("await import(");
      expect(policyRegion).not.toContain("response.");
    },
  );

  it("validates the Workday board env as hostname plus safe segments before the fetch", async () => {
    const source = await readWrapper("workday");
    const validateIndex = source.indexOf(
      "smokePreflight.validateWorkdayBoardEnv(process.env)",
    );
    const fetchIndex = source.indexOf("await fetch(");
    expect(validateIndex).toBeGreaterThan(-1);
    expect(validateIndex).toBeLessThan(fetchIndex);
    // The fetch and job URL are built only from validated values.
    expect(source).toContain("const hostname = boardEnv.host;");
    expect(source).toContain("const tenant = boardEnv.tenant;");
    expect(source).toContain("const siteId = boardEnv.siteId;");
    expect(source).toContain("const locale = boardEnv.locale;");
    expect(source).toContain("https://${hostname}/wday/cxs/");
    expect(source).toContain("https://${hostname}/${locale}/${siteId}");
    expect(source).not.toContain("process.env.JOB_FINDER_WORKDAY_HOST}");
  });

  it("keeps Greenhouse and Ashby board tokens encoded as in unbound runs", async () => {
    for (const name of ["greenhouse", "ashby"] as const) {
      const source = await readWrapper(name);
      expect(source).toMatch(/encodeURIComponent\(board(Token|Slug)\)/u);
    }
  });
});

describe("ATS flow preflight runtime guards", () => {
  it("rejects unsafe Workday host/tenant/site/locale values locally", async () => {
    const smoke = await loadSmokeModule();
    const unsafeEnv: Record<string, string>[] = [
      { JOB_FINDER_WORKDAY_HOST: "https://evil.example.com" },
      { JOB_FINDER_WORKDAY_HOST: "amat.wd1.myworkdayjobs.com/jobs" },
      { JOB_FINDER_WORKDAY_HOST: "user@host.example.com" },
      { JOB_FINDER_WORKDAY_HOST: "amat.wd1.myworkdayjobs.com:8443" },
      { JOB_FINDER_WORKDAY_HOST: "1.2.3.4" },
      { JOB_FINDER_WORKDAY_HOST: "amat_.example.com" },
      { JOB_FINDER_WORKDAY_HOST: "amat\u0000example.com" },
      { JOB_FINDER_WORKDAY_TENANT: ".." },
      { JOB_FINDER_WORKDAY_TENANT: "../amat" },
      { JOB_FINDER_WORKDAY_TENANT: "a/b" },
      { JOB_FINDER_WORKDAY_SITE: "External/Admin" },
      { JOB_FINDER_WORKDAY_SITE: "External%2FAdmin" },
      { JOB_FINDER_WORKDAY_SITE: "External?x=1" },
      { JOB_FINDER_WORKDAY_SITE: "" },
      { JOB_FINDER_WORKDAY_LOCALE: "en-US/.." },
      { JOB_FINDER_WORKDAY_LOCALE: "." },
    ];
    for (const env of unsafeEnv) {
      expect(() => smoke.validateWorkdayBoardEnv(env)).toThrow();
    }
  });

  it("passes through safe Workday defaults and custom values unchanged", async () => {
    const smoke = await loadSmokeModule();
    expect(smoke.validateWorkdayBoardEnv({})).toEqual({
      host: "amat.wd1.myworkdayjobs.com",
      tenant: "amat",
      siteId: "External",
      locale: "en-US",
    });
    expect(
      smoke.validateWorkdayBoardEnv({
        JOB_FINDER_WORKDAY_HOST: "acme.wd1.myworkdayjobs.com",
        JOB_FINDER_WORKDAY_TENANT: "acme",
        JOB_FINDER_WORKDAY_SITE: "External",
        JOB_FINDER_WORKDAY_LOCALE: "de-DE",
      }),
    ).toEqual({
      host: "acme.wd1.myworkdayjobs.com",
      tenant: "acme",
      siteId: "External",
      locale: "de-DE",
    });
  });
});

import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type * as childProcess from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type * as browserAgent from "@nestor/browser-agent";
import {
  ApplyExecutionResultSchema,
  BrowserVisualObservationSetSchema,
  SavedJobSchema,
  type BrowserVisualAnalysisInput,
  type BrowserVisualObservationSet,
  type PreparedFormSnapshot,
  type PreparedApplicationForm,
} from "@nestor/contracts";
import type { BrowserContext, Page } from "playwright";
import type { BrowserAgentRuntimeOptions } from "./playwright-browser-runtime";
import type * as formRecovery from "./prepared-form-recovery";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

// The first import of the runtime loads most of the browser stack; on a busy
// machine that alone outran the first test's five seconds.
beforeAll(async () => {
  await import("./playwright-browser-runtime");
}, 60_000);

test("navigation failures distinguish an unreachable site from a blocked browser", async () => {
  const { classifyBrowserNavigationFailure } =
    await import("./playwright-browser-runtime");
  expect(
    classifyBrowserNavigationFailure(
      "page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/jobs",
    ),
  ).toMatchObject({ status: "ready", label: "Browser open" });
  expect(classifyBrowserNavigationFailure("navigation failed")).toMatchObject({
    status: "blocked",
    label: "Browser navigation failed",
  });
});

test("submission stays bound to the prepared page when another tab opens", async () => {
  const { selectPreparedApplicationPage } =
    await import("./playwright-browser-runtime");
  const preparedPage = {
    isClosed: () => false,
    url: () => "https://example.com/apply/1",
  };
  const unrelatedLatestPage = {
    isClosed: () => false,
    url: () => "https://example.com/jobs/other",
  };
  const pages = new Map([
    ["result_a", preparedPage],
    ["result_b", unrelatedLatestPage],
  ]);

  expect(selectPreparedApplicationPage(pages, "result_a")).toBe(preparedPage);
  expect(selectPreparedApplicationPage(pages, "result_a")).not.toBe(
    unrelatedLatestPage,
  );
});

test("submission fails closed when its prepared page was closed", async () => {
  const { selectPreparedApplicationPage } =
    await import("./playwright-browser-runtime");

  expect(() =>
    selectPreparedApplicationPage(
      new Map([["result_a", { isClosed: () => true }]]),
      "result_a",
    ),
  ).toThrow("prepared application page was closed");
});

test("submission never falls back to another page when its binding is missing after restart", async () => {
  const { selectPreparedApplicationPage } =
    await import("./playwright-browser-runtime");
  const unrelatedPage = { isClosed: () => false };

  expect(() =>
    selectPreparedApplicationPage(
      new Map([["result_b", unrelatedPage]]),
      "result_a",
    ),
  ).toThrow("exact prepared application page is no longer open");
});

test("same-URL application bindings focus their own retained pages", async () => {
  const { focusPreparedApplicationPage } =
    await import("./playwright-browser-runtime");
  const pageA = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    isClosed: () => false,
    url: () => "https://example.com/apply/1",
  };
  const pageB = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    isClosed: () => false,
    url: () => "https://example.com/apply/1",
  };
  const pages = new Map([
    ["result_a", pageA],
    ["result_b", pageB],
  ]);

  await expect(focusPreparedApplicationPage(pages, "result_a")).resolves.toBe(
    true,
  );
  expect(pageA.bringToFront).toHaveBeenCalledOnce();
  expect(pageB.bringToFront).not.toHaveBeenCalled();

  await expect(focusPreparedApplicationPage(pages, "result_b")).resolves.toBe(
    true,
  );
  expect(pageB.bringToFront).toHaveBeenCalledOnce();
  await expect(
    focusPreparedApplicationPage(pages, "result_missing"),
  ).resolves.toBe(false);
});

test("preparation keeps exact result-bound pages isolated even when URLs match", async () => {
  const { resolveAutomationPageForContext } =
    await import("./playwright-browser-runtime");
  const makePage = (url: string) => ({
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: () => false,
    url: () => url,
  });
  const pageA = makePage("https://example.com/apply/1?stage=review#a");
  const pageB = makePage("https://example.com/apply/1?stage=review#a");
  const pageC = makePage("about:blank");
  const newPage = vi.fn().mockResolvedValue(pageC);
  const context = {
    pages: () => [pageA, pageB],
    newPage,
  } as unknown as BrowserContext;

  await expect(
    resolveAutomationPageForContext(context, {
      targetUrl: pageA.url(),
      preferredPage: pageA as unknown as Page,
      protectedPages: [pageB as unknown as Page],
      closeOtherPages: false,
    }),
  ).resolves.toBe(pageA);
  expect(newPage).not.toHaveBeenCalled();
  expect(pageB.close).not.toHaveBeenCalled();

  await expect(
    resolveAutomationPageForContext(context, {
      targetUrl: pageA.url(),
      protectedPages: [pageA as unknown as Page, pageB as unknown as Page],
      reuseExistingPage: false,
      closeOtherPages: false,
    }),
  ).resolves.toBe(pageC);
  expect(newPage).toHaveBeenCalledTimes(1);
  expect(pageA.close).not.toHaveBeenCalled();
  expect(pageB.close).not.toHaveBeenCalled();
});

test("preparation does not reuse a bound page when the exact target changed", async () => {
  const { resolveAutomationPageForContext } =
    await import("./playwright-browser-runtime");
  const boundPage = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: () => false,
    url: () => "https://example.com/apply/1?stage=review#person",
  };
  const replacement = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: () => false,
    url: () => "about:blank",
  };
  const context = {
    pages: () => [boundPage],
    newPage: vi.fn().mockResolvedValue(replacement),
  } as unknown as BrowserContext;

  await expect(
    resolveAutomationPageForContext(context, {
      targetUrl: "https://example.com/apply/1?stage=review#agent",
      preferredPage: boundPage as unknown as Page,
      protectedPages: [boundPage as unknown as Page],
      reuseExistingPage: false,
      closeOtherPages: false,
      requireExactTarget: true,
    }),
  ).resolves.toBe(replacement);
  expect(boundPage.close).not.toHaveBeenCalled();
});

function createTestJob() {
  return SavedJobSchema.parse({
    id: "job_visual_runtime",
    source: "target_site" as const,
    sourceJobId: "job_visual_runtime",
    discoveryMethod: "catalog_seed" as const,
    collectionMethod: "fallback_search" as const,
    canonicalUrl: "https://example.com/jobs/job_visual_runtime",
    applicationUrl: "https://example.com/apply/job_visual_runtime",
    title: "Senior Engineer",
    company: "Example Co",
    location: "Remote",
    workMode: ["remote" as const],
    applyPath: "external_redirect" as const,
    easyApplyEligible: false,
    postedAt: "2026-03-20T09:00:00.000Z",
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    detailQuality: "detail_enriched" as const,
    summary: "Build resilient workflows.",
    description:
      "Upload resume and review required fields before final submit.",
    keySkills: ["TypeScript"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    titleTriageOutcome: "pass" as const,
    sourceIntelligence: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: [],
    benefits: [],
    status: "approved" as const,
    matchAssessment: {
      score: 91,
      reasons: ["Strong fit"],
      gaps: [],
      recommendation: "review_before_applying" as const,
      recommendationRationale: "Test fixture requires explicit review.",
      requirements: [],
    },
    provenance: [],
  });
}

function createTestProfile() {
  return {
    id: "candidate_1",
    firstName: "Alex",
    lastName: "Vanguard",
    middleName: null,
    fullName: "Alex Vanguard",
    preferredDisplayName: null,
    headline: "Senior systems designer",
    summary: "Builds resilient workflows.",
    currentLocation: "Remote",
    currentCity: null,
    currentRegion: null,
    currentCountry: null,
    timeZone: null,
    yearsExperience: 10,
    email: "alex@example.com",
    secondaryEmail: null,
    phone: "+44 7700 900123",
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    narrative: {
      professionalStory: "Builds resilient workflows.",
      nextChapterSummary: "Open to workflow roles.",
      careerTransitionSummary: null,
      differentiators: [],
      motivationThemes: [],
    },
    proofBank: [],
    answerBank: {
      workAuthorization: null,
      visaSponsorship: null,
      relocation: null,
      travel: null,
      noticePeriod: null,
      availability: null,
      salaryExpectations: null,
      selfIntroduction: null,
      careerTransition: null,
      customAnswers: [],
    },
    applicationIdentity: {
      preferredEmail: "alex@example.com",
      preferredPhone: "+44 7700 900123",
      preferredLinkIds: [],
    },
    baseResume: {
      id: "resume_1",
      fileName: "alex-vanguard.pdf",
      uploadedAt: "2026-03-20T10:00:00.000Z",
      storagePath: null,
      textContent: null,
      textUpdatedAt: null,
      extractionStatus: "not_started" as const,
      lastAnalyzedAt: null,
      analysisProviderKind: null,
      analysisProviderLabel: null,
      analysisWarnings: [],
    },
    workEligibility: {
      authorizedWorkCountries: [],
      requiresVisaSponsorship: null,
      willingToRelocate: null,
      preferredRelocationRegions: [],
      willingToTravel: null,
      remoteEligible: null,
      noticePeriodDays: null,
      availableStartDate: null,
      securityClearance: null,
    },
    professionalSummary: {
      shortValueProposition: null,
      fullSummary: null,
      careerThemes: [],
      leadershipSummary: null,
      domainFocusSummary: null,
      strengths: [],
    },
    skillGroups: {
      coreSkills: [],
      tools: [],
      languagesAndFrameworks: [],
      softSkills: [],
      highlightedSkills: [],
    },
    targetRoles: [],
    locations: [],
    skills: [],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
  };
}

/**
 * Stands in for the caller that fills the form.
 *
 * These tests are about the browser lifecycle the runtime owns — opening the
 * page, watching for workers, cleaning up — not about what goes into a form.
 * The stub records that the runtime handed over one open page and returns a
 * prepared result.
 */
const preparedFormSessions: unknown[] = [];
function createStubFormPreparer() {
  return ({ session, startedAt }: { session: unknown; startedAt: string }) => {
    preparedFormSessions.push(session);
    return Promise.resolve(
      ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "Filled in and waiting",
        detail: "Job Finder filled the form in and stopped; nothing was sent.",
        submittedAt: null,
        outcome: null,
        questions: [],
        blocker: null,
        consentDecisions: [],
        replay: {
          sourceInstructionArtifactId: null,
          sourceDebugEvidenceRefIds: [],
          lastUrl: null,
          checkpointUrls: [],
        },
        visualEvidence: [],
        visualObservationSets: [],
        visualCheckpoints: [],
        nextActionLabel: "Open the application and finish it",
        checkpoints: [
          {
            id: "checkpoint_stub_prepared",
            at: startedAt,
            label: "Filled in and waiting",
            detail: "The form was filled in and nothing was sent.",
            state: "paused",
            visualEvidence: [],
          },
        ],
      }),
    );
  };
}

function createTestSettings() {
  return {
    resumeFormat: "pdf" as const,
    resumeTemplateId: "classic_ats" as const,
    fontPreset: "inter_requisite" as const,
    appearanceTheme: "system" as const,
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
  };
}

function createTestResumeArtifact() {
  return {
    id: "application_resume_visual_runtime",
    jobId: "job_visual_runtime",
    source: "tailored_export" as const,
    sourceDocumentId: null,
    exportArtifactId: "resume_export_visual_runtime",
    fileName: "alex-vanguard.pdf",
    filePath: "/tmp/alex-vanguard.pdf",
    approvedAt: "2026-03-20T10:00:00.000Z",
  };
}

const spawnMock = vi.fn();
const execFileMock = vi.fn();
const connectOverCDPMock = vi.fn();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof childProcess>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: connectOverCDPMock,
  },
}));

function withPlatform(
  platform: NodeJS.Platform,
  run: () => Promise<void>,
): Promise<void> {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  return run().finally(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });
}

function createMockChildProcess(input: { pid: number; emitExit?: boolean }) {
  const processEmitter = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    unref: () => void;
    kill: () => boolean;
  };
  processEmitter.pid = input.pid;
  processEmitter.exitCode = null;
  processEmitter.killed = false;
  processEmitter.unref = () => undefined;
  processEmitter.kill = () => {
    processEmitter.killed = true;
    processEmitter.exitCode = 0;
    processEmitter.emit("exit", 0);
    return true;
  };

  if (input.emitExit) {
    queueMicrotask(() => {
      processEmitter.exitCode = 0;
      processEmitter.emit("exit", 0);
    });
  }

  return processEmitter;
}

function createSlowExitMockChildProcess(input: {
  pid: number;
  exitDelayMs: number;
}) {
  const processEmitter = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    unref: () => void;
    kill: () => boolean;
  };
  processEmitter.pid = input.pid;
  processEmitter.exitCode = null;
  processEmitter.killed = false;
  processEmitter.unref = () => undefined;
  processEmitter.kill = () => {
    processEmitter.killed = true;
    setTimeout(() => {
      processEmitter.exitCode = 0;
      processEmitter.emit("exit", 0);
    }, input.exitDelayMs);
    return true;
  };

  return processEmitter;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function maybeInvokeExecFileCallback(args: unknown[]) {
  const callback = args[args.length - 1];
  if (typeof callback === "function") {
    (callback as ExecFileCallback)(null, "[]", "");
  }
}

function stubDebuggerEndpointFetch(input: {
  debugPort: number;
  failFirstCheck?: boolean;
}) {
  let debuggerReadyChecks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      debuggerReadyChecks += 1;
      if (input.failFirstCheck && debuggerReadyChecks === 1) {
        return Promise.reject(new Error("debugger not ready yet"));
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            input.failFirstCheck
              ? {
                  webSocketDebuggerUrl: `ws://127.0.0.1:${input.debugPort}/devtools/browser/test`,
                }
              : {},
          ),
      } as Response);
    }),
  );
}

async function reserveFreePort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!port) {
    throw new Error("Failed to reserve a free TCP port for the runtime test.");
  }

  return port;
}

describe("playwright browser runtime", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
    execFileMock.mockReset();
    connectOverCDPMock.mockReset();

    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  test("Stop closes a page wait immediately instead of waiting for its navigation timeout", async () => {
    vi.useFakeTimers();
    const { createDiscoveryPageAbortBinding } =
      await import("./playwright-browser-runtime");
    const controller = new AbortController();
    const close = vi.fn().mockResolvedValue(undefined);
    const binding = createDiscoveryPageAbortBinding(controller.signal);
    binding.onPageResolved({
      close,
      isClosed: () => false,
    } as unknown as Page);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1);

    expect(close).toHaveBeenCalledOnce();
    binding.dispose();
    vi.useRealTimers();
  });

  test("normalizes stale crash state and lets owned Chrome exit gracefully after browser disconnect reset", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-close-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      await writeFile(
        join(userDataDir, "nestor-browser-window-bounds.json"),
        JSON.stringify({
          width: 1180,
          height: 780,
          x: 180,
          y: 90,
          windowState: "normal",
        }),
        "utf8",
      );
      const profileDirectory = join(userDataDir, "Default");
      const preferencesPath = join(profileDirectory, "Preferences");
      await mkdir(profileDirectory, { recursive: true });
      await writeFile(
        preferencesPath,
        JSON.stringify({
          account_info: [{ email: "preserved@example.test" }],
          profile: {
            exit_type: "Crashed",
            exited_cleanly: false,
            name: "Managed browser",
          },
        }),
        "utf8",
      );
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 42424 });
      let disconnectedHandler: (() => void) | null = null;

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        context: () => fakeContext,
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      let currentBounds = {
        width: 1040,
        height: 760,
        x: 120,
        y: 80,
        windowState: "normal" as const,
      };
      const setWindowBounds = vi.fn(
        (params: { bounds: typeof currentBounds }) => {
          currentBounds = { ...currentBounds, ...params.bounds };
        },
      );
      const cdpSession = {
        detach: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(
          (method: string, params?: { bounds: typeof currentBounds }) => {
            if (method === "Browser.getWindowForTarget") {
              return Promise.resolve({ windowId: 7, bounds: currentBounds });
            }
            if (method === "Browser.setWindowBounds" && params) {
              setWindowBounds(params);
              return Promise.resolve({});
            }
            return Promise.reject(
              new Error(`Unexpected CDP method: ${method}`),
            );
          },
        ),
      };
      const fakeContext = {
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(() => {
          disconnectedHandler?.();
          launchedChromeProcess.kill();
          return Promise.resolve();
        }),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "disconnected") {
            disconnectedHandler = callback;
          }
          return fakeBrowser;
        }),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/browser/test`,
              }),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockImplementation((command: string) => {
        if (command === "taskkill") {
          return createMockChildProcess({ pid: 52525, emitExit: true });
        }

        return launchedChromeProcess;
      });
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await withPlatform("win32", async () => {
        await runtime.openSession("target_site");
        const closedState = await runtime.closeSession("target_site");

        expect(closedState.label).toBe("Browser profile closed");
      });

      const normalizedPreferences: unknown = JSON.parse(
        await readFile(preferencesPath, "utf8"),
      );

      expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(chromeExecutablePath);
      expect(spawnMock.mock.calls[0]?.[1]).toContain(
        `--remote-debugging-port=${debugPort}`,
      );
      expect(connectOverCDPMock).toHaveBeenCalledWith(
        `ws://127.0.0.1:${debugPort}/devtools/browser/test`,
        { timeout: 5_000 },
      );
      expect(spawnMock.mock.calls[0]?.[1]).toContain(
        "--disable-session-crashed-bubble",
      );
      expect(spawnMock.mock.calls[0]?.[1]).toContain(
        "--hide-crash-restore-bubble",
      );
      expect(spawnMock.mock.calls[0]?.[1]).toContain("--disable-extensions");
      expect(spawnMock.mock.calls[0]?.[1]).toContain(
        "--disable-component-extensions-with-background-pages",
      );
      expect(normalizedPreferences).toMatchObject({
        account_info: [{ email: "preserved@example.test" }],
        profile: {
          exit_type: "Normal",
          exited_cleanly: true,
          name: "Managed browser",
        },
      });
      expect(setWindowBounds).toHaveBeenCalledWith({
        windowId: 7,
        bounds: {
          width: 1180,
          height: 780,
          x: 180,
          y: 90,
          windowState: "normal",
        },
      });
      expect(
        JSON.parse(
          await readFile(
            join(userDataDir, "nestor-browser-window-bounds.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ width: 1180, height: 780, x: 180, y: 90 });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("connects after the Windows Chrome launcher hands off to a continuing process", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-windows-handoff-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({
        pid: 42425,
        emitExit: true,
      });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const fakeContext = {
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };
      let debuggerReadyChecks = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/browser/test`,
              }),
          } as Response);
        }),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await withPlatform("win32", async () => {
        await expect(runtime.openSession("target_site")).resolves.toEqual(
          expect.objectContaining({ status: "ready" }),
        );
      });

      expect(launchedChromeProcess.exitCode).toBe(0);
      expect(connectOverCDPMock).toHaveBeenCalledWith(
        `ws://127.0.0.1:${debugPort}/devtools/browser/test`,
        { timeout: 5_000 },
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("captures an in-memory viewport visual snapshot through Playwright", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-visual-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 42425 });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
        title: vi.fn().mockResolvedValue("Example jobs"),
        viewportSize: () => ({ width: 1440, height: 900 }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
      };
      const fakeContext = {
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        ),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockImplementation((command: string) => {
        if (command === "taskkill") {
          return createMockChildProcess({ pid: 52526, emitExit: true });
        }

        return launchedChromeProcess;
      });
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      const snapshot = await runtime.captureVisualSnapshot!("target_site", {
        purpose: "source_debug",
        mode: "viewport",
        label: "Search page visual evidence",
        reason: "Weak DOM extraction needs visible page context.",
        region: null,
        retention: {
          retention: "temporary",
          redactionLevel: "standard",
          reason: "Temporary analysis input only.",
          expiresAt: null,
        },
      });

      expect(snapshot.url).toBe("https://example.com/jobs");
      expect(snapshot.pageTitle).toBe("Example jobs");
      expect(snapshot.dataUrl).toBe(
        `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`,
      );
      expect(snapshot.viewport?.width).toBe(1440);
      expect(fakePage.screenshot).toHaveBeenCalledWith({
        type: "png",
        animations: "disabled",
        timeout: 10_000,
        fullPage: false,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("retains visual snapshots with metadata and cleans expired files", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-visual-retained-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 42426 });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
        title: vi.fn().mockResolvedValue("Example jobs"),
        viewportSize: () => ({ width: 1440, height: 900 }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from("retained-png")),
      };
      const fakeContext = {
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };
      const visualDir = join(userDataDir, "visual-snapshots");
      await writeFile(join(userDataDir, "placeholder.txt"), "", "utf8");

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        ),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await mkdir(visualDir, { recursive: true });
      const expiredPath = join(visualDir, "expired.png");
      const expiredMetadataPath = join(visualDir, "expired.json");
      await writeFile(expiredPath, "expired", "utf8");
      await writeFile(
        expiredMetadataPath,
        JSON.stringify({ expiresAt: "2000-01-01T00:00:00.000Z" }),
        "utf8",
      );

      const snapshot = await runtime.captureVisualSnapshot!("target_site", {
        purpose: "source_debug",
        mode: "viewport",
        label: "Search page visual evidence",
        reason: "Weak DOM extraction needs visible page context.",
        region: null,
        retention: {
          retention: "retained",
          redactionLevel: "standard",
          reason: "Retained source-debug evidence explains a blocker.",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });

      expect(snapshot.storagePath).toMatch(/visual-snapshots/);
      const files = await readdir(visualDir);
      expect(files.some((file) => file.endsWith(".png"))).toBe(true);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);
      expect(files).not.toContain("expired.png");
      expect(files).not.toContain("expired.json");
      const retainedStats = await stat(snapshot.storagePath!);
      expect(retainedStats.size).toBeGreaterThan(0);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("does not capture apply-page screenshots unless caller explicitly opts in", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-apply-visual-opt-in-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const approvedResumePath = join(userDataDir, "alex-vanguard.pdf");
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 42427 });
      const fakePage = {
        on: vi.fn(),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/apply/job_visual_runtime",
        title: vi.fn().mockResolvedValue("Apply"),
        viewportSize: () => ({ width: 1440, height: 900 }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from("apply-png")),
      };
      let staleAutomationPageClosed = false;
      const staleAutomationPage = {
        isClosed: () => staleAutomationPageClosed,
        url: () => "https://example.com/apply/previous-job",
        close: vi.fn(() => {
          staleAutomationPageClosed = true;
          return Promise.resolve();
        }),
      };
      const fakeContext = {
        pages: () => [fakePage, staleAutomationPage],
        serviceWorkers: () => [],
      };
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };
      const visualObservationSet = BrowserVisualObservationSetSchema.parse({
        id: "visual_observation_apply_runtime",
        snapshotId: "visual_snapshot_apply_runtime",
        observedAt: "2026-03-20T10:00:00.000Z",
        url: "https://example.com/apply/job_visual_runtime",
        purpose: "apply_checkpoint",
        providerKind: "deterministic",
        providerLabel: "Test visual analyzer",
        summary: "Visible resume upload context.",
        blockers: [],
        visibleControls: [],
        jobCardClues: [],
        applyPathClues: [],
        fieldControls: ["Resume upload context is visible."],
        validationErrors: [],
        buttonStates: [],
        recoveryNotes: [],
        uncertainty: [],
        observations: [],
        questionContexts: [],
        reconciliations: [],
        rejectedOutputReasons: [],
      });
      const analyzeBrowserVisualSnapshot = vi
        .fn<
          (
            input: BrowserVisualAnalysisInput,
          ) => Promise<BrowserVisualObservationSet>
        >()
        .mockResolvedValue(visualObservationSet);

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        ),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        aiClient: {
          getStatus: () => ({
            kind: "deterministic",
            role: "chat",
            ready: true,
            label: "Test visual analyzer",
            model: null,
            baseUrl: null,
            modelContextWindowTokens: null,
            reservedHeadroomTokens: null,
            requestTimeoutMs: null,
            detail: null,
          }),
          analyzeBrowserVisualSnapshot,
        } as unknown as JobFinderAiClient,
      });

      const input = {
        job: createTestJob(),
        resumeArtifact: {
          ...createTestResumeArtifact(),
          filePath: approvedResumePath,
        },
        profile: createTestProfile(),
        settings: createTestSettings(),
        mode: "prepare_only" as const,
        prepareApplicationForm: createStubFormPreparer(),
        submitAuthorized: false,
      };
      const defaultResult = await runtime.executeApplicationFlow(
        "target_site",
        input,
      );

      expect(staleAutomationPage.close).not.toHaveBeenCalled();
      expect(defaultResult.visualEvidence).toEqual([]);
      expect(defaultResult.visualObservationSets).toEqual([]);
      expect(defaultResult.visualCheckpoints).toEqual([]);
      expect(
        defaultResult.executionTimings.map((entry) => entry.stage),
      ).toEqual([
        "browser_preparation",
        "form_preparation",
        "visual_diagnostics",
        "total",
      ]);
      expect(
        defaultResult.executionTimings.every((entry) => entry.durationMs >= 0),
      ).toBe(true);
      expect(fakePage.screenshot).not.toHaveBeenCalled();
      expect(analyzeBrowserVisualSnapshot).not.toHaveBeenCalled();

      const optedInResult = await runtime.executeApplicationFlow(
        "target_site",
        {
          ...input,
          captureVisualSnapshot: (request) =>
            runtime.captureVisualSnapshot!("target_site", request),
          analyzeVisualSnapshot: (analysisInput: BrowserVisualAnalysisInput) =>
            analyzeBrowserVisualSnapshot({
              ...analysisInput,
              snapshot: {
                ...analysisInput.snapshot,
                id: "visual_snapshot_apply_runtime",
              },
            }),
        },
      );

      expect(optedInResult.visualEvidence[0]?.summary).toContain(
        "Visible resume upload context",
      );
      expect(fakePage.screenshot).toHaveBeenCalledTimes(1);
      expect(analyzeBrowserVisualSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("closeSession waits for an owned Windows Chrome graceful exit before forced cleanup", async () => {
    vi.useFakeTimers();
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-windows-exit-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createSlowExitMockChildProcess({
        pid: 43434,
        exitDelayMs: 200,
      });
      let disconnectedHandler: (() => void) | null = null;

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const fakeContext = {
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(() => {
          disconnectedHandler?.();
          launchedChromeProcess.kill();
          return Promise.resolve();
        }),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "disconnected") {
            disconnectedHandler = callback;
          }
          return fakeBrowser;
        }),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockImplementation((command: string) => {
        if (command === "taskkill") {
          return createMockChildProcess({ pid: 53535, emitExit: true });
        }

        return launchedChromeProcess;
      });
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await withPlatform("win32", async () => {
        await runtime.openSession("target_site");
        const closePromise = runtime.closeSession("target_site");
        await vi.advanceTimersByTimeAsync(150);
        // Verify the close promise is still pending until Chrome exits.
        await expect(
          Promise.race([
            closePromise.then(() => "closed"),
            Promise.resolve("pending"),
          ]),
        ).resolves.toBe("pending");
        await vi.advanceTimersByTimeAsync(50);
        await expect(closePromise).resolves.toEqual(
          expect.objectContaining({ label: "Browser profile closed" }),
        );
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(chromeExecutablePath);
      expect(launchedChromeProcess.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("resolveLivePage avoids focus churn when the session is already ready", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-resolve-live-page-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 54545 });

      const fakePage = {
        close: vi.fn().mockResolvedValue(undefined),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
        goto: vi.fn().mockResolvedValue(undefined),
      };
      const fakeContext = {
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const mockAiClient = {
        chatWithTools: vi
          .fn()
          .mockResolvedValue({ content: "done", toolCalls: [] }),
        getStatus: () => ({
          kind: "deterministic",
          role: "chat",
          ready: true,
          label: "Test AI client ready",
          model: null,
          baseUrl: null,
          modelContextWindowTokens: null,
          reservedHeadroomTokens: null,
          requestTimeoutMs: null,
          detail: null,
        }),
      } satisfies Pick<JobFinderAiClient, "chatWithTools" | "getStatus">;
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        aiClient: mockAiClient as unknown as JobFinderAiClient,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });

      await runtime.openSession("target_site");
      fakePage.bringToFront.mockClear();

      await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: {
          id: "candidate_1",
          firstName: "Alex",
          lastName: "Vanguard",
          middleName: null,
          fullName: "Alex Vanguard",
          preferredDisplayName: null,
          headline: "Senior systems designer",
          summary: "Builds resilient workflows.",
          currentLocation: "Remote",
          currentCity: null,
          currentRegion: null,
          currentCountry: null,
          timeZone: null,
          yearsExperience: 10,
          email: "alex@example.com",
          secondaryEmail: null,
          phone: "+44 7700 900123",
          portfolioUrl: null,
          linkedinUrl: null,
          githubUrl: null,
          personalWebsiteUrl: null,
          narrative: {
            professionalStory: "Builds resilient workflows.",
            nextChapterSummary: "Open to workflow roles.",
            careerTransitionSummary: null,
            differentiators: [],
            motivationThemes: [],
          },
          proofBank: [],
          answerBank: {
            workAuthorization: null,
            visaSponsorship: null,
            relocation: null,
            travel: null,
            noticePeriod: null,
            availability: null,
            salaryExpectations: null,
            selfIntroduction: null,
            careerTransition: null,
            customAnswers: [],
          },
          applicationIdentity: {
            preferredEmail: "alex@example.com",
            preferredPhone: "+44 7700 900123",
            preferredLinkIds: [],
          },
          baseResume: {
            id: "resume_1",
            fileName: "alex-vanguard.pdf",
            uploadedAt: "2026-03-20T10:00:00.000Z",
            storagePath: null,
            textContent: null,
            textUpdatedAt: null,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            analysisProviderKind: null,
            analysisProviderLabel: null,
            analysisWarnings: [],
          },
          workEligibility: {
            authorizedWorkCountries: [],
            requiresVisaSponsorship: null,
            willingToRelocate: null,
            preferredRelocationRegions: [],
            willingToTravel: null,
            remoteEligible: null,
            noticePeriodDays: null,
            availableStartDate: null,
            securityClearance: null,
          },
          professionalSummary: {
            shortValueProposition: null,
            fullSummary: null,
            careerThemes: [],
            leadershipSummary: null,
            domainFocusSummary: null,
            strengths: [],
          },
          skillGroups: {
            coreSkills: [],
            tools: [],
            languagesAndFrameworks: [],
            softSkills: [],
            highlightedSkills: [],
          },
          targetRoles: [],
          locations: [],
          skills: [],
          experiences: [],
          education: [],
          certifications: [],
          links: [],
          projects: [],
          spokenLanguages: [],
        },
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });

      expect(fakePage.bringToFront).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("runAgentDiscovery without AI still navigates the visible blank tab so compact observation can run", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-agent-visible-blank-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 54646 });

      let blankPageUrl = "about:blank";
      const blankPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn((url: string) => {
          blankPageUrl = url;
          return Promise.resolve(undefined);
        }),
        isClosed: () => false,
        url: () => blankPageUrl,
      };
      const backgroundLivePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://previous.example/jobs",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(blankPage),
        pages: () => [blankPage, backgroundLivePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });

      await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });

      expect(fakeContext.newPage).not.toHaveBeenCalled();
      expect(blankPage.goto).toHaveBeenCalledWith("https://example.com/jobs", {
        waitUntil: "domcontentloaded",
      });
      expect(blankPage.bringToFront).toHaveBeenCalled();
      expect(backgroundLivePage.goto).not.toHaveBeenCalled();
      expect(backgroundLivePage.bringToFront).not.toHaveBeenCalled();
      expect(backgroundLivePage.close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("runAgentDiscovery stops at a missing starting page instead of wandering to another board route", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-agent-missing-start-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 54647 });
      const jobExtractor = vi.fn().mockResolvedValue([]);
      let pageUrl = "about:blank";
      const page = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn((url: string) => {
          pageUrl = url;
          return Promise.resolve({ status: () => 404 });
        }),
        isClosed: () => false,
        url: () => pageUrl,
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(page),
        pages: () => [page],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        jobExtractor,
      });

      const result = await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/not-found"],
        navigationHostnames: ["example.com"],
        siteLabel: "Missing Jobs",
        dedicatedPage: true,
      });

      expect(result.jobs).toEqual([]);
      expect(result.warning).toContain("Starting page returned HTTP 404");
      expect(jobExtractor).not.toHaveBeenCalled();
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("runAgentDiscovery keeps a dedicated page the agent parked for the person open", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-agent-parked-page-"),
    );
    vi.doMock("@nestor/browser-agent", async (importOriginal) => ({
      ...(await importOriginal<typeof browserAgent>()),
      runJobSearchAgent: vi.fn().mockResolvedValue({
        jobs: [],
        steps: 3,
        incomplete: true,
        transcriptMessageCount: 4,
        accessBlockerReason: "auth_required",
        parkedPageUrl: "https://example.com/sign-in",
        warning: "This site needs a sign-in.",
      }),
    }));

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 54648 });
      let pageUrl = "about:blank";
      const page = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(200),
        goto: vi.fn((url: string) => {
          pageUrl = url;
          return Promise.resolve({ status: () => 200 });
        }),
        isClosed: () => false,
        url: () => pageUrl,
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(page),
        pages: () => [page],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });
      const claimed: unknown[] = [];

      const result = await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 3,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Sign-in Jobs",
        dedicatedPage: true,
        onAutomationPage: (claimedPage) => {
          claimed.push(claimedPage);
        },
      });

      expect(result.agentMetadata?.parkedTab).toEqual({
        tabId: null,
        url: "https://example.com/sign-in",
        title: null,
      });
      // The host binds this exact page to the sign-in request; closing it
      // here left the request pointing at a tab that no longer existed.
      expect(page.close).not.toHaveBeenCalled();
      expect(claimed).toEqual([page]);
    } finally {
      vi.doUnmock("@nestor/browser-agent");
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test.each([true, false])(
    "runAgentDiscovery reviews a usable catalog without its missing landing page (dedicatedPage=%s)",
    async (dedicatedPage) => {
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-browser-runtime-agent-catalog-missing-page-"),
      );
      vi.doMock("@nestor/browser-agent", async (importOriginal) => ({
        ...(await importOriginal<typeof browserAgent>()),
        runJobSearchAgent: vi.fn((input: browserAgent.JobSearchAgentInput) => {
          const result = {
            jobs: [createTestJob()],
            steps: 3,
            incomplete: false,
            transcriptMessageCount: 4,
          };
          input.resultCache?.write(input.config, result);
          return Promise.resolve(result);
        }),
      }));

      try {
        const chromeExecutablePath = join(userDataDir, "chrome.exe");
        await writeFile(chromeExecutablePath, "", "utf8");
        const debugPort = await reserveFreePort();
        const launchedChromeProcess = createMockChildProcess({ pid: 54648 });
        let pageUrl = "about:blank";
        const page = {
          bringToFront: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          evaluate: vi.fn().mockResolvedValue(404),
          goto: vi.fn((url: string) => {
            pageUrl = url;
            return Promise.resolve({ status: () => 404 });
          }),
          isClosed: () => false,
          url: () => pageUrl,
        };
        const fakeContext = {
          newPage: vi.fn().mockResolvedValue(page),
          pages: () => [page],
        };
        const fakeBrowser = {
          close: vi.fn(),
          contexts: () => [fakeContext],
          isConnected: () => true,
          once: vi.fn(() => fakeBrowser),
        };

        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        );
        execFileMock.mockImplementation((...args: unknown[]) => {
          maybeInvokeExecFileCallback(args);
        });
        spawnMock.mockReturnValue(launchedChromeProcess);
        connectOverCDPMock.mockResolvedValue(fakeBrowser);

        const { createBrowserAgentRuntime } =
          await import("./playwright-browser-runtime");
        const runtime = createBrowserAgentRuntime({
          userDataDir,
          chromeExecutablePath,
          debugPort,
          jobExtractor: vi.fn().mockResolvedValue([]),
        });
        const claimed: unknown[] = [];

        const result = await runtime.runAgentDiscovery!("target_site", {
          maxSteps: 3,
          targetJobCount: 1,
          userProfile: createTestProfile(),
          searchPreferences: { targetRoles: [], locations: [] },
          startingUrls: ["https://example.com/jobs"],
          navigationHostnames: ["example.com"],
          siteLabel: "Catalog Jobs",
          sourceCatalog: [createTestJob()],
          sourceCatalogComplete: true,
          dedicatedPage,
          onAutomationPage: (claimedPage) => {
            claimed.push(claimedPage);
          },
        });

        expect(result.warning).toBeNull();
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]?.title).toBe("Senior Engineer");
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.close).toHaveBeenCalledOnce();
        expect(claimed).toEqual([page]);
        const readCount = page.evaluate.mock.calls.length;
        const repeated = await runtime.runAgentDiscovery!("target_site", {
          maxSteps: 3,
          targetJobCount: 1,
          userProfile: createTestProfile(),
          searchPreferences: { targetRoles: [], locations: [] },
          startingUrls: ["https://example.com/jobs"],
          navigationHostnames: ["example.com"],
          siteLabel: "Catalog Jobs",
          sourceCatalog: [createTestJob()],
          sourceCatalogComplete: true,
          dedicatedPage,
          onAutomationPage: (claimedPage) => {
            claimed.push(claimedPage);
          },
        });
        expect(repeated.jobs).toEqual(result.jobs);
        expect(repeated.agentMetadata?.steps).toBe(0);
        expect(page.evaluate.mock.calls.length).toBe(readCount);
        expect(claimed).toEqual([page]);
      } finally {
        vi.doUnmock("@nestor/browser-agent");
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test.each([false, true])(
    "runAgentDiscovery keeps page-reader goals and rejections after a starting navigation (timeout=%s)",
    async (timeout) => {
      vi.resetModules();
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-browser-runtime-agent-selection-context-"),
      );
      let readBack: Awaited<
        ReturnType<browserAgent.JobExtractor["extractJobsFromPage"]>
      > = [];
      vi.doMock("@nestor/browser-agent", async (importOriginal) => ({
        ...(await importOriginal<typeof browserAgent>()),
        runJobSearchAgent: vi.fn(
          async (input: browserAgent.JobSearchAgentInput) => {
            readBack = await input.jobExtractor.extractJobsFromPage({
              pageText: "Senior Engineer at Example",
              pageUrl: "https://example.com/jobs",
              pageType: "search_results",
              maxJobs: 12,
              selectionContext: '{"targetRoles":["Engineer"]}',
            });
            return {
              jobs: [],
              steps: 1,
              incomplete: false,
              transcriptMessageCount: 2,
            };
          },
        ),
      }));
      try {
        const chromeExecutablePath = join(userDataDir, "chrome.exe");
        await writeFile(chromeExecutablePath, "", "utf8");
        const debugPort = await reserveFreePort();
        let pageUrl = "about:blank";
        const page = {
          bringToFront: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          evaluate: vi.fn().mockResolvedValue(200),
          goto: vi.fn().mockImplementation((url: string) => {
            pageUrl = url;
            return timeout
              ? Promise.reject(
                  Object.assign(new Error("Navigation timed out"), {
                    name: "TimeoutError",
                  }),
                )
              : Promise.resolve({ status: () => 200 });
          }),
          isClosed: () => false,
          url: () => pageUrl,
        };
        const fakeContext = {
          newPage: vi.fn().mockResolvedValue(page),
          pages: () => [page],
        };
        const fakeBrowser = {
          close: vi.fn(),
          contexts: () => [fakeContext],
          isConnected: () => true,
          once: vi.fn(() => fakeBrowser),
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        );
        execFileMock.mockImplementation((...args: unknown[]) => {
          maybeInvokeExecFileCallback(args);
        });
        spawnMock.mockReturnValue(createMockChildProcess({ pid: 54649 }));
        connectOverCDPMock.mockResolvedValue(fakeBrowser);
        const rejected = {
          ...createTestJob(),
          searchRejection: { category: "place" as const, reason: "US only." },
        };
        const jobExtractor = vi.fn().mockResolvedValue([rejected]);
        const { createBrowserAgentRuntime } =
          await import("./playwright-browser-runtime");
        const runtime = createBrowserAgentRuntime({
          userDataDir,
          chromeExecutablePath,
          debugPort,
          jobExtractor,
        });
        const discoveryResult = await runtime.runAgentDiscovery!(
          "target_site",
          {
            maxSteps: 3,
            targetJobCount: 1,
            userProfile: createTestProfile(),
            searchPreferences: { targetRoles: [], locations: [] },
            startingUrls: ["https://example.com/jobs"],
            navigationHostnames: ["example.com"],
            siteLabel: "Example Jobs",
          },
        );
        expect(discoveryResult.warning).toBeNull();
        expect(page.goto).toHaveBeenCalled();
        expect(jobExtractor).toHaveBeenCalledWith(
          expect.objectContaining({
            selectionContext: '{"targetRoles":["Engineer"]}',
          }),
        );
        expect(readBack[0]?.searchRejection).toEqual({
          category: "place",
          reason: "US only.",
        });
      } finally {
        vi.doUnmock("@nestor/browser-agent");
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test("runAgentDiscovery reuses an already-open matching page instead of navigating a blank tab", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-agent-ready-blank-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 54747 });

      let blankPageUrl = "about:blank";
      const blankPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn((url: string) => {
          blankPageUrl = url;
          return Promise.resolve(undefined);
        }),
        isClosed: () => false,
        url: () => blankPageUrl,
      };
      const backgroundTargetPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(200),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(blankPage),
        pages: () => [blankPage, backgroundTargetPage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const mockAiClient = {
        chatWithTools: vi
          .fn()
          .mockResolvedValue({ content: "done", toolCalls: [] }),
        getStatus: () => ({
          kind: "deterministic",
          role: "chat",
          ready: true,
          label: "Test AI client ready",
          model: null,
          baseUrl: null,
          modelContextWindowTokens: null,
          reservedHeadroomTokens: null,
          requestTimeoutMs: null,
          detail: null,
        }),
      } satisfies Pick<JobFinderAiClient, "chatWithTools" | "getStatus">;
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        aiClient: mockAiClient as unknown as JobFinderAiClient,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });

      await runtime.openSession("target_site");
      blankPageUrl = "about:blank";
      blankPage.goto.mockClear();
      blankPage.bringToFront.mockClear();
      backgroundTargetPage.bringToFront.mockClear();

      await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });

      // The matching page is already on the starting address, so nothing is
      // navigated: the agent starts by looking at the page it is on.
      expect(backgroundTargetPage.goto).not.toHaveBeenCalled();
      // The matching page becomes the one working tab for this source.
      expect(blankPage.goto).not.toHaveBeenCalled();
      expect(blankPage.close).toHaveBeenCalledTimes(1);
      expect(backgroundTargetPage.close).toHaveBeenCalledOnce();
      expect(backgroundTargetPage.bringToFront).not.toHaveBeenCalled();
      expect(blankPage.bringToFront).not.toHaveBeenCalled();

      // An already-open starting page can be an HTTP error. Reuse must
      // preserve the same 404 guard as a fresh navigation.
      backgroundTargetPage.evaluate.mockResolvedValue(404);
      const missing = await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });
      expect(missing.warning).toContain("Starting page returned HTTP 404");
      expect(backgroundTargetPage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("openSession reuses an existing blank startup tab instead of creating a third tab", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-blank-reuse-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 55555 });

      const closedBlankPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => true,
        url: () => "about:blank",
      };
      const openBlankPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(openBlankPage),
        pages: () => [closedBlankPage, openBlankPage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site");

      expect(fakeContext.newPage).not.toHaveBeenCalled();
      expect(openBlankPage.bringToFront).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("openSession can navigate the shared browser profile to a specific target url", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-target-open-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 56565 });

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(fakePage),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site", {
        targetUrl: "https://example.com/jobs/sign-in",
      });

      expect(fakePage.goto).toHaveBeenCalledWith(
        "https://example.com/jobs/sign-in",
        { timeout: 8_000, waitUntil: "domcontentloaded" },
      );
      expect(fakePage.bringToFront).toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("opens a fresh manual page without navigating or closing the guarded application page", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-target-open-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 56565 });

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const guardedPage = {
        close: vi.fn(),
        goto: vi.fn(),
        isClosed: () => false,
        url: () => "https://example.com/jobs/sign-in",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(fakePage),
        pages: () => [guardedPage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site", {
        targetUrl: "https://example.com/jobs/sign-in",
        reuseExistingPage: false,
      });

      expect(fakePage.goto).toHaveBeenCalledWith(
        "https://example.com/jobs/sign-in",
        { timeout: 8_000, waitUntil: "domcontentloaded" },
      );
      expect(fakePage.bringToFront).toHaveBeenCalled();
      expect(fakeContext.newPage).toHaveBeenCalledOnce();
      expect(guardedPage.goto).not.toHaveBeenCalled();
      expect(guardedPage.close).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("openSession navigates a visible blank startup tab even when another live page exists", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-target-visible-blank-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 56665 });

      const blankPage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const backgroundLivePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://previous.example/jobs",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(blankPage),
        pages: () => [blankPage, backgroundLivePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site", {
        targetUrl: "https://example.com/jobs",
      });

      expect(fakeContext.newPage).not.toHaveBeenCalled();
      expect(blankPage.goto).toHaveBeenCalledWith("https://example.com/jobs", {
        timeout: 8_000,
        waitUntil: "domcontentloaded",
      });
      expect(blankPage.bringToFront).toHaveBeenCalled();
      expect(backgroundLivePage.bringToFront).not.toHaveBeenCalled();
      expect(backgroundLivePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("openSession skips navigation when the current and target urls are structurally equivalent", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-equivalent-target-open-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 57575 });

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () =>
          "https://example.com/jobs/search/?keywords=frontend&currentJobId=123#top",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(fakePage),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site", {
        targetUrl: "https://example.com/jobs/search/?keywords=frontend",
      });

      expect(fakePage.goto).not.toHaveBeenCalled();
      expect(fakePage.bringToFront).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("openSession accepts a navigation timeout after the target origin is visibly loaded", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-target-timeout-loaded-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 58080 });
      let pageUrl = "about:blank";
      const timeoutError = Object.assign(new Error("navigation timed out"), {
        name: "TimeoutError",
      });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockImplementation(() => {
          pageUrl = "https://example.com/jobs/login";
          return Promise.reject(timeoutError);
        }),
        isClosed: () => false,
        url: () => pageUrl,
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(fakePage),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response),
        ),
      );
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await expect(
        runtime.openSession("target_site", {
          targetUrl: "https://example.com/jobs/sign-in",
        }),
      ).resolves.toEqual(expect.objectContaining({ status: "ready" }));
      expect(fakePage.goto).toHaveBeenCalledWith(
        "https://example.com/jobs/sign-in",
        { timeout: 8_000, waitUntil: "domcontentloaded" },
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
  test("openSession marks the session blocked when navigation fails", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-target-open-failure-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 58585 });

      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockRejectedValue(new Error("navigation failed")),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const fakeContext = {
        newPage: vi.fn().mockResolvedValue(fakePage),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn(),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      let debuggerReadyChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          debuggerReadyChecks += 1;
          if (debuggerReadyChecks === 1) {
            return Promise.reject(new Error("debugger not ready yet"));
          }

          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }),
      );

      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });

      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await expect(
        runtime.openSession("target_site", {
          targetUrl: "https://example.com/jobs/sign-in",
        }),
      ).rejects.toThrow("navigation failed");
      await expect(runtime.getSessionState("target_site")).resolves.toEqual(
        expect.objectContaining({
          status: "blocked",
          label: "Browser navigation failed",
        }),
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
describe("managed context service worker blocking", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
    execFileMock.mockReset();
    connectOverCDPMock.mockReset();

    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  function createRecordingContext(input: {
    pages: unknown[];
    onInstallScript?: (script: string) => void;
    serviceWorkers?: () => Array<{ url: () => string }>;
  }) {
    const installedInitScripts: string[] = [];
    const fakeContext = {
      addInitScript: vi.fn((script: string | (() => void)) => {
        const serialized =
          typeof script === "function" ? String(script) : script;
        installedInitScripts.push(serialized);
        input.onInstallScript?.(serialized);
        return Promise.resolve();
      }),
      pages: () => input.pages,
      ...(input.serviceWorkers ? { serviceWorkers: input.serviceWorkers } : {}),
    };
    return { fakeContext, installedInitScripts };
  }

  test("installs the service-worker block once on the persistent CDP context across managed flows", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-block-persistent-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 61616 });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const { fakeContext, installedInitScripts } = createRecordingContext({
        pages: [fakePage],
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort, failFirstCheck: true });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await runtime.openSession("target_site");
      await runtime.openSession("target_site");

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[1]).toContain(
        `--user-data-dir=${userDataDir}`,
      );
      expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
      expect(installedInitScripts).toHaveLength(1);
      expect(installedInitScripts[0]).toContain(
        "navigator.serviceWorker.register",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("prepare-only application flow blocks service workers before navigating the managed page", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-block-prepare-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const approvedResumePath = join(userDataDir, "alex-vanguard.pdf");
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 62626 });
      const eventOrder: string[] = [];
      const applyUrl = "https://example.com/apply/job_visual_runtime";
      let pageUrl = "about:blank";
      const fakePage = {
        on: vi.fn(),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn((url: string) => {
          pageUrl = url;
          eventOrder.push("goto");
          return Promise.resolve(undefined);
        }),
        isClosed: () => false,
        url: () => pageUrl,
      };
      const { fakeContext } = createRecordingContext({
        pages: [fakePage],
        onInstallScript: () => {
          eventOrder.push("service_worker_block");
        },
        serviceWorkers: () => [],
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort, failFirstCheck: true });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });
      let credentialSession: unknown = null;
      const retainedWizardUrl = `${applyUrl}?stage=application#step-2`;
      const prepareForm = createStubFormPreparer();

      const result = await runtime.executeApplicationFlow("target_site", {
        job: createTestJob(),
        resumeArtifact: {
          ...createTestResumeArtifact(),
          filePath: approvedResumePath,
        },
        profile: createTestProfile(),
        settings: createTestSettings(),
        mode: "prepare_only",
        prepareTaskLocalCredentials: ({ session }) => {
          credentialSession = session;
          pageUrl = retainedWizardUrl;
          eventOrder.push("task_local_credentials");
          return Promise.resolve();
        },
        prepareApplicationForm: (input) => {
          expect(input.session).toBe(credentialSession);
          expect(input.currentUrl).toBe(retainedWizardUrl);
          eventOrder.push("form_preparation");
          return prepareForm(input);
        },
        submitAuthorized: false,
      });

      expect(eventOrder).toEqual([
        "service_worker_block",
        "goto",
        "task_local_credentials",
        "form_preparation",
      ]);
      expect(fakePage.goto).toHaveBeenCalledWith(
        applyUrl,
        expect.objectContaining({ waitUntil: "domcontentloaded" }),
      );
      expect(result.executionTimings.map((entry) => entry.stage)).toContain(
        "form_preparation",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a failed application navigation reports a failed technical result instead of a Needs-you pause", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-goto-unreachable-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const approvedResumePath = join(userDataDir, "alex-vanguard.pdf");
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 63636 });
      const applyUrl = "https://example.com/apply/job_visual_runtime";
      const fakePage = {
        on: vi.fn(),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn(() =>
          Promise.reject(
            new Error(`net::ERR_NAME_NOT_RESOLVED at ${applyUrl}`),
          ),
        ),
        isClosed: () => false,
        url: () => "about:blank",
      };
      const { fakeContext } = createRecordingContext({
        pages: [fakePage],
        serviceWorkers: () => [],
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      const result = await runtime.executeApplicationFlow("target_site", {
        job: createTestJob(),
        resumeArtifact: {
          ...createTestResumeArtifact(),
          filePath: approvedResumePath,
        },
        profile: createTestProfile(),
        settings: createTestSettings(),
        mode: "prepare_only",
        prepareApplicationForm: createStubFormPreparer(),
        submitAuthorized: false,
      });

      expect(result.state).toBe("failed");
      expect(result.blocker?.code).toBe("application_page_unreachable");
      expect(result.summary).toBe(
        "Job Finder could not open the application page",
      );
      expect(result.detail).toContain(
        "Nothing was filled, attached, or submitted",
      );
      expect(result.nextActionLabel).toBe("Retry preparation");
      // Raw transport jargon stays out of every user-visible field...
      const userVisibleText = [
        result.summary,
        result.detail,
        result.blocker?.summary ?? "",
        result.blocker?.detail ?? "",
        result.checkpoints.map((checkpoint) => checkpoint.detail).join(" "),
      ].join("\n");
      expect(userVisibleText).not.toMatch(/net::|ERR_|chromium|playwright/i);
      // ...and lands only in the browser session diagnostics.
      const sessionState = await runtime.getSessionState("target_site");
      expect(sessionState).toMatchObject({
        status: "blocked",
        label: "Application navigation failed",
      });
      expect(sessionState.detail).toContain("net::ERR_NAME_NOT_RESOLVED");
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a browser that cannot open another tab reports a failed result with a plain sentence, not a Needs-you pause", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-tab-limit-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const approvedResumePath = join(userDataDir, "alex-vanguard.pdf");
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 63637 });
      const { fakeContext } = createRecordingContext({
        pages: [],
        serviceWorkers: () => [],
      });
      Object.assign(fakeContext, {
        newPage: vi.fn(() =>
          Promise.reject(
            new Error(
              "browserContext.newPage: Protocol error (Target.createTarget): Close a browser tab before opening another one.",
            ),
          ),
        ),
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      const result = await runtime.executeApplicationFlow("target_site", {
        job: createTestJob(),
        resumeArtifact: {
          ...createTestResumeArtifact(),
          filePath: approvedResumePath,
        },
        profile: createTestProfile(),
        settings: createTestSettings(),
        mode: "prepare_only",
        prepareApplicationForm: createStubFormPreparer(),
        submitAuthorized: false,
      });

      expect(result.state).toBe("failed");
      expect(result.blocker?.code).toBe("application_page_unreachable");
      expect(result.summary).toBe(
        "The Job Finder browser has too many tabs open",
      );
      expect(result.detail).toContain("Nothing was sent");
      const userVisibleText = [
        result.summary,
        result.detail,
        result.blocker?.summary ?? "",
        result.blocker?.detail ?? "",
        result.checkpoints.map((checkpoint) => checkpoint.detail).join(" "),
      ].join("\n");
      expect(userVisibleText).not.toMatch(
        /Protocol error|Target\.createTarget|newPage/,
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("warm reconnect to an already-running debugger endpoint blocks service workers without relaunching Chrome", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-block-warm-attach-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const { fakeContext, installedInitScripts } = createRecordingContext({
        pages: [fakePage],
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath: join(userDataDir, "missing-chrome.exe"),
        debugPort,
      });

      await runtime.openSession("target_site");

      expect(spawnMock).not.toHaveBeenCalled();
      expect(connectOverCDPMock).toHaveBeenCalledWith(
        `http://127.0.0.1:${debugPort}`,
        { timeout: 5_000 },
      );
      expect(installedInitScripts).toHaveLength(1);
      expect(installedInitScripts[0]).toContain(
        "navigator.serviceWorker.register",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("agent discovery shares the same service-worker-blocked managed context", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-block-discovery-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 63636 });
      const fakePage = {
        close: vi.fn().mockResolvedValue(undefined),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const { fakeContext, installedInitScripts } = createRecordingContext({
        pages: [fakePage],
      });
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort, failFirstCheck: true });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const mockAiClient = {
        chatWithTools: vi
          .fn()
          .mockResolvedValue({ content: "done", toolCalls: [] }),
        getStatus: () => ({
          kind: "deterministic",
          role: "chat",
          ready: true,
          label: "Test AI client ready",
          model: null,
          baseUrl: null,
          modelContextWindowTokens: null,
          reservedHeadroomTokens: null,
          requestTimeoutMs: null,
          detail: null,
        }),
      } satisfies Pick<JobFinderAiClient, "chatWithTools" | "getStatus">;
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
        aiClient: mockAiClient as unknown as JobFinderAiClient,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });

      await runtime.openSession("target_site");
      await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });

      expect(installedInitScripts).toHaveLength(1);
      expect(installedInitScripts[0]).toContain(
        "navigator.serviceWorker.register",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("fails the managed flow loudly when the service-worker block cannot be installed", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-block-failure-"),
    );

    try {
      const chromeExecutablePath = join(userDataDir, "chrome.exe");
      await writeFile(chromeExecutablePath, "", "utf8");
      const debugPort = await reserveFreePort();
      const launchedChromeProcess = createMockChildProcess({ pid: 64646 });
      const fakePage = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      };
      const fakeContext = {
        addInitScript: vi
          .fn()
          .mockRejectedValue(new Error("cdp init script install failed")),
        pages: () => [fakePage],
      };
      const fakeBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
        contexts: () => [fakeContext],
        isConnected: () => true,
        once: vi.fn(() => fakeBrowser),
      };

      stubDebuggerEndpointFetch({ debugPort, failFirstCheck: true });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath,
        debugPort,
      });

      await expect(runtime.openSession("target_site")).rejects.toThrow(
        "cdp init script install failed",
      );
      expect(fakeContext.addInitScript).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("exposes typed reason, target, and worker urls for orchestration surfacing", async () => {
    const { ActiveServiceWorkerBlockError } =
      await import("./playwright-browser-runtime");
    const error = new ActiveServiceWorkerBlockError({
      reason: "active_service_worker_controlling_application_origin",
      targetUrl: "https://example.com/apply/job_visual_runtime",
      detail: "Active service worker can control the application origin.",
      serviceWorkerUrls: ["https://example.com/service-worker.js"],
    });

    expect(error.name).toBe("ActiveServiceWorkerBlockError");
    expect(error.code).toBe("active_service_worker_block");
    expect(error.reason).toBe(
      "active_service_worker_controlling_application_origin",
    );
    expect(error.targetUrl).toBe(
      "https://example.com/apply/job_visual_runtime",
    );
    expect(error.serviceWorkerUrls).toEqual([
      "https://example.com/service-worker.js",
    ]);
  });
});

describe("managed context active service worker gate", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    spawnMock.mockReset();
    execFileMock.mockReset();
    connectOverCDPMock.mockReset();

    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  function createGateHarness(input: {
    activeServiceWorkers?: () => Array<{ url: () => string }>;
  }) {
    const launchedChromeProcess = createMockChildProcess({ pid: 65656 });
    const eventOrder: string[] = [];
    const applyUrl = "https://example.com/apply/job_visual_runtime";
    let pageUrl = "about:blank";
    const fakePage = {
      on: vi.fn(),
      bringToFront: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn((url: string) => {
        pageUrl = url;
        eventOrder.push("goto");
        return Promise.resolve(undefined);
      }),
      isClosed: () => false,
      url: () => pageUrl,
    };
    let secondaryPageUrl = "about:blank";
    const secondaryPage = {
      on: vi.fn(),
      bringToFront: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn((url: string) => {
        secondaryPageUrl = url;
        return Promise.resolve(undefined);
      }),
      isClosed: () => false,
      url: () => secondaryPageUrl,
    };
    const pages = [fakePage];
    const installedInitScripts: string[] = [];
    const fakeContext = {
      addInitScript: vi.fn((script: string | (() => void)) => {
        const serialized =
          typeof script === "function" ? String(script) : script;
        installedInitScripts.push(serialized);
        eventOrder.push("service_worker_block");
        return Promise.resolve();
      }),
      newPage: vi.fn(() => {
        if (!pages.includes(secondaryPage)) pages.push(secondaryPage);
        return Promise.resolve(secondaryPage);
      }),
      pages: () => pages,
      ...(input.activeServiceWorkers
        ? { serviceWorkers: input.activeServiceWorkers }
        : {}),
    };
    const fakeBrowser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: () => [fakeContext],
      isConnected: () => true,
      once: vi.fn(() => fakeBrowser),
    };

    return {
      applyUrl,
      eventOrder,
      fakeBrowser,
      fakeContext,
      fakePage,
      secondaryPage,
      installedInitScripts,
      launchedChromeProcess,
    };
  }

  async function createGatedRuntime(input: {
    userDataDir: string;
    debugPort: number;
    warmAttach?: boolean;
    browser: unknown;
    preparedFormStore?: BrowserAgentRuntimeOptions["preparedFormStore"];
  }) {
    stubDebuggerEndpointFetch({
      debugPort: input.debugPort,
      failFirstCheck: !input.warmAttach,
    });
    execFileMock.mockImplementation((...args: unknown[]) => {
      maybeInvokeExecFileCallback(args);
    });
    spawnMock.mockReturnValue(createMockChildProcess({ pid: 66666 }));
    connectOverCDPMock.mockResolvedValue(input.browser);

    const { createBrowserAgentRuntime } =
      await import("./playwright-browser-runtime");
    return createBrowserAgentRuntime({
      userDataDir: input.userDataDir,
      chromeExecutablePath: join(input.userDataDir, "chrome.exe"),
      debugPort: input.debugPort,
      ...(input.preparedFormStore ? {preparedFormStore: input.preparedFormStore} : {}),
    });
  }

  function createPrepareInput(input: { userDataDir: string }) {
    const approvedResumePath = join(input.userDataDir, "alex-vanguard.pdf");
    return {
      approvedResumePath,
      prepareInput: {
        job: createTestJob(),
        resumeArtifact: {
          ...createTestResumeArtifact(),
          filePath: approvedResumePath,
        },
        profile: createTestProfile(),
        settings: createTestSettings(),
        mode: "prepare_only" as const,
        prepareApplicationForm: createStubFormPreparer(),
        submitAuthorized: false,
      },
    };
  }

  test("the final Ready check persists declarations changed after preparation", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "nestor-ready-checkpoint-"));
    const snapshot: PreparedFormSnapshot = {
      url: "https://jobs.example.com/apply/first", structure: "a".repeat(64),
      fields: [{type: "checkbox", value: "yes", checked: false, selected: [], files: [], disabled: false, readOnly: false}],
    };
    vi.doMock("./prepared-form-recovery", async (original) => ({
      ...await original<typeof formRecovery>(),
      capturePreparedForm: () => Promise.resolve(structuredClone(snapshot)),
    }));
    vi.resetModules();
    try {
      const harness = createGateHarness({activeServiceWorkers: () => []});
      const save = vi.fn<(form: PreparedApplicationForm) => Promise<void>>().mockResolvedValue(undefined);
      const runtime = await createGatedRuntime({userDataDir, debugPort: await reserveFreePort(), browser: harness.fakeBrowser,
        preparedFormStore: {get: vi.fn().mockResolvedValue(null), save, delete: vi.fn(), loadAttachment: vi.fn()},
      });
      const {approvedResumePath, prepareInput} = createPrepareInput({userDataDir});
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const stub = createStubFormPreparer();
      await runtime.executeApplicationFlow("target_site", {...prepareInput, applicationPageBindingKey: "ready",
        prepareApplicationForm: async (args) => ({...await stub(args), state: "ready"}),
      });
      expect(save.mock.calls.at(-1)?.[0].snapshot?.fields[0]?.checked).toBe(false);
      await runtime.withApplicationPageExecution!("target_site", "ready", () => {
        snapshot.fields[0]!.checked = true;
        return Promise.resolve("ready");
      });
      expect(save.mock.calls.at(-1)?.[0].snapshot?.fields[0]?.checked).toBe(true);
    } finally {
      vi.doUnmock("./prepared-form-recovery");
      await rm(userDataDir, {recursive: true, force: true});
    }
  });

  test.each([
    ["different sites", "https://beta.test/apply/second", true],
    ["the same site", "https://jobs.example.com/apply/second", false],
  ])(
    "application preparation overlaps only for %s",
    async (_label, secondUrl, overlaps) => {
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-runtime-apply-overlap-"),
      );
      try {
        const debugPort = await reserveFreePort();
        const harness = createGateHarness({ activeServiceWorkers: () => [] });
        const runtime = await createGatedRuntime({
          userDataDir,
          debugPort,
          browser: harness.fakeBrowser,
        });
        const { approvedResumePath, prepareInput } = createPrepareInput({
          userDataDir,
        });
        await writeFile(approvedResumePath, "approved resume", "utf8");
        const stub = createStubFormPreparer();
        let releaseFirst!: () => void;
        let firstEntered!: () => void;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          firstEntered = resolve;
        });
        const firstRun = runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey: "first_bound_page",
          prepareApplicationForm: async (args) => {
            firstEntered();
            await firstGate;
            return stub(args);
          },
        });
        await entered;
        let secondEntered = false;
        const secondRun = runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey: "second_bound_page",
          job: { ...prepareInput.job, applicationUrl: secondUrl },
          prepareApplicationForm: (args) => {
            secondEntered = true;
            return stub(args);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(secondEntered).toBe(overlaps);
        if (overlaps) {
          expect(harness.secondaryPage.goto).toHaveBeenCalledWith(
            secondUrl,
            expect.anything(),
          );
          expect(harness.fakePage.close).not.toHaveBeenCalled();
          await secondRun;
        }
        releaseFirst();
        await firstRun;
        if (!overlaps) {
          await secondRun;
          expect(secondEntered).toBe(true);
        }
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["can be refilled", true, true, 2],
    ["cannot be refilled", false, false, 2],
    // One frame: the exact snapshot is attempted and fails to read the page.
    ["can be refilled, though reading it fails", true, true, 1],
  ])(
    "a waiting form that cannot be snapshotted closes to save memory only when it %s",
    async (_label, restorableByRefill, closes, frames) => {
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-runtime-hibernate-refill-"),
      );
      try {
        const debugPort = await reserveFreePort();
        const harness = createGateHarness({ activeServiceWorkers: () => [] });
        // More than one frame: the exact snapshot refuses this form.
        Object.assign(harness.fakePage, {
          frames: () => Array.from({ length: frames }, () => ({})),
        });
        const runtime = await createGatedRuntime({
          userDataDir,
          debugPort,
          browser: harness.fakeBrowser,
        });
        const { approvedResumePath, prepareInput } = createPrepareInput({
          userDataDir,
        });
        await writeFile(approvedResumePath, "approved resume", "utf8");
        // The stub ends the run waiting on the person (Needs you).
        await runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey: "waiting_page",
          restorableByRefill,
        });
        expect(
          await runtime.hibernateApplicationPageBinding!(
            "target_site",
            "waiting_page",
            () => true,
          ),
        ).toBe(closes);
        expect(harness.fakePage.close).toHaveBeenCalledTimes(closes ? 1 : 0);
        // Closed, it is no longer a live page: Open refills it instead.
        expect(
          await runtime.hasApplicationPageBinding!(
            "target_site",
            "waiting_page",
          ),
        ).toBe(!closes);
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["closes", false, true],
    ["stays open once the person pressed its Send", true, false],
  ])(
    "a Ready form handed to the person for their Send %s when the cap needs its page",
    async (_label, sendPressed, closes) => {
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-runtime-hibernate-ready-"),
      );
      try {
        const harness = createGateHarness({ activeServiceWorkers: () => [] });
        Object.assign(harness.fakePage, {
          // Two frames: no exact snapshot, so the form closes for a refill.
          frames: () => [{}, {}],
          // The page's guard: whether the person's Send went through it.
          evaluate: vi.fn().mockResolvedValue(sendPressed),
        });
        const runtime = await createGatedRuntime({
          userDataDir,
          debugPort: await reserveFreePort(),
          browser: harness.fakeBrowser,
        });
        const { approvedResumePath, prepareInput } = createPrepareInput({
          userDataDir,
        });
        await writeFile(approvedResumePath, "synthetic resume", "utf8");
        const prepare = createStubFormPreparer();
        await runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey: "ready_page",
          restorableByRefill: true,
          prepareApplicationForm: async (args) => ({
            ...(await prepare(args)),
            state: "ready" as const,
          }),
        });
        // Job Finder hands every Ready form over as soon as it is filled.
        await runtime.handApplicationPageToPerson!("target_site", "ready_page");
        expect(
          await runtime.hibernateApplicationPageBinding!(
            "target_site",
            "ready_page",
            () => true,
          ),
        ).toBe(closes);
        expect(harness.fakePage.close).toHaveBeenCalledTimes(closes ? 1 : 0);
        expect(
          await runtime.hasApplicationPageBinding!("target_site", "ready_page"),
        ).toBe(!closes);
        // A closed form is no longer the person's page; Open hands it over again.
        if (closes)
          expect(
            await runtime.readApplicationPageWithPerson!(
              "target_site",
              "ready_page",
            ),
          ).toBeNull();
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test("cancelling a same-site waiter does not touch the active form", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-runtime-apply-abort-"),
    );
    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const stub = createStubFormPreparer();
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const firstRun = runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        prepareApplicationForm: async (args) => {
          firstEntered();
          await gate;
          return stub(args);
        },
      });
      await entered;
      const controller = new AbortController();
      const waitingRun = runtime.executeApplicationFlow(
        "target_site",
        {
          ...prepareInput,
          job: {
            ...prepareInput.job,
            applicationUrl: "https://jobs.example.com/second",
          },
        },
        { signal: controller.signal },
      );
      controller.abort();
      await expect(waitingRun).rejects.toMatchObject({ name: "AbortError" });
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      expect(harness.secondaryPage.goto).not.toHaveBeenCalled();
      releaseFirst();
      await firstRun;
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a redirect into another active application's site waits before form work", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-runtime-redirect-lock-"),
    );
    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const firstGoto = harness.fakePage.goto.getMockImplementation()!;
      const secondGoto = harness.secondaryPage.goto.getMockImplementation()!;
      harness.fakePage.goto.mockImplementation(() =>
        firstGoto("https://account.shared.example/form/first"),
      );
      harness.secondaryPage.goto.mockImplementation(() =>
        secondGoto("https://account.shared.example/form/second"),
      );
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const stub = createStubFormPreparer();
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const firstRun = runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "redirect_first",
        prepareApplicationForm: async (args) => {
          firstEntered();
          await gate;
          return stub(args);
        },
      });
      await entered;
      let secondEntered = false;
      const secondRun = runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "redirect_second",
        job: {
          ...prepareInput.job,
          applicationUrl: "https://other.test/apply/second",
        },
        prepareApplicationForm: (args) => {
          secondEntered = true;
          return stub(args);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.secondaryPage.goto).toHaveBeenCalled();
      expect(secondEntered).toBe(false);
      releaseFirst();
      await Promise.all([firstRun, secondRun]);
      expect(secondEntered).toBe(true);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a final page operation waits for same-site preparation while another site proceeds", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-runtime-final-site-"),
    );
    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const originalNewPage =
        harness.fakeContext.newPage.getMockImplementation()!;
      const originalPages = harness.fakeContext.pages;
      let thirdUrl = "about:blank";
      let thirdAdded = false;
      const thirdPage = {
        on: vi.fn(),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn((url: string) => {
          thirdUrl = url;
          return Promise.resolve(undefined);
        }),
        isClosed: () => false,
        url: () => thirdUrl,
      };
      harness.fakeContext.newPage
        .mockImplementationOnce(originalNewPage)
        .mockImplementationOnce(() => {
          thirdAdded = true;
          return Promise.resolve(thirdPage);
        });
      Object.assign(harness.fakeContext, {
        pages: () => [...originalPages(), ...(thirdAdded ? [thirdPage] : [])],
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const stub = createStubFormPreparer();
      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "ready_for_final",
      });

      let releaseSameSite!: () => void;
      let sameSiteEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseSameSite = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        sameSiteEntered = resolve;
      });
      const sameSiteRun = runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "same_site_busy",
        job: {
          ...prepareInput.job,
          applicationUrl: "https://jobs.example.com/second",
        },
        prepareApplicationForm: async (args) => {
          sameSiteEntered();
          await gate;
          return stub(args);
        },
      });
      await entered;

      let finalEntered = false;
      let finalPageUrl: string | null = null;
      const finalOperation = runtime.withApplicationPageExecution!(
        "target_site",
        "ready_for_final",
        () => {
          finalEntered = true;
          finalPageUrl = harness.fakePage.url();
          return Promise.resolve("sent");
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finalEntered).toBe(false);
      await harness.fakePage.goto("https://elsewhere.test/wizard");

      let otherSiteEntered = false;
      const otherSiteRun = runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "other_site_ready",
        job: {
          ...prepareInput.job,
          applicationUrl: "https://elsewhere.test/apply",
        },
        prepareApplicationForm: (args) => {
          otherSiteEntered = true;
          return stub(args);
        },
      });
      await otherSiteRun;
      expect(otherSiteEntered).toBe(true);
      expect(finalEntered).toBe(false);
      releaseSameSite();
      await sameSiteRun;
      await expect(finalOperation).resolves.toBe("sent");
      expect(finalEntered).toBe(true);
      expect(finalPageUrl).toBe("https://elsewhere.test/wizard");
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("discovery waits for capacity, resumes after cleanup, and preserves the occupied forms", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-discovery-capacity-"),
    );
    vi.doMock("@nestor/browser-agent", async (importOriginal) => ({
      ...(await importOriginal<typeof browserAgent>()),
      runJobSearchAgent: vi.fn().mockResolvedValue({
        jobs: [],
        steps: 1,
        incomplete: false,
        transcriptMessageCount: 1,
      }),
    }));
    try {
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      await harness.fakePage.goto("https://prepared.example/form");
      let occupied = 8;
      const forms = Array.from({ length: 7 }, () => ({
        isClosed: () => false,
        url: () => "https://prepared.example/form",
        close: vi.fn(),
      }));
      Object.assign(harness.fakeContext, { pages: () => forms });
      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        jobExtractor: vi.fn().mockResolvedValue([]),
        browserHost: {
          connect: () => Promise.resolve(harness.fakeBrowser as never),
          getOpenBrowser: () => Promise.resolve(harness.fakeBrowser as never),
          close: () => Promise.resolve(),
          assertAutomationSafe: () => undefined,
          openTabCount: () => occupied,
        },
      });
      const onWaiting = vi.fn();
      const controller = new AbortController();
      const run = runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://jobs.example/list"],
        navigationHostnames: ["jobs.example"],
        siteLabel: "Example Jobs",
        dedicatedPage: true,
        signal: controller.signal,
        onWaitingForBrowserTab: onWaiting,
      });
      await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      expect(harness.fakeContext.newPage).not.toHaveBeenCalled();
      occupied = 6;
      forms.splice(0, 1);
      const result = await run;
      expect(result.warning).not.toContain("Target.createTarget");
      expect(harness.fakeContext.newPage).toHaveBeenCalledOnce();
      expect(forms.every((page) => page.close.mock.calls.length === 0)).toBe(
        true,
      );
    } finally {
      vi.doUnmock("@nestor/browser-agent");
      await rm(userDataDir, { recursive: true, force: true });
    }
  }, 15000);

  test("embedded tab headroom waits abortably without closing existing tabs", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-runtime-tab-headroom-"),
    );
    try {
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      // A form page, not the idle startup tab (that one may be closed for room).
      await harness.fakePage.goto("https://held.example/primary");
      const otherPages = Array.from({ length: 6 }, (_, index) => ({
        isClosed: () => false,
        url: () => `https://held.example/${index}`,
        close: vi.fn().mockResolvedValue(undefined),
      }));
      Object.assign(harness.fakeContext, {
        pages: () => [harness.fakePage, ...otherPages],
      });
      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        browserHost: {
          connect: () => Promise.resolve(harness.fakeBrowser as never),
          getOpenBrowser: () => Promise.resolve(harness.fakeBrowser as never),
          close: () => Promise.resolve(),
          assertAutomationSafe: () => undefined,
        },
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const controller = new AbortController();
      const run = runtime.executeApplicationFlow("target_site", prepareInput, {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(harness.fakeContext.newPage).not.toHaveBeenCalled();
      controller.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      expect(
        otherPages.every((page) => page.close.mock.calls.length === 0),
      ).toBe(true);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("concurrent embedded tab openings reserve popup headroom atomically", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-runtime-tab-reservation-"),
    );
    try {
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      // A blank tab can belong to another worker still opening its page.
      await harness.fakePage.goto("https://held.example/primary");
      const otherPages = Array.from({ length: 5 }, (_, index) => ({
        isClosed: () => false,
        url: () =>
          index === 0 ? "about:blank" : `https://held.example/${index}`,
        close: vi.fn().mockResolvedValue(undefined),
      }));
      let resolveNewPage!: (page: typeof harness.secondaryPage) => void;
      let newPageStarted!: () => void;
      const opening = new Promise<typeof harness.secondaryPage>((resolve) => {
        resolveNewPage = resolve;
      });
      const started = new Promise<void>((resolve) => {
        newPageStarted = resolve;
      });
      Object.assign(harness.fakeContext, {
        pages: () => [harness.fakePage, ...otherPages],
        newPage: vi.fn(() => {
          newPageStarted();
          return opening;
        }),
      });
      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        browserHost: {
          connect: () => Promise.resolve(harness.fakeBrowser as never),
          getOpenBrowser: () => Promise.resolve(harness.fakeBrowser as never),
          close: () => Promise.resolve(),
          assertAutomationSafe: () => undefined,
        },
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const first = runtime.executeApplicationFlow("target_site", prepareInput);
      await started;
      const controller = new AbortController();
      const second = runtime.executeApplicationFlow(
        "target_site",
        {
          ...prepareInput,
          job: {
            ...prepareInput.job,
            applicationUrl: "https://other.test/apply",
          },
        },
        { signal: controller.signal },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(harness.fakeContext.newPage).toHaveBeenCalledTimes(1);
      controller.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      resolveNewPage(harness.secondaryPage);
      await first;
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      expect(
        otherPages.every((page) => page.close.mock.calls.length === 0),
      ).toBe(true);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("prepare-only flow fails closed without navigating when an application-origin service worker is active", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-controlling-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => [
          { url: () => "https://example.com/service-worker.js" },
        ],
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(result.state).toBe("paused");
      expect(result.blocker?.code).toBe("requires_manual_review");
      expect(result.blocker?.detail).toContain(
        "can control the application origin https://example.com",
      );
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
      expect(harness.eventOrder).toEqual(["service_worker_block"]);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("prepare-only flow continues when active workers cannot control the application origin", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-cross-origin-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => [
          { url: () => "https://tracker.example.net/service-worker.js" },
        ],
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(harness.eventOrder).toEqual(["service_worker_block", "goto"]);
      expect(harness.fakePage.goto).toHaveBeenCalledWith(
        harness.applyUrl,
        expect.objectContaining({ waitUntil: "domcontentloaded" }),
      );
      expect(result.executionTimings.map((entry) => entry.stage)).toContain(
        "form_preparation",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("prepare-only flow fails closed when a worker origin cannot be safely determined", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-unresolved-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => [
          { url: () => "chrome-extension://abcdef/background.js" },
        ],
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(result.state).toBe("paused");
      expect(result.blocker?.code).toBe("requires_manual_review");
      expect(result.blocker?.detail).toContain("cannot be safely determined");
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("warm reconnect with a pre-existing application-origin service worker fails closed without relaunching or navigating", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-warm-active-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => [
          { url: () => "https://example.com/service-worker.js" },
        ],
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        warmAttach: true,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(spawnMock).not.toHaveBeenCalled();
      expect(connectOverCDPMock).toHaveBeenCalledWith(
        `http://127.0.0.1:${debugPort}`,
        { timeout: 5_000 },
      );
      expect(result.state).toBe("paused");
      expect(result.blocker?.detail).toContain(
        "can control the application origin",
      );
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("warm reconnect with zero active service workers continues preparation", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-warm-clear-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        warmAttach: true,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(spawnMock).not.toHaveBeenCalled();
      expect(harness.eventOrder).toEqual(["service_worker_block", "goto"]);
      expect(result.executionTimings.map((entry) => entry.stage)).toContain(
        "form_preparation",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test.each(["submitted", "failed", "unsupported"] as const)(
    "closes a %s application's bound page immediately",
    async (state) => {
      const userDataDir = await mkdtemp(
        join(tmpdir(), "nestor-terminal-page-"),
      );
      try {
        const harness = createGateHarness({ activeServiceWorkers: () => [] });
        const runtime = await createGatedRuntime({
          userDataDir,
          debugPort: await reserveFreePort(),
          browser: harness.fakeBrowser,
        });
        const { approvedResumePath, prepareInput } = createPrepareInput({
          userDataDir,
        });
        await writeFile(approvedResumePath, "synthetic resume");
        const result = await runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey: "terminal_result",
          prepareApplicationForm: async (args) => ({
            ...(await prepareInput.prepareApplicationForm(args)),
            state,
          }),
        });
        expect(result.state).toBe(state);
        expect(harness.fakePage.close).toHaveBeenCalledOnce();
        expect(harness.secondaryPage.close).not.toHaveBeenCalled();
        await expect(
          runtime.hasApplicationPageBinding!("target_site", "terminal_result"),
        ).resolves.toBe(false);
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test("a retry transfers and reuses its filled wizard page without another navigation", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "nestor-retry-page-"));
    try {
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      Object.assign(harness.fakePage, {
        evaluate: vi.fn().mockResolvedValue(undefined),
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort: await reserveFreePort(),
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "synthetic resume");
      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "previous_result",
      });
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      await harness.fakePage.goto(
        "https://example.com/apply/job_visual_runtime?step=2",
      );
      harness.fakePage.goto.mockClear();
      await expect(
        runtime.transferApplicationPageBinding!(
          "target_site",
          "previous_result",
          "retry_result",
        ),
      ).resolves.toBe(true);
      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "retry_result",
      });
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
      expect(harness.fakeContext.newPage).not.toHaveBeenCalled();
      await expect(
        runtime.hasApplicationPageBinding!("target_site", "previous_result"),
      ).resolves.toBe(false);
      await expect(
        runtime.hasApplicationPageBinding!("target_site", "retry_result"),
      ).resolves.toBe(true);
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      await runtime.releaseApplicationPageBinding!(
        "target_site",
        "retry_result",
      );
      expect(harness.fakePage.close).toHaveBeenCalledOnce();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a form the person opened to finish closes when its application ends", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "nestor-handed-page-"));
    try {
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      Object.assign(harness.fakePage, {
        evaluate: vi.fn().mockResolvedValue(undefined),
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort: await reserveFreePort(),
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "synthetic resume");
      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey: "handed_result",
      });
      await runtime.handApplicationPageToPerson!(
        "target_site",
        "handed_result",
      );
      await expect(
        runtime.releaseApplicationPageBinding!("target_site", "handed_result"),
      ).resolves.toBeUndefined();
      expect(harness.fakePage.close).toHaveBeenCalledOnce();
      await expect(
        runtime.hasApplicationPageBinding!("target_site", "handed_result"),
      ).resolves.toBe(false);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test.each(["finished", "failed", "aborted", "parked"] as const)(
    "releases a shared search page when %s, except a person handoff",
    async (ending) => {
      const userDataDir = await mkdtemp(join(tmpdir(), "nestor-search-page-"));
      const controller = new AbortController();
      vi.doMock("@nestor/browser-agent", async (importOriginal) => ({
        ...(await importOriginal<typeof browserAgent>()),
        runJobSearchAgent: vi.fn(() => {
          if (ending === "failed") throw new Error("synthetic search failure");
          if (ending === "aborted") {
            controller.abort();
            throw new DOMException("Stopped", "AbortError");
          }
          return Promise.resolve({
            jobs: [],
            steps: 1,
            incomplete: false,
            transcriptMessageCount: 1,
            ...(ending === "parked"
              ? { parkedPageUrl: "https://jobs.example/login" }
              : {}),
          });
        }),
      }));
      try {
        const harness = createGateHarness({ activeServiceWorkers: () => [] });
        Object.assign(harness.fakePage, {
          evaluate: vi.fn().mockResolvedValue(null),
        });
        const { createBrowserAgentRuntime } =
          await import("./playwright-browser-runtime");
        const runtime = createBrowserAgentRuntime({
          userDataDir,
          jobExtractor: vi.fn().mockResolvedValue([]),
          browserHost: {
            connect: () => Promise.resolve(harness.fakeBrowser as never),
            getOpenBrowser: () => Promise.resolve(harness.fakeBrowser as never),
            close: () => Promise.resolve(),
            assertAutomationSafe: () => undefined,
          },
        });
        const run = runtime.runAgentDiscovery!("target_site", {
          maxSteps: 1,
          targetJobCount: 1,
          userProfile: createTestProfile(),
          searchPreferences: { targetRoles: [], locations: [] },
          startingUrls: ["https://jobs.example/list"],
          navigationHostnames: ["jobs.example"],
          siteLabel: "Synthetic Jobs",
          signal: controller.signal,
        });
        if (ending === "aborted")
          await expect(run).rejects.toMatchObject({ name: "AbortError" });
        else await run;
        if (ending === "parked")
          expect(harness.fakePage.close).not.toHaveBeenCalled();
        else expect(harness.fakePage.close).toHaveBeenCalled();
        expect(harness.secondaryPage.close).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock("@nestor/browser-agent");
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  );

  test("continuation keeps the exact bound wizard page instead of a stale listing checkpoint", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-bound-continuation-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const applicationPageBindingKey = "result_wizard";

      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey,
      });
      await harness.fakePage.goto(
        "https://example.com/apply/job_visual_runtime?step=2#captcha",
      );
      harness.fakePage.goto.mockClear();

      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey,
        startingUrl:
          "https://example.com/apply/job_visual_runtime?step=1#checkpoint",
      });

      expect(harness.fakePage.goto).not.toHaveBeenCalled();
      expect(harness.fakePage.url()).toBe(
        "https://example.com/apply/job_visual_runtime?step=2#captcha",
      );

      await harness.fakePage.goto("https://unrelated.example.net/account");
      harness.fakePage.goto.mockClear();
      await expect(
        runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey,
          startingUrl:
            "https://example.com/apply/job_visual_runtime?step=2#captcha",
        }),
      ).rejects.toThrow("left the allowed application origins");
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("opening another target preserves an older result-bound application page", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-bound-open-session-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const applicationPageBindingKey = "result_prepared_first";

      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey,
      });
      harness.fakePage.close.mockClear();
      harness.fakePage.goto.mockClear();

      await runtime.openSession("target_site", {
        targetUrl: "https://example.com/jobs/second",
      });

      expect(harness.fakeContext.newPage).toHaveBeenCalledOnce();
      expect(harness.secondaryPage.goto).toHaveBeenCalledWith(
        "https://example.com/jobs/second",
        { timeout: 8_000, waitUntil: "domcontentloaded" },
      );
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
      expect(harness.fakePage.close).not.toHaveBeenCalled();
      await expect(
        runtime.hasApplicationPageBinding?.(
          "target_site",
          applicationPageBindingKey,
        ),
      ).resolves.toBe(true);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("continuation fails closed when its exact bound wizard page was closed", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-closed-continuation-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({ activeServiceWorkers: () => [] });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");
      const applicationPageBindingKey = "result_closed_wizard";

      await runtime.executeApplicationFlow("target_site", {
        ...prepareInput,
        applicationPageBindingKey,
      });
      vi.spyOn(harness.fakePage, "isClosed").mockReturnValue(true);
      harness.fakePage.goto.mockClear();

      await expect(
        runtime.executeApplicationFlow("target_site", {
          ...prepareInput,
          applicationPageBindingKey,
          startingUrl:
            "https://example.com/apply/job_visual_runtime?step=2#captcha",
        }),
      ).rejects.toThrow("prepared application page was closed");
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("fails closed when service worker inspection is unavailable instead of assuming no workers", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-unavailable-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({});
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(result.state).toBe("paused");
      expect(result.blocker?.detail).toContain("could not be inspected");
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("fails closed when service worker inspection throws instead of assuming no workers", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-inspect-throws-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => {
          throw new Error("cdp service worker enumeration failed");
        },
      });
      const runtime = await createGatedRuntime({
        userDataDir,
        debugPort,
        browser: harness.fakeBrowser,
      });
      const { approvedResumePath, prepareInput } = createPrepareInput({
        userDataDir,
      });
      await writeFile(approvedResumePath, "approved resume", "utf8");

      const result = await runtime.executeApplicationFlow(
        "target_site",
        prepareInput,
      );

      expect(result.state).toBe("paused");
      expect(result.blocker?.detail).toContain("could not be inspected");
      expect(harness.fakePage.goto).not.toHaveBeenCalled();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("agent discovery is not gated by active service workers on the shared context", async () => {
    const userDataDir = await mkdtemp(
      join(tmpdir(), "nestor-browser-runtime-sw-gate-discovery-"),
    );

    try {
      const debugPort = await reserveFreePort();
      const harness = createGateHarness({
        activeServiceWorkers: () => [
          { url: () => "https://example.com/service-worker.js" },
        ],
      });
      // Reusing the open starting page first reads its navigation status.
      Object.assign(harness.fakePage, {
        evaluate: vi.fn().mockResolvedValue(null),
      });
      const mockAiClient = {
        chatWithTools: vi
          .fn()
          .mockResolvedValue({ content: "done", toolCalls: [] }),
        getStatus: () => ({
          kind: "deterministic",
          role: "chat",
          ready: true,
          label: "Test AI client ready",
          model: null,
          baseUrl: null,
          modelContextWindowTokens: null,
          reservedHeadroomTokens: null,
          requestTimeoutMs: null,
          detail: null,
        }),
      } satisfies Pick<JobFinderAiClient, "chatWithTools" | "getStatus">;

      stubDebuggerEndpointFetch({ debugPort, failFirstCheck: true });
      execFileMock.mockImplementation((...args: unknown[]) => {
        maybeInvokeExecFileCallback(args);
      });
      spawnMock.mockReturnValue(harness.launchedChromeProcess);
      connectOverCDPMock.mockResolvedValue(harness.fakeBrowser);

      const { createBrowserAgentRuntime } =
        await import("./playwright-browser-runtime");
      const runtime = createBrowserAgentRuntime({
        userDataDir,
        chromeExecutablePath: join(userDataDir, "chrome.exe"),
        debugPort,
        aiClient: mockAiClient as unknown as JobFinderAiClient,
        jobExtractor: vi.fn().mockResolvedValue([]),
      });

      const discoveryResult = await runtime.runAgentDiscovery!("target_site", {
        maxSteps: 1,
        targetJobCount: 1,
        userProfile: createTestProfile(),
        searchPreferences: { targetRoles: [], locations: [] },
        startingUrls: ["https://example.com/jobs"],
        navigationHostnames: ["example.com"],
        siteLabel: "Example Jobs",
      });

      expect(discoveryResult.agentMetadata?.steps).toBeGreaterThan(0);
      expect(mockAiClient.chatWithTools).toHaveBeenCalled();
      expect(harness.installedInitScripts).toHaveLength(1);
      expect(harness.installedInitScripts[0]).toContain(
        "navigator.serviceWorker.register",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

import * as browserRuntimeModule from "@nestor/browser-runtime";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenBrowserSessionOptions } from "@nestor/browser-runtime";
import {
  createDesktopBrowserRuntime,
  createDesktopJobFinderAiClient,
  createDesktopResumeVisionProvider,
} from "./create-workspace-service";
import {
  getDesktopTestDelayMs,
  getResumePreviewTestMode,
  getTestBrowserSessionStatus,
  isBrowserAgentEnabled,
  parseResumeImportPathPayload,
  resetInvalidBooleanEnvWarnings,
} from "./test-api";

describe("createDesktopJobFinderAiClient", () => {
  test.each([
    [
      "with an API key present",
      { NESTOR_ENABLE_TEST_API: "1", NESTOR_AI_API_KEY: "test-api-key" },
    ],
    ["without an API key configured", { NESTOR_ENABLE_TEST_API: "1" }],
  ])(
    "keeps the deterministic client when the desktop test API is enabled %s",
    (_label, env) => {
      const client = createDesktopJobFinderAiClient(env);

      expect(client.chatWithTools).toBeUndefined();
      expect(client.getStatus().kind).toBe("deterministic");
    },
  );

  test("allows live AI when the test API explicitly requests it", () => {
    const client = createDesktopJobFinderAiClient({
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "1",
      NESTOR_AI_API_KEY: "test-api-key",
      NESTOR_AI_BASE_URL: "https://example.invalid/v1",
      NESTOR_AI_MODEL: "test-model",
    });

    expect(client.chatWithTools).toBeTypeOf("function");
    expect(client.getStatus().kind).toBe("openai_compatible");
  });

  test("keeps deterministic behavior when live AI is requested without an API key", () => {
    const client = createDesktopJobFinderAiClient({
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "1",
    });

    expect(client.chatWithTools).toBeUndefined();
    expect(client.getStatus().kind).toBe("deterministic");
  });
});

describe("createDesktopResumeVisionProvider", () => {
  test("keeps deterministic vision when the desktop test API is enabled", () => {
    const provider = createDesktopResumeVisionProvider({
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_AI_API_KEY: "test-api-key",
    });

    expect(provider.getStatus().kind).toBe("deterministic");
  });

  test("allows live configured vision when the test API explicitly requests it", () => {
    const provider = createDesktopResumeVisionProvider({
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "1",
      NESTOR_AI_API_KEY: "test-api-key",
      NESTOR_AI_BASE_URL: "https://example.invalid/v1",
    });

    const status = provider.getStatus();

    expect(status.kind).toBe("openai_compatible_vision");
    expect(status.model).toBe("muse-spark-1.3-contributor");
    expect(status.baseUrl).toBe("https://example.invalid/v1");
  });
});

describe("createDesktopBrowserRuntime", () => {
  test("rejects targeted browser opens when the browser agent runtime is disabled", async () => {
    const browserRuntime = createDesktopBrowserRuntime({
      env: { NESTOR_BROWSER_AGENT: "0" },
      aiClient: createDesktopJobFinderAiClient({ NESTOR_BROWSER_AGENT: "0" }),
      desktopTestApiEnabled: false,
    });

    await expect(
      browserRuntime.openSession("target_site", {
        targetUrl: "https://www.linkedin.com/jobs/search/",
      }),
    ).rejects.toThrow(
      "Targeted sign-in requires the browser agent runtime, but it is disabled in this desktop build.",
    );
  });

  test("rejects target-id browser opens when the browser agent runtime is disabled", async () => {
    const browserRuntime = createDesktopBrowserRuntime({
      env: { NESTOR_BROWSER_AGENT: "0" },
      aiClient: createDesktopJobFinderAiClient({ NESTOR_BROWSER_AGENT: "0" }),
      desktopTestApiEnabled: false,
    });

    await expect(
      browserRuntime.openSession("target_site", {
        targetId: "target_linkedin_default",
      } satisfies OpenBrowserSessionOptions),
    ).rejects.toThrow(
      "Targeted sign-in requires the browser agent runtime, but it is disabled in this desktop build.",
    );
  });

  test("keeps generic browser opens available when the browser agent runtime is disabled", async () => {
    const browserRuntime = createDesktopBrowserRuntime({
      env: { NESTOR_BROWSER_AGENT: "0" },
      aiClient: createDesktopJobFinderAiClient({ NESTOR_BROWSER_AGENT: "0" }),
      desktopTestApiEnabled: false,
    });

    const session = await browserRuntime.openSession("target_site");

    expect(session.driver).toBe("catalog_seed");
  });

  // The agent-backed runtimes resolve their profile directory from the
  // desktop user-data path, which Electron owns; point it at a scratch
  // directory so the lane can be constructed without an Electron app.
  beforeEach(() => {
    vi.stubEnv(
      "NESTOR_USER_DATA_DIR",
      path.join(tmpdir(), "nestor-browser-lane-test"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("never seeds a catalog_seed session under the embedded browser host", async () => {
    // Before any search runs the session state is what the whole Find jobs
    // screen reads. Reporting the catalog lane here makes a working
    // agent-backed build tell the user it cannot search.
    const env = {
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_HOST: "embedded",
    };
    const browserRuntime = createDesktopBrowserRuntime({
      env,
      aiClient: createDesktopJobFinderAiClient(env),
      desktopTestApiEnabled: true,
    });

    const session = await browserRuntime.getSessionState("target_site");

    expect(session.driver).not.toBe("catalog_seed");
    expect(session.driver).toBe("embedded_browser_agent");
  });

  test("wires the host's live working count into application reservations", () => {
    const factory = vi.spyOn(browserRuntimeModule, "createBrowserAgentRuntime");
    const embedded = getEmbeddedBrowser();
    const capacity = vi
      .spyOn(embedded, "hasAutomationTabCapacity")
      .mockReturnValue(false);
    const working = vi.spyOn(embedded, "workingTabCount").mockReturnValue(2);
    const total = vi.spyOn(embedded, "openTabCount").mockReturnValue(12);
    const env = {
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_HOST: "embedded",
    };
    createDesktopBrowserRuntime({
      env,
      aiClient: createDesktopJobFinderAiClient(env),
      desktopTestApiEnabled: true,
    });
    const host = factory.mock.calls.at(-1)?.[0].browserHost;
    expect(host?.openTabCount?.()).toBe(12);
    expect(host?.workingTabCount?.()).toBe(2);
    expect(host?.hasAutomationTabCapacity?.()).toBe(false);
    capacity.mockRestore();
    working.mockRestore();
    total.mockRestore();
    factory.mockRestore();
  });

  test("reports the connected Chrome lane when the browser host is external", async () => {
    const env = {
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_HOST: "external",
    };
    const browserRuntime = createDesktopBrowserRuntime({
      env,
      aiClient: createDesktopJobFinderAiClient(env),
      desktopTestApiEnabled: true,
    });

    const session = await browserRuntime.getSessionState("target_site");

    expect(session.driver).toBe("chrome_profile_agent");
  });
});

describe("isBrowserAgentEnabled", () => {
  beforeEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  test("defaults to enabled when the flag is unset", () => {
    expect(isBrowserAgentEnabled({})).toBe(true);
  });

  test("treats blank values as unset without warning", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "" })).toBe(true);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "   " })).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("ignores the removed LinkedIn-specific alias when the generic flag is unset", () => {
    expect(isBrowserAgentEnabled({ NESTOR_LINKEDIN_BROWSER_AGENT: "0" })).toBe(
      true,
    );
  });

  test("disables only for explicit false values", () => {
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "0" })).toBe(false);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "false" })).toBe(
      false,
    );
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: " FALSE " })).toBe(
      false,
    );
  });

  test("enables explicit true values and warns once for unknown values while defaulting to enabled", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "1" })).toBe(true);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "TRUE" })).toBe(true);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "yes" })).toBe(true);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "yes" })).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktop test-api] Unrecognized NESTOR_BROWSER_AGENT value: "yes". Falling back to the default enabled behavior.',
    );
  });

  test("dedupes unknown values across casing and whitespace differences", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: " yes " })).toBe(true);
    expect(isBrowserAgentEnabled({ NESTOR_BROWSER_AGENT: "YES" })).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktop test-api] Unrecognized NESTOR_BROWSER_AGENT value: "yes". Falling back to the default enabled behavior.',
    );
  });
});

describe("parseResumeImportPathPayload", () => {
  test("trims source paths at the test API boundary", () => {
    expect(
      parseResumeImportPathPayload({ sourcePath: "  C:/tmp/resume.pdf  " }),
    ).toEqual({ sourcePath: "C:/tmp/resume.pdf" });
  });

  test("preserves explicit useVision comparison overrides", () => {
    expect(
      parseResumeImportPathPayload({
        sourcePath: "C:/tmp/resume.pdf",
        useVision: false,
      }),
    ).toEqual({ sourcePath: "C:/tmp/resume.pdf", useVision: false });
  });

  test("preserves explicit useVision enabled overrides", () => {
    expect(
      parseResumeImportPathPayload({
        sourcePath: "C:/tmp/resume.pdf",
        useVision: true,
      }),
    ).toEqual({ sourcePath: "C:/tmp/resume.pdf", useVision: true });
  });

  test("ignores non-boolean useVision values", () => {
    expect(
      parseResumeImportPathPayload({
        sourcePath: "C:/tmp/resume.pdf",
        useVision: "0",
      }),
    ).toEqual({ sourcePath: "C:/tmp/resume.pdf" });
  });
});

describe("getTestBrowserSessionStatus", () => {
  beforeEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  test("returns null when the override is unset or blank", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(getTestBrowserSessionStatus({})).toBeNull();
    expect(
      getTestBrowserSessionStatus({
        NESTOR_TEST_BROWSER_SESSION_STATUS: "   ",
      }),
    ).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("parses valid browser session statuses", () => {
    expect(
      getTestBrowserSessionStatus({
        NESTOR_TEST_BROWSER_SESSION_STATUS: "login_required",
      }),
    ).toBe("login_required");
    expect(
      getTestBrowserSessionStatus({
        NESTOR_TEST_BROWSER_SESSION_STATUS: " blocked ",
      }),
    ).toBe("blocked");
  });

  test("warns once and ignores invalid overrides", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(
      getTestBrowserSessionStatus({
        NESTOR_TEST_BROWSER_SESSION_STATUS: "needs_login",
      }),
    ).toBeNull();
    expect(
      getTestBrowserSessionStatus({
        NESTOR_TEST_BROWSER_SESSION_STATUS: "needs_login",
      }),
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktop test-api] Unrecognized NESTOR_TEST_BROWSER_SESSION_STATUS value: "needs_login". Falling back to the default no-override behavior.',
    );
  });
});

describe("getDesktopTestDelayMs", () => {
  beforeEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  test("accepts trimmed numeric delay values", () => {
    expect(
      getDesktopTestDelayMs(" 250 ", "NESTOR_TEST_PROFILE_COPILOT_DELAY_MS"),
    ).toBe(250);
  });

  test("rejects numeric prefixes with a warning", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(
      getDesktopTestDelayMs("250ms", "NESTOR_TEST_PROFILE_COPILOT_DELAY_MS"),
    ).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktop test-api] Unrecognized NESTOR_TEST_PROFILE_COPILOT_DELAY_MS value: "250ms". Falling back to the default disabled behavior.',
    );
  });
});

describe("getResumePreviewTestMode", () => {
  beforeEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetInvalidBooleanEnvWarnings();
    vi.restoreAllMocks();
  });

  test("defaults to ok when unset or blank", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(getResumePreviewTestMode({})).toBe("ok");
    expect(
      getResumePreviewTestMode({ NESTOR_TEST_RESUME_PREVIEW: "   " }),
    ).toBe("ok");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("accepts fail_once override", () => {
    expect(
      getResumePreviewTestMode({ NESTOR_TEST_RESUME_PREVIEW: "fail_once" }),
    ).toBe("fail_once");
  });

  test("warns once and falls back to ok for invalid overrides", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(
      getResumePreviewTestMode({ NESTOR_TEST_RESUME_PREVIEW: "broken" }),
    ).toBe("ok");
    expect(
      getResumePreviewTestMode({ NESTOR_TEST_RESUME_PREVIEW: "broken" }),
    ).toBe("ok");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[desktop test-api] Unrecognized NESTOR_TEST_RESUME_PREVIEW value: "broken". Falling back to the default "ok" behavior.',
    );
  });
});

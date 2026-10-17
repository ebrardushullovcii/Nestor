import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import { describe, expect, test, vi } from "vitest";
import {
  bringPageToFrontBestEffort,
  buildChromeExecutableCandidates,
  findRunningChromeDebugPortInCommandLines,
  isHttpUrlLike,
  isLikelyStalePage,
  isWarmPageReusable,
  isTcpPortReachable,
  parseRunningChromeDebugSession,
  readDevToolsActivePort,
  selectLiveHttpPage,
  validateJobPostings,
} from "./playwright-browser-runtime-utils";
import {
  createAgentChatWithToolsBridge,
  resolveAgentDiscoveryChatWithTools,
} from "./playwright-browser-runtime";

type StalePageLike = Pick<
  Parameters<typeof isLikelyStalePage>[0],
  "isClosed" | "url"
>;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  try {
    run();
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
}

describe("playwright browser runtime utils", () => {
  test("does not block browser startup when Chrome never settles bringToFront", async () => {
    const bringToFront = vi.fn(() => new Promise<void>(() => undefined));

    await expect(
      bringPageToFrontBestEffort({ bringToFront }, 1),
    ).resolves.toBeUndefined();
    expect(bringToFront).toHaveBeenCalledTimes(1);
  });
  test("returns an empty array for non-array job posting input", () => {
    expect(validateJobPostings("not-an-array", "unit-test")).toEqual([]);
  });

  test("preserves provider freshness through runtime validation", () => {
    const providerUpdatedAt = "2026-07-12T11:00:00.000Z";
    const jobs = validateJobPostings(
      [
        {
          source: "target_site",
          sourceJobId: "job_provider_freshness",
          canonicalUrl: "https://example.com/jobs/provider-freshness",
          title: "Platform Engineer",
          company: "Acme",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "unknown",
          easyApplyEligible: false,
          providerUpdatedAt,
          discoveredAt: "2026-07-12T11:05:00.000Z",
          salaryText: null,
          description: "Build provider integrations.",
        },
      ],
      "provider-freshness-test",
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.providerUpdatedAt).toBe(providerUpdatedAt);
  });

  test("omits the LOCALAPPDATA chrome candidate when the env var is unavailable", () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;

    delete process.env.LOCALAPPDATA;

    try {
      withPlatform("win32", () => {
        const candidates = buildChromeExecutableCandidates();

        expect(candidates).not.toContain(
          "\\Google\\Chrome\\Application\\chrome.exe",
        );
      });
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  test("reads the active devtools port from the Chrome profile directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nestor-devtools-port-"));

    try {
      await writeFile(
        join(tempDir, "DevToolsActivePort"),
        "9444\n/devtools/browser/test\n",
      );

      await expect(readDevToolsActivePort(tempDir)).resolves.toBe(9444);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns null when the devtools active port file is missing or invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nestor-devtools-port-"));

    try {
      await expect(readDevToolsActivePort(tempDir)).resolves.toBeNull();

      await writeFile(join(tempDir, "DevToolsActivePort"), "not-a-port\n");

      await expect(readDevToolsActivePort(tempDir)).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("parses running Chrome debug sessions from command lines", () => {
    expect(
      parseRunningChromeDebugSession(
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9333 --user-data-dir="C:\\Users\\elian\\AppData\\Roaming\\@nestor\\desktop\\browser-agent\\default" --new-window about:blank',
      ),
    ).toEqual({
      debugPort: 9333,
      userDataDir:
        "C:\\Users\\elian\\AppData\\Roaming\\@nestor\\desktop\\browser-agent\\default",
    });

    expect(
      parseRunningChromeDebugSession(
        '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/Users/example/browser-agent/default --remote-debugging-port 9444',
      ),
    ).toEqual({
      debugPort: 9444,
      userDataDir: "/Users/example/browser-agent/default",
    });

    expect(
      parseRunningChromeDebugSession(
        '"chrome.exe" --user-data-dir="C:\\temp\\profile"',
      ),
    ).toBeNull();
    expect(
      parseRunningChromeDebugSession(
        '"chrome.exe" --remote-debugging-port=70000 --user-data-dir="C:\\temp\\profile"',
      ),
    ).toBeNull();
  });

  test("finds a running Chrome debug port for the same user data dir from command lines", () => {
    expect(
      findRunningChromeDebugPortInCommandLines(
        [
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9333 --user-data-dir="C:\\Users\\elian\\AppData\\Roaming\\@nestor\\desktop\\browser-agent\\default"',
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9555 --user-data-dir="C:\\Users\\elian\\AppData\\Local\\Temp\\other-profile"',
        ],
        "C:\\Users\\elian\\AppData\\Roaming\\@nestor\\desktop\\browser-agent\\default",
      ),
    ).toBe(9333);

    expect(
      findRunningChromeDebugPortInCommandLines(
        [
          '"chrome.exe" --remote-debugging-port=9555 --user-data-dir="C:\\Users\\elian\\AppData\\Local\\Temp\\other-profile"',
        ],
        "C:\\Users\\elian\\AppData\\Roaming\\@nestor\\desktop\\browser-agent\\default",
      ),
    ).toBeNull();
  });

  test("detects navigable http urls for warm page reuse checks", () => {
    expect(isHttpUrlLike("https://example.com/jobs")).toBe(true);
    expect(isHttpUrlLike("http://example.com/jobs")).toBe(true);
    expect(isHttpUrlLike("about:blank")).toBe(false);
    expect(isHttpUrlLike("chrome://newtab/")).toBe(false);
    expect(isHttpUrlLike(null)).toBe(false);
  });

  test("treats closed and non-http pages as stale when resolving a live page", () => {
    expect(
      isLikelyStalePage({
        isClosed: () => true,
        url: () => "https://example.com/jobs",
      } as StalePageLike),
    ).toBe(true);
    expect(
      isLikelyStalePage({
        isClosed: () => false,
        url: () => "about:blank",
      } as StalePageLike),
    ).toBe(true);
    expect(
      isLikelyStalePage({
        isClosed: () => false,
        url: () => "https://example.com/jobs",
      } as StalePageLike),
    ).toBe(false);
  });

  test("selects the most recent live http page when multiple pages exist", () => {
    const pages = [
      {
        id: "blank",
        isClosed: () => false,
        url: () => "about:blank",
      },
      {
        id: "closed",
        isClosed: () => true,
        url: () => "https://example.com/jobs/closed",
      },
      {
        id: "live",
        isClosed: () => false,
        url: () => "https://example.com/jobs/live",
      },
    ] as const;

    expect(selectLiveHttpPage(pages)).toBe(pages[2]);
  });

  test("does not warm-reuse 404 or detail-only pages for later discovery runs", () => {
    expect(
      isWarmPageReusable({
        pageUrl: "https://kosovajob.com/404",
        options: {
          startingUrls: ["https://kosovajob.com/"],
          navigationHostnames: ["kosovajob.com"],
          relevantUrlSubstrings: ["jobs", "search"],
        },
      }),
    ).toBe(false);

    expect(
      isWarmPageReusable({
        pageUrl:
          "https://kosovajob.com/shopaz/category-manager-fashion-sports-outdoor-e-commerce",
        options: {
          startingUrls: ["https://kosovajob.com/"],
          navigationHostnames: ["kosovajob.com"],
          relevantUrlSubstrings: ["jobs", "search"],
        },
      }),
    ).toBe(false);
  });

  test("warm-reuses normalized matching starting urls", () => {
    expect(
      isWarmPageReusable({
        pageUrl:
          "https://www.linkedin.com/jobs/search/?keywords=frontend&currentJobId=123#top",
        options: {
          startingUrls: [
            "https://www.linkedin.com/jobs/search/?keywords=frontend",
          ],
          navigationHostnames: ["www.linkedin.com"],
          relevantUrlSubstrings: ["jobs/search"],
        },
      }),
    ).toBe(true);
  });

  test("does not warm-reuse a stale same-host page when the run supplies a concrete query", () => {
    expect(
      isWarmPageReusable({
        pageUrl:
          "https://www.linkedin.com/jobs/search-results/?currentJobId=123&keywords=Senior+Full-Stack+Software+Engineer",
        options: {
          startingUrls: [
            "https://www.linkedin.com/jobs/search/?keywords=Senior+Full-Stack+Software+Engineer&location=Worldwide&geoId=92000000&f_WT=2",
          ],
          navigationHostnames: ["www.linkedin.com"],
          relevantUrlSubstrings: ["jobs", "search"],
        },
      }),
    ).toBe(false);
  });

  test("detects whether a local tcp port is actually reachable", async () => {
    const server = net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    const port = typeof address === "object" && address ? address.port : null;

    expect(port).not.toBeNull();
    await expect(isTcpPortReachable(port!)).resolves.toBe(true);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await expect(isTcpPortReachable(port!)).resolves.toBe(false);
  });

  test("forwards maxOutputTokens to the AI client during agent discovery", async () => {
    type ChatWithTools = NonNullable<JobFinderAiClient["chatWithTools"]>;

    const chatWithTools = vi.fn<ChatWithTools>(() =>
      Promise.resolve({
        content: "ok",
        toolCalls: [],
      }),
    );
    const bridge = createAgentChatWithToolsBridge(chatWithTools);
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools: [] = [];
    const options = { maxOutputTokens: 321 };

    await bridge.chatWithTools(messages, tools, options);

    expect(chatWithTools).toHaveBeenCalledWith(messages, tools, options);
  });

  test("keeps a rejecting tool-calling stub when the client cannot escalate", async () => {
    type ChatWithTools = NonNullable<JobFinderAiClient["chatWithTools"]>;
    const real = vi.fn<ChatWithTools>(() =>
      Promise.resolve({ content: "ok", toolCalls: [] }),
    );

    expect(resolveAgentDiscoveryChatWithTools(real)).toBe(real);

    const stub = resolveAgentDiscoveryChatWithTools(undefined);
    await expect(stub([], [])).rejects.toThrow(/does not support tool calling/);
  });
});

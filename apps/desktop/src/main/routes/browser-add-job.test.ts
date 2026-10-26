import { beforeEach, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
const mocks = vi.hoisted(() => ({
  readTab: vi.fn(),
  capture: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  score: vi.fn(),
  owns: vi.fn(),
  aiClient: { extractJobsFromPage: () => Promise.resolve([]) },
  store: { synthetic: true },
}));
vi.mock("../services/browser/embedded-browser", () => ({
  getEmbeddedBrowser: () => ({
    readTab: mocks.readTab,
    captureActivePage: mocks.capture,
    ownsRenderer: mocks.owns,
  }),
}));
vi.mock("../services/browser/browser-profile-import", () => ({
  importSignInsFromBrowser: vi.fn(),
  listBrowserImportSources: vi.fn(),
}));
vi.mock("../services/job-finder/runtime", () => ({
  startJobFinderRuntime: () => Promise.resolve({ aiClient: mocks.aiClient }),
}));
vi.mock("@nestor/job-finder", () => ({ readJobFromBrowserPage: mocks.read }));
vi.mock("@nestor/job-finder/job-commands", () => ({
  savePageJobs: mocks.save,
}));
vi.mock("../services/job-store", () => ({ getJobStore: () => mocks.store }));
vi.mock("../services/job-commands", () => ({
  scoreUnscoredJobs: mocks.score,
}));
import { registerBrowserRoutes } from "./browser";
const handlers = new Map<
  string,
  (event: IpcMainInvokeEvent, input: unknown) => unknown
>();
beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.owns.mockReturnValue(true);
  registerBrowserRoutes({
    handle: (
      name: string,
      handler: (event: IpcMainInvokeEvent, input: unknown) => unknown,
    ) => handlers.set(name, handler),
  } as unknown as IpcMain);
});
it("validates exact-tab IPC, reads that page in main and saves its job to Find jobs", async () => {
  const mainFrame = {};
  const event = {
    sender: { id: 1, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  mocks.readTab.mockResolvedValue({
    url: "https://example.test/job",
    value: "<main>Designer</main>",
  });
  const posting = { title: "Designer", company: "Example Studio" };
  mocks.read.mockResolvedValue(posting);
  mocks.save.mockReturnValue({ ids: [7] });
  const add = handlers.get("browser:add-job")!;
  expect(await add(event, { tabId: "chosen" })).toEqual({
    jobId: "7",
    title: "Designer",
    company: "Example Studio",
    planName: null,
  });
  expect(mocks.readTab).toHaveBeenCalledWith(
    "chosen",
    "document.documentElement.outerHTML",
  );
  expect(mocks.read).toHaveBeenCalledWith(mocks.aiClient, {
    html: "<main>Designer</main>",
    pageUrl: "https://example.test/job",
  });
  expect(mocks.save).toHaveBeenCalledWith(mocks.store, {
    postings: [posting],
    pageUrl: "https://example.test/job",
  });
  // Its fit is judged in the background, after the job is saved.
  expect(mocks.score).toHaveBeenCalledOnce();
  await expect(
    add(event, { tabId: "chosen", html: "spoof" }),
  ).rejects.toThrow();
  mocks.owns.mockReturnValue(false);
  await expect(add(event, { tabId: "chosen" })).rejects.toThrow("app window");
});

it("checks a captured page in main before it reaches the renderer", async () => {
  const mainFrame = {};
  const event = {
    sender: { id: 1, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  mocks.capture.mockResolvedValue({ url: 42 });
  await expect(
    Promise.resolve(handlers.get("browser:capture-page")!(event, undefined)),
  ).rejects.toThrow();
});

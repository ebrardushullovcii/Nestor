import { beforeEach, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
const mocks = vi.hoisted(() => ({
  readTab: vi.fn(),
  capture: vi.fn(),
  add: vi.fn(),
  publish: vi.fn(),
  owns: vi.fn(),
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
vi.mock("../services/job-finder/workspace-service", () => ({
  getJobFinderWorkspaceService: () =>
    Promise.resolve({ addJobFromBrowserPage: mocks.add }),
}));
vi.mock("../services/job-finder/workspace-updates", () => ({
  publishJobFinderWorkspaceUpdate: mocks.publish,
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
it("validates exact-tab IPC, reads that page in main and publishes its saved result", async () => {
  const mainFrame = {};
  const event = {
    sender: { id: 1, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  mocks.readTab.mockResolvedValue({
    url: "https://example.test/job",
    value: "<main>Designer</main>",
  });
  mocks.add.mockResolvedValue({
    jobId: "one",
    title: "Designer",
    company: "Example Studio",
    planName: "Design",
  });
  const add = handlers.get("browser:add-job")!;
  expect(await add(event, { tabId: "chosen" })).toEqual({
    jobId: "one",
    title: "Designer",
    company: "Example Studio",
    planName: "Design",
  });
  expect(mocks.readTab).toHaveBeenCalledWith(
    "chosen",
    "document.documentElement.outerHTML",
  );
  expect(mocks.add).toHaveBeenCalledWith({
    html: "<main>Designer</main>",
    pageUrl: "https://example.test/job",
  });
  expect(mocks.publish).toHaveBeenCalledOnce();
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

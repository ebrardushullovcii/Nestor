import { beforeEach, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

const mocks = vi.hoisted(() => ({
  owns: vi.fn(),
  watch: vi.fn(),
  get: vi.fn(),
}));
vi.mock("../services/browser/embedded-browser", () => ({
  getEmbeddedBrowser: () => ({
    ownsRenderer: mocks.owns,
    watchSiteIcons: mocks.watch,
  }),
}));
vi.mock("../services/browser/site-icon-cache", () => ({
  getSiteIconCache: () => Promise.resolve({ get: mocks.get }),
}));
vi.mock("../services/browser/browser-profile-import", () => ({}));
vi.mock("../services/job-finder/runtime", () => ({}));
vi.mock("../services/job-store", () => ({ getJobStore: () => ({}) }));
vi.mock("../services/job-commands", () => ({ scoreUnscoredJobs: vi.fn() }));

import { registerBrowserRoutes } from "./browser";

const handlers = new Map<
  string,
  (event: IpcMainInvokeEvent, input: unknown) => unknown
>();
const mainFrame = {};
const event = {
  sender: { id: 1, mainFrame },
  senderFrame: mainFrame,
} as unknown as IpcMainInvokeEvent;
const call = (input: unknown, from = event) =>
  Promise.resolve(handlers.get("browser:site-icons")!(from, input));

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

it("returns cached icons through the typed contract and watches for new ones", async () => {
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  mocks.get.mockResolvedValue({ "https://jobs.example.com": icon });
  expect(await call({ urls: ["https://jobs.example.com/careers"] })).toEqual({
    icons: { "https://jobs.example.com": icon },
  });
  expect(mocks.get).toHaveBeenCalledWith(["https://jobs.example.com/careers"]);
  expect(mocks.watch).toHaveBeenCalledOnce();
});

it("refuses bad input, other windows and anything that is not a raster image", async () => {
  await expect(call({ urls: "https://x.test" })).rejects.toThrow();
  await expect(call({ urls: [], extra: true })).rejects.toThrow();
  mocks.get.mockResolvedValue({
    "https://x.test": "data:image/svg+xml;base64,PHN2Zz4=",
  });
  await expect(call({ urls: ["https://x.test"] })).rejects.toThrow();
  mocks.get.mockResolvedValue({
    "https://x.test": "https://x.test/favicon.ico",
  });
  await expect(call({ urls: ["https://x.test"] })).rejects.toThrow();
  mocks.owns.mockReturnValue(false);
  await expect(call({ urls: [] })).rejects.toThrow("app window");
  // A subframe of the app window is not the app.
  const subframe = {
    sender: { id: 1, mainFrame },
    senderFrame: {},
  } as unknown as IpcMainInvokeEvent;
  mocks.owns.mockReturnValue(true);
  await expect(call({ urls: [] }, subframe)).rejects.toThrow("app window");
});

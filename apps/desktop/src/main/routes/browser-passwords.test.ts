import { beforeEach, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { EmbeddedBrowser } from "../services/browser/embedded-browser";
const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  importCsv: vi.fn(),
  browser: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.pick },
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, stat: mocks.stat }));
vi.mock("../services/browser/password-csv", () => ({
  importPasswordCsv: mocks.importCsv,
  importPasswordValues: vi.fn(),
}));
import { registerBrowserPasswordRoutes } from "./browser-passwords";
beforeEach(() => vi.clearAllMocks());
function setup() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>
  >();
  const vault = { available: () => true, delete: vi.fn() };
  const passwords = {
    list: vi.fn(() => ({ available: true, message: null, credentials: [] })),
    save: vi.fn(),
    dismiss: vi.fn(),
    autofill: vi.fn(() => Promise.resolve(true)),
    vault: () => vault,
  };
  const owner = vi.fn((event: IpcMainInvokeEvent) => {
    if (event.sender.id !== 7 || event.senderFrame !== event.sender.mainFrame)
      return Promise.reject(new Error("app window only"));
    return Promise.resolve({
      passwords: () => passwords,
    } as unknown as EmbeddedBrowser);
  });
  registerBrowserPasswordRoutes(
    {
      handle: (
        name: string,
        handler: (
          event: IpcMainInvokeEvent,
          input?: unknown,
        ) => Promise<unknown>,
      ) => {
        handlers.set(name, handler);
      },
    } as unknown as IpcMain,
    owner,
  );
  const frame = {};
  const event = {
    sender: { id: 7, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return { handlers, passwords, vault, event };
}
it("authenticates every password IPC and accepts only opaque IDs for save/fill/delete", async () => {
  const { handlers, passwords, event } = setup();
  for (const handler of handlers.values()) {
    await expect(
      handler({ sender: { id: 9 } } as unknown as IpcMainInvokeEvent, {}),
    ).rejects.toThrow("app window");
    await expect(
      handler(
        { ...event, senderFrame: {} } as unknown as IpcMainInvokeEvent,
        {},
      ),
    ).rejects.toThrow("app window");
  }
  await handlers.get("browser-passwords:save")!(event, { promptId: "opaque" });
  expect(passwords.save).toHaveBeenCalledExactlyOnceWith("opaque");
  await expect(
    handlers.get("browser-passwords:save")!(event, {
      promptId: "opaque",
      password: "synthetic-spoof",
    }),
  ).rejects.toThrow();
  await handlers.get("browser-passwords:autofill")!(event, {
    tabId: "tab",
    credentialId: "id",
  });
  expect(passwords.autofill).toHaveBeenCalledExactlyOnceWith("tab", "id");
  expect(await handlers.get("browser-passwords:list")!(event, {})).toEqual({
    available: true,
    message: null,
    credentials: [],
  });
});
it("imports only a native-picked file in main, returns counts, and never deletes the file", async () => {
  const { handlers, event } = setup();
  mocks.pick.mockResolvedValue({
    canceled: false,
    filePaths: ["synthetic-export.csv"],
  });
  mocks.stat.mockResolvedValue({ size: 80 });
  mocks.read.mockResolvedValue("synthetic-csv");
  const counts = {
    status: "imported",
    added: 2,
    updated: 1,
    skipped: 0,
    message: "Imported.",
  };
  mocks.importCsv.mockReturnValue(counts);
  expect(await handlers.get("browser-passwords:import-csv")!(event)).toEqual(
    counts,
  );
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
    "synthetic-export.csv",
    "utf8",
  );
  mocks.read.mockRejectedValue(new Error("secret-bearing-native-error"));
  const failed = await handlers.get("browser-passwords:import-csv")!(event);
  expect(JSON.stringify(failed).includes("secret-bearing-native-error")).toBe(
    false,
  );
  mocks.pick.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(
    await handlers.get("browser-passwords:import-csv")!(event),
  ).toMatchObject({ status: "cancelled", added: 0 });
});

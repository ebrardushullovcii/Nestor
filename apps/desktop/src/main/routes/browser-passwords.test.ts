import { beforeEach, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { EmbeddedBrowser } from "../services/browser/embedded-browser";
import type { PasswordValue } from "../services/browser/password-vault";
const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  importCsv: vi.fn(),
  importValues: vi.fn(),
  browser: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: mocks.pick },
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, stat: mocks.stat }));
vi.mock("../services/browser/password-csv", () => ({
  importPasswordCsv: mocks.importCsv,
  importPasswordValues: mocks.importValues,
}));
vi.mock("../services/browser/browser-profile-import", () => ({
  readBrowserPasswords: mocks.browser,
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

it("keeps browser passwords in main, returns only counts and releases plaintext after saving", async () => {
  const { handlers, event, vault } = setup();
  const values = [
    {
      origin: "https://example.test",
      username: "synthetic",
      password: "synthetic-only",
    },
  ];
  const value = values[0]!;
  mocks.browser.mockResolvedValue({ values, skipped: 2, unsupported: false });
  mocks.importValues.mockImplementation(
    (target: unknown, received: PasswordValue[], skipped: number) => {
      expect(target).toBe(vault);
      expect(received[0]?.password === "synthetic-only").toBe(true);
      expect(skipped).toBe(2);
      return {
        status: "imported",
        added: 1,
        updated: 0,
        skipped: 2,
        message: "Added 1, updated 0, skipped 2 logins.",
      };
    },
  );
  const result = await handlers.get("browser-passwords:import-browser")!(
    event,
    { sourceId: "opaque" },
  );
  expect(result).toMatchObject({ status: "imported", added: 1, skipped: 2 });
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-only|username|password/,
  );
  expect(value.password).toBe("");
  expect(values).toHaveLength(0);
});

it("reports protected and undecryptable counts and sanitizes native errors", async () => {
  const { handlers, event } = setup();
  const run = () =>
    handlers.get("browser-passwords:import-browser")!(event, {
      sourceId: "opaque",
    });
  mocks.browser.mockResolvedValueOnce({
    values: [],
    skipped: 3,
    unsupported: true,
  });
  expect(await run()).toMatchObject({
    status: "unsupported",
    added: 0,
    skipped: 3,
  });
  mocks.browser.mockResolvedValueOnce({
    values: [],
    skipped: 2,
    unsupported: false,
  });
  expect(await run()).toMatchObject({
    status: "unsupported",
    added: 0,
    skipped: 2,
  });
  expect(mocks.importValues).not.toHaveBeenCalled();
  mocks.browser.mockRejectedValueOnce(
    new Error("synthetic-secret-native-error"),
  );
  const failure = await run();
  expect(failure).toMatchObject({ status: "failed" });
  expect(JSON.stringify(failure)).not.toContain(
    "synthetic-secret-native-error",
  );
});

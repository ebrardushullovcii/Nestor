import { afterEach, expect, it, vi } from "vitest";
import type {
  IpcMain,
  IpcMainEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import type {
  BrowserPasswordRepository,
  EncryptedBrowserPassword,
} from "@nestor/db";
import { PasswordVault } from "./password-vault";
import { BrowserPasswords } from "./browser-passwords";
vi.mock("electron", () => ({ app: {}, safeStorage: {} }));
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const rows = new Map<string, EncryptedBrowserPassword>();
  const repository: BrowserPasswordRepository = {
    list: () =>
      [...rows.values()].map((row) => ({
        id: row.id,
        origin: row.origin,
        username: row.username,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    get: (id) => rows.get(id) ?? null,
    put: (row) => {
      rows.set(row.id, row);
    },
    delete: (id) => {
      rows.delete(id);
    },
    close: () => undefined,
  };
  // Test transport only, never used by production or written to disk.
  const vault = new PasswordVault(repository, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  let url = "https://example.test/login",
    allowed = true,
    profileEmail: string | null = null;
  const listeners = new Map<
    string,
    (event: IpcMainEvent, value: unknown) => void
  >();
  const frame = {
    url,
    executeJavaScript: vi.fn(() =>
      Promise.resolve([
        { action: "https://example.test/session", login: true },
      ]),
    ),
    send: vi.fn((_channel: string, value: { requestId: string }) => {
      listeners.get("browser-password:filled")?.(
        { senderFrame: frame } as unknown as IpcMainEvent,
        { requestId: value.requestId, ok: true },
      );
    }),
  };
  const contents = {
    getURL: () => url,
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame] },
  };
  const pages = [{ id: "tab", contents: contents as unknown as WebContents }];
  const host = { pages: () => pages, changed: vi.fn(), chooseAccount: vi.fn() };
  const manager = new BrowserPasswords(
    host,
    () => vault,
    () => allowed,
    () => profileEmail,
  );
  manager.attach({
    on: (
      name: string,
      handler: (event: IpcMainEvent, value: unknown) => void,
    ) => {
      listeners.set(name, handler);
    },
  } as unknown as IpcMain);
  const event = {
    sender: contents,
    senderFrame: frame,
  } as unknown as IpcMainEvent;
  const capture = {
    origin: "https://example.test",
    action: "https://example.test/session",
    username: "synthetic-user",
    password: "synthetic-credential",
  };
  return {
    manager,
    vault,
    frame,
    event,
    contents,
    capture,
    pages,
    listeners,
    navigate: (next: string) => {
      url = next;
      frame.url = next;
    },
    host,
    permit: (value: boolean) => {
      allowed = value;
    },
    profileEmail: (value: string | null) => {
      profileEmail = value;
    },
  };
}
it("captures privately, offers metadata only, requires Save, updates and autofills without evaluated secrets", async () => {
  const { manager, vault, capture, event, frame } = setup();
  await manager.capture(event, capture);
  const offer = manager.prompt("tab")!;
  expect(!!offer).toBe(true);
  expect(JSON.stringify(offer).includes(capture.password)).toBe(false);
  expect(vault.list().length).toBe(0);
  manager.save(offer.id);
  expect(manager.prompt("tab")).toBeNull();
  const id = vault.list()[0]!.id;
  expect(await manager.autofill("tab", id)).toBe(true);
  expect(
    frame.executeJavaScript.mock.calls.every(
      (args) => !JSON.stringify(args).includes(capture.password),
    ),
  ).toBe(true);
  expect(frame.send.mock.calls[0]?.[0]).toBe("browser-password:fill");
  await manager.capture(event, { ...capture, password: "synthetic-update" });
  expect(manager.prompt("tab")?.update).toBe(true);
  manager.save(manager.prompt("tab")!.id);
  expect(vault.list().length).toBe(1);
  expect(vault.read(id)?.password === "synthetic-update").toBe(true);
});
it("dismisses repeat offers, expires transient captures, and clears on close or foreign navigation", async () => {
  const { manager, capture, event } = setup();
  await manager.capture(event, capture);
  manager.dismiss(manager.prompt("tab")!.id);
  await manager.capture(event, capture);
  expect(manager.prompt("tab")).toBeNull();
  await manager.capture(event, { ...capture, password: "changed-synthetic" });
  const id = manager.prompt("tab")!.id;
  vi.advanceTimersByTime(125000);
  expect(manager.prompt("tab")).toBeNull();
  expect(() => manager.save(id)).toThrow("expired");
  await manager.capture(event, capture);
  manager.navigation("tab", "https://foreign.test");
  expect(manager.prompt("tab")).toBeNull();
  await manager.capture(event, capture);
  manager.forget("tab");
  expect(manager.prompt("tab")).toBeNull();
});
it("rejects unowned IPC, foreign frames, insecure origins and cross-origin form actions", async () => {
  const { manager, event, capture, frame, navigate, contents } = setup();
  await manager.capture({ ...event, sender: {} as WebContents }, capture);
  await manager.capture({ ...event, senderFrame: {} as WebFrameMain }, capture);
  await manager.capture(event, { ...capture, action: "https://other.test" });
  frame.url = "https://other.test";
  await manager.capture(event, capture);
  navigate("http://example.test");
  await manager.capture(event, {
    ...capture,
    origin: "http://example.test",
    action: "http://example.test",
  });
  expect(manager.prompt("tab")).toBeNull();
  expect(manager.list().credentials.length).toBe(0);
  expect(manager.list("missing").credentials.length).toBe(0);
  expect(contents.mainFrame.framesInSubtree.length).toBe(1);
});
it("never fills another origin, port, scheme or form action, even if renderer requests a real record", async () => {
  const { manager, vault, capture, frame, navigate } = setup();
  vault.save(capture);
  const id = vault.list()[0]!.id;
  for (const url of [
    "https://other.test",
    "https://example.test.evil.test",
    "http://example.test",
    "https://example.test:444",
  ]) {
    navigate(url);
    expect(await manager.autofill("tab", id)).toBe(false);
  }
  navigate("https://example.test/login");
  frame.executeJavaScript.mockResolvedValue([
    { action: "https://foreign.test", login: true },
  ]);
  expect(await manager.autofill("tab", id)).toBe(false);
  expect(frame.send.mock.calls.length).toBe(0);
});
it("rechecks live tab origin and sign-in permission after awaiting form inspection", async () => {
  const { manager, vault, capture, frame, navigate, permit } = setup();
  vault.save(capture);
  frame.executeJavaScript.mockImplementation(() => {
    navigate("https://other.test");
    return Promise.resolve([{ action: "https://example.test", login: true }]);
  });
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  navigate("https://example.test/login");
  frame.executeJavaScript.mockImplementation(() => {
    permit(false);
    return Promise.resolve([{ action: "https://example.test", login: true }]);
  });
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  expect(frame.send.mock.calls.length).toBe(0);
});
it("agent use requires opt-in, one account and an existing-account login form", async () => {
  const { manager, vault, capture, frame, permit, host } = setup();
  vault.save(capture);
  permit(false);
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  permit(true);
  frame.executeJavaScript.mockResolvedValue([
    { action: capture.action, login: false },
  ]);
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  frame.executeJavaScript.mockResolvedValue([
    { action: capture.action, login: true },
  ]);
  expect(await manager.prepareAgentCredentials("tab")).toBe(true);
  vault.save({ ...capture, username: "second-account" });
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  expect(manager.list("tab").credentials.length).toBe(2);
  expect(host.chooseAccount).toHaveBeenCalledExactlyOnceWith("tab");
});
it("supplies the known profile email only for one username-less saved sign-in without changing the vault", async () => {
  const { manager, vault, capture, frame, profileEmail } = setup();
  vault.save({ ...capture, username: "" });
  profileEmail("synthetic-applicant@example.test");
  expect(await manager.prepareAgentCredentials("tab")).toBe(true);
  expect(frame.send).toHaveBeenLastCalledWith(
    "browser-password:fill",
    expect.objectContaining({
      username: "",
      fallbackUsername: "synthetic-applicant@example.test",
      agent: true,
    }),
  );
  expect(vault.list()[0]?.username).toBe("");
  expect(
    frame.executeJavaScript.mock.calls.every(
      (args) => !JSON.stringify(args).includes(capture.password),
    ),
  ).toBe(true);
  frame.send.mockClear();
  await manager.autofill("tab", vault.list()[0]!.id);
  expect(frame.send.mock.calls[0]?.[1]).not.toHaveProperty("fallbackUsername");
});
it("never combines profile email with a named login, multiple accounts, registration or another origin", async () => {
  const { manager, vault, capture, frame, profileEmail, navigate, permit } =
    setup();
  profileEmail("synthetic-applicant@example.test");
  vault.save(capture);
  expect(await manager.prepareAgentCredentials("tab")).toBe(true);
  expect(frame.send.mock.calls[0]?.[1]).not.toHaveProperty("fallbackUsername");
  vault.clear();
  vault.save({ ...capture, username: "" });
  frame.send.mockClear();
  permit(false);
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  permit(true);
  frame.executeJavaScript.mockResolvedValue([
    { action: capture.action, login: false },
  ]);
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  frame.executeJavaScript.mockResolvedValue([
    { action: capture.action, login: true },
  ]);
  navigate("https://other.test/login");
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  navigate("https://example.test/login");
  vault.save(capture);
  expect(await manager.prepareAgentCredentials("tab")).toBe(false);
  expect(await manager.autofill("tab", vault.list()[0]!.id, true)).toBe(false);
  expect(frame.send).not.toHaveBeenCalled();
});

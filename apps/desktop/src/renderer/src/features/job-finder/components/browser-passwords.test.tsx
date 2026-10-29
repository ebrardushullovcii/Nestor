// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  BrowserPasswordMetadata,
  DesktopBrowserBridge,
} from "@nestor/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserPasswordOffer,
  BrowserPasswordPanel,
} from "./browser-passwords";
afterEach(cleanup);
function setup() {
  let rows: BrowserPasswordMetadata[] = ["alice", "bob"].map((username) => ({
    id: username,
    username,
    origin: "https://example.test",
    createdAt: "today",
    updatedAt: "today",
  }));
  const passwords = {
    list: vi.fn(() =>
      Promise.resolve({ available: true, message: null, credentials: rows }),
    ),
    save: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(() => Promise.resolve()),
    autofill: vi.fn(() => Promise.resolve()),
    delete: vi.fn(({ credentialId }: { credentialId: string }) => {
      rows = rows.filter((row) => row.id !== credentialId);
      return Promise.resolve();
    }),
    importCsv: vi.fn(() =>
      Promise.resolve({
        status: "imported" as const,
        added: 1,
        updated: 0,
        skipped: 0,
        message: "Added 1 login.",
      }),
    ),
    importFromBrowser: vi.fn(),
  };
  const listSources = vi.fn<DesktopBrowserBridge["listImportSources"]>(() =>
    Promise.resolve({ sources: [], note: null }),
  );
  const bridge = {
    passwords,
    listImportSources: listSources,
  } as unknown as DesktopBrowserBridge;
  return { passwords, bridge, listSources };
}
it("offers Save/Update using only an opaque prompt, and can dismiss", async () => {
  const { bridge, passwords } = setup();
  const prompt = {
    id: "opaque",
    tabId: "tab",
    origin: "https://example.test",
    username: "alice",
    update: false,
  };
  const message = vi.fn();
  const view = render(
    <BrowserPasswordOffer prompt={prompt} bridge={bridge} message={message} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(passwords.save).toHaveBeenCalledExactlyOnceWith({
      promptId: "opaque",
    }),
  );
  expect(document.querySelectorAll("input").length).toBe(0);
  view.rerender(
    <BrowserPasswordOffer
      prompt={{ ...prompt, update: true }}
      bridge={bridge}
      message={message}
    />,
  );
  expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss password offer" }),
  );
  expect(passwords.dismiss).toHaveBeenCalledExactlyOnceWith({
    promptId: "opaque",
  });
});
it("lets the person choose among multiple accounts and sends just the chosen record/tab IDs", async () => {
  const { bridge, passwords } = setup();
  const close = vi.fn();
  render(<BrowserPasswordPanel bridge={bridge} tabId="tab" close={close} />);
  expect(await screen.findByText("alice")).toBeTruthy();
  expect(screen.getByText("bob")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Fill" })[1]!);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(passwords.autofill).toHaveBeenCalledExactlyOnceWith({
    tabId: "tab",
    credentialId: "bob",
  });
});
it("lists metadata, deletes one login and imports via native picker with counts only", async () => {
  const { bridge, passwords } = setup();
  render(<BrowserPasswordPanel bridge={bridge} tabId="tab" close={vi.fn()} />);
  await screen.findByText("alice");
  fireEvent.click(
    screen.getByRole("button", { name: "Manage all saved logins" }),
  );
  await waitFor(() => expect(passwords.list).toHaveBeenLastCalledWith({}));
  expect(screen.queryByRole("button", { name: "Fill" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete login for alice" }),
  );
  await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Import password CSV…" }));
  expect(await screen.findByText("Added 1 login.")).toBeTruthy();
  expect(passwords.importCsv).toHaveBeenCalledExactlyOnceWith();
});

it("disables locked password profiles with a reason while leaving v10 profiles and CSV clickable", async () => {
  const { bridge, passwords, listSources } = setup();
  listSources.mockResolvedValue({
    sources: [
      {
        id: "locked",
        browser: "chrome",
        browserLabel: "Google Chrome",
        profileLabel: "Default",
        supported: false,
        note: "Sign-ins locked",
        passwordImport: {
          supported: false,
          note: "This browser keeps its passwords locked to itself. Export a CSV instead.",
        },
      },
      {
        id: "readable",
        browser: "edge",
        browserLabel: "Microsoft Edge",
        profileLabel: "Profile 1",
        supported: false,
        note: "Sign-ins locked",
        passwordImport: { supported: true, note: null },
      },
    ],
    note: null,
  });
  passwords.importFromBrowser.mockResolvedValue({
    status: "imported",
    added: 1,
    updated: 0,
    skipped: 2,
    message: "Added 1, updated 0, skipped 2 logins.",
  });
  render(<BrowserPasswordPanel bridge={bridge} tabId="tab" close={vi.fn()} />);
  await screen.findByText("Import directly from a browser");
  fireEvent.click(screen.getByText("Import directly from a browser"));
  const locked = screen.getByRole<HTMLButtonElement>("button", {
    name: /Google Chrome/,
  });
  const readable = screen.getByRole<HTMLButtonElement>("button", {
    name: /Microsoft Edge/,
  });
  expect(locked.disabled).toBe(true);
  expect(locked.textContent).toContain(
    "locked to itself. Export a CSV instead.",
  );
  fireEvent.click(locked);
  expect(passwords.importFromBrowser).not.toHaveBeenCalled();
  expect(readable.disabled).toBe(false);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Import password CSV…",
    }).disabled,
  ).toBe(false);
  fireEvent.click(readable);
  await screen.findByText("Added 1, updated 0, skipped 2 logins.");
  expect(passwords.importFromBrowser).toHaveBeenCalledExactlyOnceWith({
    sourceId: "readable",
  });
});

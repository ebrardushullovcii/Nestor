import type { ApplyRawPageHands } from "@nestor/contracts";
import type { Page } from "playwright";
import { expect, test, vi } from "vitest";
import { withTaskPageTabs } from "./task-page-tabs";

test.each([
  [
    "https://accounts.google.com/v3/signin/accountchooser?continue=fixture",
    "google_accounts_redirect",
  ],
  ["https://example.test/unavailable", "unknown"],
])("reports the Gmail probe landing at %s", async (url, status) => {
  const context = {
    pages: () => [],
    cookies: () => Promise.resolve([{ name: "fixture" }]),
    newPage: () => Promise.resolve(probe),
  };
  const probe = {
    context: () => context,
    goto: vi.fn().mockResolvedValue(undefined),
    url: () => url,
    close: vi.fn().mockResolvedValue(undefined),
  };
  const primary = { context: () => context } as unknown as Page;
  const hands = withTaskPageTabs(primary, () => ({}) as ApplyRawPageHands);

  expect(await hands.readMailboxSession?.()).toEqual({ status });
  expect(probe.goto).toHaveBeenCalledWith(
    "https://mail.google.com/mail/u/0/",
    expect.any(Object),
  );
  expect(probe.close).toHaveBeenCalledOnce();
});

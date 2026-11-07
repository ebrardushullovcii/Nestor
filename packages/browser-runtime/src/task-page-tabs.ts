import type {
  ApplyRawPageHands,
  ApplyNavigationResult,
} from "@nestor/contracts";
import { markVerificationPrivate } from "@nestor/core/run-trace";
import type { Page } from "playwright";
import { withNavigationLiveness } from "./browser-navigation";
import { markPrivateTracePage } from "./trace-page";

const sessions = new WeakMap<Page, ApplyRawPageHands>();
const owners = new WeakMap<Page, (page: Page) => void | Promise<void>>();
export function configureTaskPageOwner(
  page: Page,
  owner: ((page: Page) => void | Promise<void>) | undefined,
): void {
  if (owner) owners.set(page, owner);
}
export function inheritTaskPageOwner(primary: Page, child: Page): void {
  configureTaskPageOwner(child, owners.get(primary));
}

/** One task's pages, independent of the browser's selected tab and other jobs. */
export function withTaskPageTabs(
  primary: Page,
  create: (page: Page) => ApplyRawPageHands,
): ApplyRawPageHands {
  const previous = sessions.get(primary);
  if (previous) return previous;
  const pages = new Map<string, Page>([["form", primary]]);
  const hands = new WeakMap<Page, ApplyRawPageHands>();
  let active = primary;
  let nextId = 0;
  const current = () => {
    if (active.isClosed?.()) active = primary;
    let result = hands.get(active);
    if (!result) {
      result = create(active);
      hands.set(active, result);
    }
    return result;
  };
  const privateRead = () => {
    markVerificationPrivate();
    markPrivateTracePage(primary);
    markPrivateTracePage(active);
  };
  const closeAuxiliaryTabs = async () => {
    active = primary;
    await Promise.all(
      [...pages]
        .filter(([id]) => id !== "form")
        .map(async ([id, page]) => {
          await page.close().catch(() => undefined);
          pages.delete(id);
        }),
    );
  };
  const base = create(primary);
  hands.set(primary, base);
  const operations: Pick<
    ApplyRawPageHands,
    | "openTab"
    | "switchTab"
    | "closeTab"
    | "closeAuxiliaryTabs"
    | "readMailboxAccounts"
    | "readPage"
  > = {
    readPage: async () => ({
      ...(await current().readPage()),
      tabs: await Promise.all(
        [...pages]
          .filter(([, page]) => !page.isClosed())
          .map(async ([id, page]) => ({
            id,
            url: page.url(),
            title: await page.title().catch(() => ""),
            active: page === active,
            primary: page === primary,
          })),
      ),
    }),
    openTab: async (url): Promise<ApplyNavigationResult> => {
      privateRead();
      const page = await primary.context().newPage();
      pages.set(`tab${++nextId}`, page);
      markPrivateTracePage(page);
      active = page;
      try {
        await owners.get(primary)?.(page);
        await withNavigationLiveness(page, () =>
          page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 }),
        );
        return { ok: true, url: page.url() };
      } catch {
        return {
          ok: false,
          error:
            "The new tab could not load. The application form remains open; observe the tabs and try another route.",
        };
      }
    },
    switchTab: async (id) => {
      const page = pages.get(id);
      if (!page || page.isClosed())
        return { ok: false, error: "That task tab is no longer open." };
      active = page;
      if (active !== primary) privateRead();
      await owners.get(primary)?.(page);
      await page.bringToFront();
      return { ok: true, url: page.url() };
    },
    closeTab: async (id) => {
      const page = pages.get(id);
      if (!page || page.isClosed())
        return { ok: false, error: "That task tab is no longer open." };
      if (page === primary)
        return {
          ok: false,
          error:
            "The application stays bound to its form tab. Close an auxiliary tab or finish the task.",
        };
      await page.close();
      pages.delete(id);
      if (active === page) active = primary;
      return { ok: true, url: active.url() };
    },
    closeAuxiliaryTabs,
    readMailboxAccounts: async () => {
      // The account label is non-secret. Never read or retain inbox messages
      // during this factual probe, and never infer sign-in from a cookie.
      const existing = primary
        .context()
        .pages()
        .find((page) => /^https:\/\/mail\.google\.com\//u.test(page.url()));
      let probe = existing;
      try {
        if (
          !probe &&
          !(
            await primary
              .context()
              .cookies([
                "https://mail.google.com",
                "https://accounts.google.com",
              ])
          ).length
        )
          return [];
        if (!probe) {
          probe = await primary.context().newPage();
          markPrivateTracePage(probe);
          await owners.get(primary)?.(probe);
          await withNavigationLiveness(probe, () =>
            probe!.goto("https://mail.google.com/mail/u/0/", {
              waitUntil: "domcontentloaded",
              timeout: 0,
            }),
          );
        }
        if (new URL(probe.url()).hostname !== "mail.google.com") return [];
        await withNavigationLiveness(probe, () =>
          probe!
            .locator(
              '[aria-label*="Google Account"], a[href*="SignOutOptions"], [data-authuser][data-email]',
            )
            .first()
            .waitFor({ state: "attached", timeout: 0 }),
        );
        const email = await probe.evaluate(() => {
          const account = document.querySelector(
            '[aria-label*="Google Account"], a[href*="SignOutOptions"], [data-authuser][data-email]',
          );
          const label =
            account?.getAttribute("data-email") ??
            account?.getAttribute("aria-label") ??
            "";
          return (
            label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] ?? null
          );
        });
        return email
          ? [{ email, url: "https://mail.google.com/mail/u/0/" }]
          : [];
      } catch {
        return [];
      } finally {
        if (probe && probe !== existing)
          await probe.close().catch(() => undefined);
      }
    },
  };
  const wrapped = new Proxy(
    { ...base, ...operations },
    {
      get(target, key, receiver) {
        if (key in operations) {
          const operation: unknown = Reflect.get(target, key, receiver);
          return operation;
        }
        const value: unknown = Reflect.get(base, key);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              const targetHands = current();
              const method: unknown = Reflect.get(targetHands, key);
              if (typeof method !== "function")
                throw new Error("That browser mechanic is unavailable.");
              const result: unknown = Reflect.apply(method, targetHands, args);
              return result;
            }
          : value;
      },
    },
  );
  primary.once?.("close", () => {
    void closeAuxiliaryTabs();
  });
  sessions.set(primary, wrapped);
  return wrapped;
}

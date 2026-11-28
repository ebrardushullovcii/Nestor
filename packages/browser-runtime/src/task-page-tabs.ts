import type {
  ApplyRawPageHands,
  ApplyNavigationResult,
} from "@nestor/contracts";
import { markVerificationPrivate } from "@nestor/core/run-trace";
import type { Page } from "playwright";
import { withNavigationLiveness } from "./browser-navigation";
import { markMailboxTracePage, markPrivateTracePage } from "./trace-page";

const sessions = new WeakMap<Page, ApplyRawPageHands>();
const activePages = new WeakMap<Page, () => Page>();
const sendPages = new WeakMap<Page, Page>();

const providerSessionProbes = [
  {
    provider: "LinkedIn",
    url: "https://www.linkedin.com/feed/",
    accountControl: '.global-nav__me, [data-test-global-nav-link="me"]',
  },
];

/** The task tab the model works in now; the form tab itself otherwise. */
export function activeTaskPage(primary: Page): Page {
  const page = activePages.get(primary)?.();
  return page && !page.isClosed() ? page : primary;
}
/** An auxiliary tab that carried an application send stays for final evidence. */
export function rememberTaskSendPage(primary: Page, page: Page): void {
  if (page !== primary) sendPages.set(primary, page);
}
export function taskSendPage(primary: Page): Page | null {
  const page = sendPages.get(primary);
  return page && !page.isClosed() ? page : null;
}
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
  activePages.set(primary, () => active);
  const privateRead = (page: Page) => {
    markVerificationPrivate();
    markMailboxTracePage(page);
  };
  const closeTabs = async (keepSendTab: boolean) => {
    active = primary;
    const sendPage = keepSendTab ? taskSendPage(primary) : null;
    await Promise.all(
      [...pages]
        .filter(([id, page]) => id !== "form" && page !== sendPage)
        .map(async ([id, page]) => {
          await page.close().catch(() => undefined);
          pages.delete(id);
        }),
    );
  };
  const closeAuxiliaryTabs = () => closeTabs(true);
  const base = create(primary);
  hands.set(primary, base);
  const operations: Pick<
    ApplyRawPageHands,
    | "openTab"
    | "switchTab"
    | "closeTab"
    | "closeAuxiliaryTabs"
    | "readMailboxSession"
    | "readProviderSessions"
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
      const page = await primary.context().newPage();
      pages.set(`tab${++nextId}`, page);
      privateRead(page);
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
      if (active !== primary) privateRead(page);
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
    readProviderSessions: () =>
      Promise.all(
        providerSessionProbes.map(
          async ({ provider, url, accountControl }) => ({
            provider,
            status: await readProviderSession(primary, url, accountControl),
          }),
        ),
      ),
    readMailboxSession: async () => {
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
          return { status: "unknown" };
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
        const origin = new URL(probe.url()).origin;
        if (origin === "https://accounts.google.com")
          return { status: "google_accounts_redirect" };
        if (origin !== "https://mail.google.com") return { status: "unknown" };
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
          ? {
              status: "signed_in",
              accounts: [{ email, url: "https://mail.google.com/mail/u/0/" }],
            }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
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
    void closeTabs(false);
  });
  sessions.set(primary, wrapped);
  return wrapped;
}

async function readProviderSession(
  primary: Page,
  url: string,
  accountControl: string,
): Promise<"signed_in" | "unknown"> {
  const target = new URL(url);
  const context = primary.context();
  const atTarget = (page: Page) => {
    const address = page.url();
    if (!URL.canParse(address)) return false;
    const current = new URL(address);
    return (
      current.origin === target.origin && current.pathname === target.pathname
    );
  };
  let probe: Page | undefined;
  try {
    const existing = context.pages().find(atTarget);
    if (!existing && !(await context.cookies(url)).length) return "unknown";
    const page = existing ?? (probe = await context.newPage());
    if (probe) {
      markPrivateTracePage(probe);
      await owners.get(primary)?.(probe);
      await withNavigationLiveness(probe, () =>
        page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 }),
      );
    }
    if (!atTarget(page)) return "unknown";
    return (await page.locator(accountControl).first().isVisible())
      ? "signed_in"
      : "unknown";
  } catch {
    return "unknown";
  } finally {
    await probe?.close().catch(() => undefined);
  }
}

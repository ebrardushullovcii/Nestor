import { redactAccountUrl, trackAccountFlowEntry } from "./account-flow-entry";
import { inheritTaskPageOwner } from "./task-page-tabs";
import type {
  ApplyPageSession,
  ApplyRawPageHands,
  RawApplyPage,
} from "@nestor/contracts";
import type { Locator, Page } from "playwright";
import type { ApplicationRunServiceWorkerSentinel } from "./playwright-application-flow";

type AccountSession = ApplyPageSession & {
  closeAccountWindow(): Promise<void>;
};

/** Account windows are ordinary site pages. Keep the application's own Page
 * bound while routing browser tools to the account page it opened. No requests,
 * navigation, values, or model actions are filtered or counted here. */
export function withAccountWindowSession(input: {
  page: Page;
  session: ApplyPageSession;
  sentinel?: ApplicationRunServiceWorkerSentinel;
  signal?: AbortSignal;
  locate(ref: string): Locator | null;
  click(locator: Locator): Promise<void>;
  mechanics(page: Page): ApplyRawPageHands;
}): AccountSession {
  const { page, session, signal } = input;
  trackAccountFlowEntry(page);
  let child: Page | null = null;
  let childHands: ApplyRawPageHands | null = null;
  let accountFlow = false;
  const opened = new Set<Page>();
  const onPopup = (popup: Page) => {
    if (!accountFlow || signal?.aborted) return;
    opened.add(popup);
    inheritTaskPageOwner(page, popup);
    child = popup;
    childHands = input.mechanics(popup);
    popup.on("popup", onPopup);
    popup.once("close", () => {
      if (child === popup) {
        child = null;
        childHands = null;
      }
    });
  };
  page.on?.("popup", onPopup);
  const active = (): ApplyRawPageHands => {
    signal?.throwIfAborted();
    if (child?.isClosed()) {
      child = null;
      childHands = null;
    }
    return childHands ?? session;
  };
  const read = async (): Promise<RawApplyPage> => {
    const raw = await active().readPage();
    if (!accountFlow) return raw;
    const url = new URL(raw.url ?? (child ?? page).url());
    return {
      ...raw,
      url: redactAccountUrl(raw.url),
      links: raw.links.map((link) => ({
        ...link,
        href: redactAccountUrl(link.href) ?? "",
      })),
      openedTabs: [],
      accountWindow: {
        ...(child ? {} : { surface: "same_tab" as const }),
        origin: url.origin,
        pathname: url.pathname,
      },
    };
  };
  return {
    ...session,
    closeAccountWindow: async () => {
      page.off?.("popup", onPopup);
      for (const popup of opened) {
        popup.off("popup", onPopup);
        if (!popup.isClosed()) await popup.close().catch(() => undefined);
      }
      opened.clear();
      child = null;
      childHands = null;
      accountFlow = false;
    },
    clickOpeningAccountWindow: async (grant) => {
      signal?.throwIfAborted();
      accountFlow = true;
      const result = await active().clickElement(grant.ref);
      if (!result.ok)
        return { kind: "refused", reason: "ref_changed", detail: result.error };
      return {
        kind: child ? "opened" : "no_window",
        url: redactAccountUrl((child ?? page).url()) ?? "",
      };
    },
    renewAccountWindow: () => {
      signal?.throwIfAborted();
      return Promise.resolve(true);
    },
    readPage: read,
    screenshot: (frame) => active().screenshot!(frame),
    pointer: (input) => active().pointer!(input),
    openTab: (url) => active().openTab!(url),
    switchTab: (id) => active().switchTab!(id),
    closeTab: (id) => active().closeTab!(id),
    closeAuxiliaryTabs: async () => {
      await childHands?.closeAuxiliaryTabs?.();
      await session.closeAuxiliaryTabs?.();
    },
    fillText: (ref, value) => active().fillText(ref, value),
    typeKeys: (ref, text) => active().typeKeys!(ref, text),
    chooseOption: (ref, value) => active().chooseOption(ref, value),
    setToggle: (ref, value) => active().setToggle(ref, value),
    uploadFile: (ref, file) => active().uploadFile(ref, file),
    clickElement: (ref) => active().clickElement(ref),
    clickAction: (ref) => active().clickAction(ref),
    followLink: (ref) => active().followLink(ref),
    navigate: (url) => active().navigate(url),
    pressKey: (ref, key) => active().pressKey(ref, key),
    scroll: (direction) => active().scroll(direction),
    wait: (milliseconds) => active().wait(milliseconds),
    goBack: () => active().goBack(),
    readText: (ref) => active().readText(ref),
    clickAuthorizedFormAction: (ref) =>
      active().clickAuthorizedFormAction!(ref),
    clickAuthorizedLoginAction: (grant) => active().clickElement(grant.ref),
    clickWithoutWrites: (expected) => active().clickElement(expected.ref),
    clickBoundAction: (expected) => active().clickElement(expected.ref),
  };
}

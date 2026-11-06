import { selfLimitTimeout } from "@nestor/core";
import {
  readAccountFlowEntry,
  trackAccountFlowEntry,
  redactAccountUrl,
} from "./account-flow-entry";
import { randomUUID } from "node:crypto";
import type {
  ApplyAccountWindowGrant,
  ApplyAccountWindowResult,
  ApplyNavigationResult,
  ApplyPageSession,
  ApplyRawPageHands,
  ApplyWriteResult,
  RawApplyPage,
} from "@nestor/contracts";
import type { Frame, Locator, Page } from "playwright";
import {
  ACCOUNT_WINDOW_OPEN_MESSAGE,
  armAccountWindowInPage,
  cancelAccountWindowInPage,
  getBlockedPrepareOnlyAttempts,
  hasActiveAccountWindow,
  installAccountWindowContainment,
  pendingAccountWindowInPage,
  recordPrepareOnlyRunInterruption,
  releaseAccountWindowInPage,
  openPrepareOnlyProviderWriteWindow,
  registerAccountSurfaceOrigins,
  type ApplicationRunServiceWorkerSentinel,
} from "./playwright-application-flow";

const BUSY = ACCOUNT_WINDOW_OPEN_MESSAGE;
/** Provider writes one surface may commit: chooser, step, confirmation. */
const MAX_COMMITS = 4;
/** Non-committing actions (typing, plain navigation) one surface allows. */
const MAX_STEPS = 8;
type Surface = {
  writeOrigins: readonly string[];
  disclosable: readonly string[];
  /** Actions that actually sent a provider write. */
  actionsLeft: number;
  /** Actions that sent none: typing, a GET link, a press the page ignored. */
  stepsLeft: number;
  /** Provider documents this surface has committed. */
  documents: number;
  /** The document count last acknowledged by the workflow. */
  renewedAt: number;
  secondWindow: boolean;
  ledgerKeys: Set<string>;
};
type Slot = Surface & {
  child: Page;
  mechanics: ApplyRawPageHands;
  openerVersion: number;
};
type AccountSession = ApplyPageSession & {
  closeAccountWindow(): Promise<void>;
};

/** The original application Page and its guard/operation binding never change. */
export function withAccountWindowSession(input: {
  page: Page;
  session: ApplyPageSession;
  sentinel?: ApplicationRunServiceWorkerSentinel;
  signal?: AbortSignal;
  locate(ref: string): Locator | null;
  click(locator: Locator): Promise<void>;
  mechanics(page: Page): ApplyRawPageHands;
}): AccountSession {
  const { page, session, sentinel, signal } = input;
  trackAccountFlowEntry(page);
  let slot: Slot | null = null;
  let sameTab: Surface | null = null;
  let childWriteUntil = 0,
    childRequestsLeft = 0;
  let interacting = false;
  let closeProviderWindow: (() => Promise<void>) | null = null;
  const originOf = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return "null";
    }
  };
  const surface = (
    grant: ApplyAccountWindowGrant,
    ledgerKeys: Set<string>,
  ): Surface => ({
    writeOrigins: [...grant.writeOrigins],
    disclosable: [
      ...new Set(
        (grant.disclosableValues ?? []).filter((value) => !!value.trim()),
      ),
    ].slice(0, 2),
    actionsLeft: Math.max(
      1,
      Math.min(MAX_COMMITS, Math.trunc(grant.maxActions ?? 1) || 1),
    ),
    stepsLeft: MAX_STEPS,
    documents: 0,
    renewedAt: 0,
    secondWindow: false,
    ledgerKeys,
  });
  /** What the workflow may still do on this surface. */
  const remaining = (active: Surface) =>
    active.stepsLeft > 0 ? active.actionsLeft : 0;
  let pending: { locator: Locator; token: string; child: Page | null } | null =
    null;
  let lastRead: RawApplyPage | null = null;
  let accountFlowStarted = false;
  const redactPage = (raw: RawApplyPage): RawApplyPage => ({
    ...raw,
    url: redactAccountUrl(raw.url),
    actions: raw.actions.map((action) => ({
      ...action,
      ...(action.formAction
        ? { formAction: redactAccountUrl(action.formAction) ?? "" }
        : {}),
    })),
    links: raw.links.map((link) => ({
      ...link,
      href: redactAccountUrl(link.href) ?? "",
    })),
    openedTabs: raw.openedTabs.map((tab) => ({
      ...tab,
      url: redactAccountUrl(tab.url) ?? "",
    })),
  });
  let openerVersion = 0;
  const inactive = () => signal?.aborted || sentinel?.isDetached() === true;
  const entryKey = (
    attempt: Awaited<ReturnType<typeof getBlockedPrepareOnlyAttempts>>[number],
  ) =>
    `${attempt.kind}|${attempt.method ?? ""}|${attempt.url ?? ""}|${attempt.at}`;
  const refused = (
    reason: Extract<ApplyAccountWindowResult, { kind: "refused" }>["reason"],
    detail: string,
  ): ApplyAccountWindowResult => ({ kind: "refused", reason, detail });
  const refresh = () => {
    if (sameTab && !sameTab.writeOrigins.includes(originOf(page.url())))
      sameTab = null;
    if (
      slot &&
      (slot.child.isClosed() || slot.openerVersion !== openerVersion)
    ) {
      const previous = slot;
      slot = null;
      if (!previous.child.isClosed()) {
        const timer = setTimeout(() => {
          void previous.child.close().catch(() => undefined);
        }, 2_000);
        timer.unref();
      }
    }
  };
  // DOMContentLoaded belongs to a new main-frame document. History/hash
  // changes keep the original form and its active account child intact.
  const onNavigation = () => {
    openerVersion++;
    refresh();
  };
  const onSameTabCommit = (frame: Frame) => {
    if (
      sameTab &&
      frame === page.mainFrame() &&
      sameTab.writeOrigins.includes(originOf(frame.url()))
    )
      sameTab.documents++;
  };
  const removeNavigationListeners = () => {
    page.off("domcontentloaded", onNavigation);
    page.off("framenavigated", onSameTabCommit);
    page.off("close", removeNavigationListeners);
  };
  page.on("domcontentloaded", onNavigation);
  page.on("framenavigated", onSameTabCommit);
  page.once("close", removeNavigationListeners);
  sentinel?.onDetach?.(removeNavigationListeners);
  const cancelPending = async () => {
    const previous = pending;
    sentinel?.disarmAccountWindow();
    if (!previous) return;
    await cancelAccountWindowInPage(previous.locator, previous.token);
    if (
      previous.child &&
      !previous.child.isClosed() &&
      previous.child.url() === "about:blank"
    )
      await previous.child.close().catch(() => undefined);
  };
  signal?.addEventListener(
    "abort",
    () => {
      removeNavigationListeners();
      void closeProviderWindow?.();
      void cancelPending();
    },
    { once: true },
  );
  const item = (raw: RawApplyPage | null, ref: string) =>
    raw &&
    [
      ...raw.controls.map((value) => ({
        ...value,
        ref: value.ref ?? `c${value.index}`,
      })),
      ...raw.actions.map((value) => ({
        ...value,
        ref: value.ref ?? `a${value.index}`,
      })),
      ...raw.links.map((value) => ({
        ...value,
        ref: value.ref ?? `l${value.index}`,
      })),
      ...raw.clickables.map((value) => ({
        ...value,
        ref: value.ref ?? `x${value.index}`,
      })),
    ].find((value) => value.ref === ref);
  const gate = () => {
    refresh();
    return inactive()
      ? "aborted"
      : slot || sameTab || pending || hasActiveAccountWindow(page)
        ? BUSY
        : null;
  };
  const write = async (
    work: () => Promise<ApplyWriteResult>,
  ): Promise<ApplyWriteResult> => {
    const error = gate();
    return error ? { ok: false, error } : work();
  };
  const navigate = async (
    work: () => Promise<ApplyNavigationResult>,
  ): Promise<ApplyNavigationResult> => {
    refresh();
    if (inactive()) return { ok: false, error: "aborted" };
    if (sameTab) {
      sameTab = null;
      await closeProviderWindow?.();
      return work();
    }
    const error = gate();
    return error ? { ok: false, error } : work();
  };
  const windowMethod = async (work: () => Promise<void>) => {
    const error = gate();
    if (error) throw new Error(error);
    await work();
  };
  const waitForReturn = (active: Slot): Promise<void> =>
    new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        active.child.off("close", finish);
        active.child.off("domcontentloaded", finish);
        page.off("domcontentloaded", finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, 10_000);
      active.child.on("close", finish);
      active.child.on("domcontentloaded", finish);
      page.on("domcontentloaded", finish);
      sentinel?.onDetach?.(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (
        inactive() ||
        active.child.isClosed() ||
        active.openerVersion !== openerVersion
      )
        finish();
    });
  const asWrite = (
    result: ApplyWriteResult | ApplyNavigationResult,
  ): ApplyWriteResult => {
    if (!result.ok)
      return {
        ...result,
        error: result.error.replace(
          /https?:\/\/[^\s"'<>]+/gu,
          (url) => redactAccountUrl(url) ?? "[account page]",
        ),
      };
    return "url" in result
      ? { ok: true, observedValue: redactAccountUrl(result.url) ?? "" }
      : result;
  };
  const click = async (
    kind: "clickElement" | "clickAction" | "followLink",
    ref: string,
  ): Promise<ApplyWriteResult> => {
    refresh();
    if (inactive()) return { ok: false, error: "aborted" };
    if (interacting) return { ok: false, error: BUSY };
    const active = slot ?? sameTab;
    if (!active)
      return pending || hasActiveAccountWindow(page)
        ? { ok: false, error: BUSY }
        : asWrite(await session[kind](ref));
    if (
      remaining(active) <= 0 ||
      active.secondWindow ||
      !active.writeOrigins.includes(originOf((slot?.child ?? page).url()))
    )
      return { ok: false, error: BUSY };
    // Only a press that actually sends a provider write spends a commit;
    // one that sends none (a GET link, an ignored press) spends a step.
    const spend = (writes: number) => {
      if (writes > 0) active.actionsLeft--;
      else active.stepsLeft--;
    };
    interacting = true;
    if (slot) {
      const child = slot;
      childWriteUntil = Date.now() + 10_000;
      childRequestsLeft = 8;
      const returned = waitForReturn(child);
      try {
        const result = await child.mechanics[kind](ref);
        await returned;
        spend(8 - Math.max(0, childRequestsLeft));
        refresh();
        if (inactive()) return { ok: false, error: "aborted" };
        return child.child.isClosed() || child.openerVersion !== openerVersion
          ? {
              ok: true,
              observedValue: "Account window returned to the application.",
            }
          : asWrite(result);
      } finally {
        childWriteUntil = 0;
        childRequestsLeft = 0;
        interacting = false;
      }
    }
    const settle = selfLimitTimeout(
      page.waitForEvent("domcontentloaded", { timeout: 10_000 }),
      10_000,
      "packages/browser-runtime/src/account-window-session.ts:349",
    ).catch(() => undefined);
    const writes = await openPrepareOnlyProviderWriteWindow(page, {
      origins: active.writeOrigins,
      disclosableValues: active.disclosable,
      active: () => !inactive() && sameTab === active,
    });
    closeProviderWindow = writes;
    try {
      const result = await session[kind](ref);
      await settle;
      spend(writes.writes());
      refresh();
      return inactive() ? { ok: false, error: "aborted" } : asWrite(result);
    } finally {
      await writes();
      closeProviderWindow = null;
      interacting = false;
    }
  };
  return {
    ...session,
    closeAccountWindow: async () => {
      await cancelPending();
      if (slot && !slot.child.isClosed())
        await slot.child.close().catch(() => undefined);
      slot = null;
      sameTab = null;
      await closeProviderWindow?.();
    },
    readAccountFlowEntry: (origins) =>
      Promise.resolve(readAccountFlowEntry(slot?.child ?? page, origins)),
    // The workflow validated identity and access on the new page; the runtime
    // only checks that the same live surface really moved to a new document.
    renewAccountWindow: (expected) => {
      refresh();
      const active = slot ?? sameTab;
      if (
        inactive() ||
        interacting ||
        !active ||
        active.secondWindow ||
        active.documents <= active.renewedAt ||
        remaining(active) <= 0
      )
        return Promise.resolve(false);
      let url: URL;
      try {
        url = new URL((slot?.child ?? page).url());
      } catch {
        return Promise.resolve(false);
      }
      if (
        url.username ||
        url.password ||
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        !active.writeOrigins.includes(url.origin)
      )
        return Promise.resolve(false);
      active.renewedAt = active.documents;
      return Promise.resolve(true);
    },
    clickOpeningAccountWindow: async (
      grant: ApplyAccountWindowGrant,
    ): Promise<ApplyAccountWindowResult> => {
      refresh();
      if (inactive())
        return refused("aborted", "This application run has ended.");
      if (slot || sameTab || pending || hasActiveAccountWindow(page))
        return refused("busy", BUSY);
      const expectedPage = lastRead;
      if (
        !grant.writeOrigins.length ||
        grant.writeOrigins.some(
          (origin) =>
            originOf(origin) !== origin || origin === originOf(page.url()),
        )
      )
        return refused(
          "window_blocked",
          "Account writes must use exact provider origins distinct from the application.",
        );
      readAccountFlowEntry(page, grant.writeOrigins);
      accountFlowStarted = true;
      registerAccountSurfaceOrigins(page, grant.writeOrigins);
      const expected = item(expectedPage, grant.ref);
      const fresh = await session.readPage();
      const current = item(fresh, grant.ref);
      if (
        !expected ||
        !current ||
        expectedPage?.url !== fresh.url ||
        expectedPage.stepLabel !== fresh.stepLabel ||
        expected.label !== current.label ||
        !current.visible ||
        ("disabled" in current && current.disabled)
      )
        return refused(
          "ref_changed",
          "The account control changed. Read the page again.",
        );
      const locator = input.locate(grant.ref);
      if (!locator)
        return refused("ref_changed", "The account control disappeared.");
      const frame = await locator
        .evaluate(() =>
          window === window.top
            ? null
            : { origin: location.origin, pathname: location.pathname },
        )
        .catch(() => undefined);
      if (
        frame === undefined ||
        (frame === null
          ? grant.frame !== null
          : !grant.frame ||
            frame.origin !== grant.frame.origin ||
            frame.pathname !== grant.frame.pathname)
      )
        return refused(
          "frame_changed",
          "The account control's owning frame changed.",
        );
      if (!(await locator.isVisible()) || !(await locator.isEnabled()))
        return refused("ref_changed", "The account control is unavailable.");
      const targetBlankLink = await locator.evaluate(
        (element) =>
          element instanceof HTMLAnchorElement &&
          !!element.target &&
          element.target !== "_self",
      );
      if (targetBlankLink)
        return refused(
          "window_blocked",
          "Only a script-created account window can be contained before navigation.",
        );
      if (!sentinel)
        return refused(
          "not_claimed",
          "This run cannot claim an account window.",
        );
      const token = randomUUID();
      const version = openerVersion;
      pending = { locator, token, child: null };
      const claimed = sentinel
        .armAccountWindow(token, Date.now() + 5_000)
        .then((child) => {
          if (pending?.token === token) pending.child = child;
          return child;
        });
      const ledgerKeys = new Set(
        (await getBlockedPrepareOnlyAttempts(page)).map(entryKey),
      );
      try {
        await armAccountWindowInPage(locator, token, Date.now() + 3_000);
        if (inactive())
          return refused("aborted", "The application run was cancelled.");
        await input.click(locator);
        if (inactive())
          return refused("aborted", "The application run was cancelled.");
        // A same-tab document navigation destroys the ref's old execution
        // context. Do not wait for that ref to reappear on the destination.
        if (
          openerVersion !== version ||
          !(await pendingAccountWindowInPage(locator, token))
        ) {
          // A native anchor popup has no wrapper pending slot. Let its claim
          // decision/close-and-record finish before deciding this was same-tab.
          const unexpected = await claimed;
          if (unexpected && !unexpected.isClosed()) {
            await unexpected.close().catch(() => undefined);
            recordPrepareOnlyRunInterruption(page, {
              kind: "popup_open",
              method: "GET",
              url: redactAccountUrl(unexpected.url()),
              at: new Date().toISOString(),
            });
          }
          if (inactive())
            return refused("aborted", "The application run was cancelled.");
          const blocked = (await getBlockedPrepareOnlyAttempts(page))
            .filter((attempt) => !ledgerKeys.has(entryKey(attempt)))
            .some(
              (attempt) =>
                attempt.kind === "window_open" || attempt.kind === "popup_open",
            );
          if (pending.child && !pending.child.isClosed())
            await pending.child.close().catch(() => undefined);
          return blocked
            ? refused(
                "window_blocked",
                "The page opened an unsupported account window.",
              )
            : (() => {
                if (grant.writeOrigins.includes(originOf(page.url())))
                  sameTab = surface(grant, ledgerKeys);
                return {
                  kind: "no_window" as const,
                  url: redactAccountUrl(page.url()) ?? "",
                };
              })();
        }
        const child = await claimed;
        if (inactive())
          return refused("aborted", "The application run was cancelled.");
        if (!child)
          return refused(
            "not_claimed",
            "The blank account window could not be claimed.",
          );
        if (
          !(await child
            .evaluate(
              (expected) =>
                (window as unknown as Record<string, unknown>)[
                  "__nestorAccountWindowClaimToken"
                ] === expected,
              token,
            )
            .catch(() => false))
        ) {
          await child.close().catch(() => undefined);
          return refused(
            "not_claimed",
            "The claimed window does not match this click's token.",
          );
        }
        if (child.url() !== "about:blank") {
          await child.close().catch(() => undefined);
          return refused(
            "navigated_before_containment",
            "The account window navigated before containment.",
          );
        }
        trackAccountFlowEntry(child);
        readAccountFlowEntry(child, grant.writeOrigins);
        let committed = false;
        const navigated = (frame: Frame) => {
          if (frame === child.mainFrame() && frame.url() !== "about:blank")
            committed = true;
        };
        child.on("framenavigated", navigated);
        try {
          await installAccountWindowContainment(child, {
            opener: page,
            writeOrigins: grant.writeOrigins,
            disclosableValues: surface(grant, ledgerKeys).disclosable,
            canWrite: () =>
              !inactive() &&
              slot?.child === child &&
              Date.now() < childWriteUntil &&
              childRequestsLeft-- > 0,
          });
        } catch {
          await child.close().catch(() => undefined);
          return refused(
            inactive() ? "aborted" : "window_blocked",
            "The account window could not be contained.",
          );
        } finally {
          child.off("framenavigated", navigated);
        }
        if (inactive())
          return refused("aborted", "The application run was cancelled.");
        if (committed || child.url() !== "about:blank") {
          await child.close().catch(() => undefined);
          return refused(
            "navigated_before_containment",
            "The account window navigated before containment.",
          );
        }
        if (!(await releaseAccountWindowInPage(locator, token)))
          return refused(
            "not_claimed",
            "The account window's navigation grant expired.",
          );
        const opened: Slot = {
          ...surface(grant, ledgerKeys),
          // Its first provider document is where it opened.
          renewedAt: 1,
          child,
          mechanics: input.mechanics(child),
          openerVersion: version,
        };
        slot = opened;
        child.on("framenavigated", (frame) => {
          if (
            frame === child.mainFrame() &&
            opened.writeOrigins.includes(originOf(frame.url()))
          )
            opened.documents++;
        });
        const loaded = await selfLimitTimeout(
          child.waitForLoadState("domcontentloaded", { timeout: 15_000 }),
          15_000,
          "packages/browser-runtime/src/account-window-session.ts:648",
        ).then(
          () => true,
          () => false,
        );
        if (inactive())
          return refused("aborted", "The application run was cancelled.");
        if (!loaded && !child.isClosed()) {
          opened.actionsLeft = 0;
          return refused(
            "window_blocked",
            "The account window did not finish loading safely.",
          );
        }
        return { kind: "opened", url: redactAccountUrl(child.url()) ?? "" };
      } catch {
        return refused(
          inactive() ? "aborted" : "window_blocked",
          "The account window could not be kept safely.",
        );
      } finally {
        if (openerVersion === version)
          await cancelAccountWindowInPage(locator, token);
        sentinel.disarmAccountWindow();
        if (
          pending?.child &&
          !slot &&
          !pending.child.isClosed() &&
          pending.child.url() === "about:blank"
        )
          await pending.child.close().catch(() => undefined);
        pending = null;
      }
    },
    readPage: async () => {
      refresh();
      if (inactive()) throw new Error("aborted");
      const active = slot;
      if (!active) {
        lastRead = await session.readPage();
        if (sameTab) {
          const more = (await getBlockedPrepareOnlyAttempts(page))
            .filter((attempt) => !sameTab!.ledgerKeys.has(entryKey(attempt)))
            .some(
              (attempt) =>
                attempt.kind === "window_open" || attempt.kind === "popup_open",
            );
          if (more) {
            sameTab.secondWindow = true;
            sameTab.actionsLeft = 0;
          }
          const url = new URL(lastRead.url ?? page.url());
          return {
            ...lastRead,
            url: redactAccountUrl(lastRead.url),
            accountWindow: {
              surface: "same_tab",
              origin: url.origin,
              pathname: url.pathname,
              actionsLeft: remaining(sameTab),
              ...(sameTab.secondWindow
                ? {
                    refusal: {
                      reason: "second_window",
                      detail:
                        "The account page tried to open another window. Finish this step yourself.",
                    },
                  }
                : {}),
            },
          } as RawApplyPage;
        }
        return accountFlowStarted ? redactPage(lastRead) : lastRead;
      }
      const extraWindow = (await getBlockedPrepareOnlyAttempts(page))
        .filter((attempt) => !active.ledgerKeys.has(entryKey(attempt)))
        .some(
          (attempt) =>
            attempt.kind === "popup_open" || attempt.kind === "window_open",
        );
      const childTried = (
        await Promise.all(
          active.child
            .frames()
            .map((frame) =>
              frame
                .evaluate(
                  () =>
                    (window as unknown as Record<string, unknown>)[
                      "__nestorAccountWindowSecondWindow"
                    ] === true,
                )
                .catch(() => false),
            ),
        )
      ).some(Boolean);
      if (!active.secondWindow && (extraWindow || childTried)) {
        active.secondWindow = true;
        active.actionsLeft = 0;
        if (childTried)
          recordPrepareOnlyRunInterruption(page, {
            kind: "popup_open",
            method: "GET",
            url: null,
            at: new Date().toISOString(),
            carriedPreparedValue: false,
          });
      }
      const raw = await active.mechanics.readPage();
      refresh();
      if (slot !== active) {
        lastRead = await session.readPage();
        return lastRead;
      }
      let origin = "null",
        pathname = "";
      try {
        const url = new URL(raw.url ?? "");
        if (!url.username && !url.password) {
          origin = url.origin;
          pathname = url.pathname;
        }
      } catch {
        /* Person-only unresolved surface. */
      }
      return {
        ...redactPage(raw),
        url: redactAccountUrl(raw.url),
        openedTabs: [],
        accountWindow: {
          origin,
          pathname,
          actionsLeft: remaining(active),
          ...(active.secondWindow
            ? {
                refusal: {
                  reason: "second_window" as const,
                  detail:
                    "The account page tried to open another window. Finish this step yourself.",
                },
              }
            : {}),
        },
      };
    },
    clickElement: (ref) => click("clickElement", ref),
    clickAction: (ref) => click("clickAction", ref),
    followLink: async (ref) => {
      refresh();
      if (slot || sameTab) {
        const result = await click("followLink", ref);
        return result.ok
          ? {
              ok: true,
              url: redactAccountUrl((slot?.child ?? page).url()) ?? "",
            }
          : result;
      }
      return navigate(() => session.followLink(ref));
    },
    fillText: async (ref, value) => {
      refresh();
      if (inactive()) return { ok: false, error: "aborted" };
      const active = slot ?? sameTab;
      if (!active) return write(() => session.fillText(ref, value));
      if (
        interacting ||
        remaining(active) <= 0 ||
        active.secondWindow ||
        !active.writeOrigins.includes(originOf((slot?.child ?? page).url())) ||
        !active.disclosable.includes(value)
      )
        return { ok: false, error: BUSY };
      active.stepsLeft--;
      return asWrite(
        await (slot
          ? slot.mechanics.fillText(ref, value)
          : session.fillText(ref, value)),
      );
    },
    chooseOption: (ref, value) => write(() => session.chooseOption(ref, value)),
    setToggle: (ref, value) => write(() => session.setToggle(ref, value)),
    uploadFile: (ref, file) => write(() => session.uploadFile(ref, file)),
    pressKey: (ref, key) => write(() => session.pressKey(ref, key)),
    navigate: (url) => navigate(() => session.navigate(url)),
    goBack: () => navigate(() => session.goBack()),
    adoptOpenedTab: (index) => navigate(() => session.adoptOpenedTab!(index)),
    ...(session.clickAuthorizedLoginAction
      ? {
          clickAuthorizedLoginAction: (
            grant: Parameters<
              NonNullable<ApplyPageSession["clickAuthorizedLoginAction"]>
            >[0],
          ) => write(() => session.clickAuthorizedLoginAction!(grant)),
        }
      : {}),
    clickAuthorizedFormAction: (ref) =>
      write(() => session.clickAuthorizedFormAction(ref)),
    ...(session.clickWithoutWrites
      ? {
          clickWithoutWrites: (
            expected: Parameters<
              NonNullable<ApplyPageSession["clickWithoutWrites"]>
            >[0],
          ) => write(() => session.clickWithoutWrites!(expected)),
        }
      : {}),
    ...(session.clickBoundAction
      ? {
          // Refused before any press while an account surface is busy.
          clickBoundAction: async (
            expected: Parameters<
              NonNullable<ApplyPageSession["clickBoundAction"]>
            >[0],
          ): Promise<ApplyWriteResult> => {
            const error = gate();
            return error
              ? { ok: false, error, reason: "binding_changed" }
              : session.clickBoundAction!(expected);
          },
        }
      : {}),
    installPrepareOnlyGuard: (guard) =>
      windowMethod(() => session.installPrepareOnlyGuard(guard)),
    registerPreparedValue: (value) =>
      windowMethod(() => session.registerPreparedValue(value)),
    openIntermediateWriteWindow: () =>
      windowMethod(() => session.openIntermediateWriteWindow()),
    scroll: (direction) => write(() => session.scroll(direction)),
    readText: (ref) => {
      refresh();
      if (inactive()) return Promise.reject(new Error("aborted"));
      return slot ? slot.mechanics.readText(ref) : session.readText(ref);
    },
    wait: async (milliseconds) => {
      if (inactive()) throw new Error("aborted");
      await session.wait(milliseconds);
      if (inactive()) throw new Error("aborted");
    },
    readBlockedAttempt: () =>
      inactive()
        ? Promise.reject(new Error("aborted"))
        : session.readBlockedAttempt(),
    checkServiceWorker: () =>
      inactive()
        ? Promise.reject(new Error("aborted"))
        : session.checkServiceWorker(),
    readIntermediateWriteCount: () => {
      if (inactive()) throw new Error("aborted");
      return session.readIntermediateWriteCount();
    },
  };
}

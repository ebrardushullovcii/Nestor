import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

/**
 * Built-app check of the assistant working in the embedded browser: the page
 * next to the sidebar, collecting jobs from the page, tab switching, and a
 * person's click taking a lent tab back (ADR 0038). Live model:
 *
 *   pnpm --filter @nestor/desktop qa --provider configured --script scripts/test-job-finder-assistant-browser.mjs
 *
 * The Playwright-launched window does not get OS focus by itself, so the
 * script asks macOS to activate it. The takeover step simulates the person's
 * pointer: it moves Electron's reported cursor over the page and sends a real
 * mouse-down to that page, which is the same input the app listens for.
 * Nothing is sent to any site.
 */

const run = promisify(execFile);

const currentConversation = (qa) =>
  qa.page.evaluate(async () => {
    const list = await window.nestor.assistant.listConversations();
    if (!list.currentConversationId) return null;
    return window.nestor.assistant.readConversation({
      conversationId: list.currentConversationId,
    });
  });

async function waitFor(
  read,
  done,
  { timeoutMs = 60_000, label = "condition" } = {},
) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function replyText(view) {
  const reply = view?.messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  return (reply?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function send(qa, text) {
  const before = (await currentConversation(qa))?.messages.length ?? 0;
  const composer = qa.page.locator("[data-assistant-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
  return before;
}

async function waitReply(qa, before, timeoutMs = 240_000) {
  return waitFor(
    () => currentConversation(qa),
    (view) =>
      view !== null &&
      view.activeTurn === null &&
      view.messages.length >= before + 2,
    { timeoutMs, label: "the reply" },
  );
}

async function focusApp(qa) {
  const pid = qa.app.process().pid;
  // Ask macOS to bring exactly this Electron process forward.
  await run("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
  ]).catch((error) =>
    console.log(`osascript: ${error.message.split("\n")[0]}`),
  );
  return qa.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows().find((entry) =>
      entry.isVisible(),
    );
    window?.show();
    window?.focus();
    return window?.isFocused() ?? false;
  });
}

async function nativeShot(qa, name) {
  const bounds = await qa.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) =>
      entry.isVisible(),
    );
    return window?.getBounds() ?? null;
  });
  if (!bounds) return null;
  const file = path.join(qa.runDir, `${name}-native.png`);
  try {
    await run("screencapture", [
      "-x",
      "-R",
      `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      file,
    ]);
    return file;
  } catch (error) {
    console.log(`screencapture: ${error.message.split("\n")[0]}`);
    return null;
  }
}

async function pageHosts(qa) {
  return qa.app.evaluate(({ BrowserWindow, webContents }) => {
    const windows = BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused(),
      children: window.contentView?.children?.length ?? 0,
    }));
    const pages = webContents
      .getAllWebContents()
      .filter((contents) => /^https?:\/\/127\.0\.0\.1/u.test(contents.getURL()))
      .map((contents) => ({ id: contents.id, url: contents.getURL() }));
    return { windows, pages };
  });
}

export default async function browserHarness(qa) {
  const results = [];
  const record = (id, verdict, detail = "") => {
    results.push({ id, verdict, detail });
    console.log(`${verdict} ${id}${detail ? `: ${detail}` : ""}`);
  };
  const site = (p) => new URL(p, qa.sites.url).href;

  await qa.page.waitForFunction(
    () =>
      typeof window.nestor?.jobFinder?.test?.loadAgentOwnedBrowserDemo ===
      "function",
  );
  await qa.page.evaluate(
    (input) => window.nestor.jobFinder.test.loadAgentOwnedBrowserDemo(input),
    {
      sourceUrl: site("/greenhouse/"),
      applicationUrl: site("/greenhouse/apply/3"),
    },
  );
  await qa.page.reload();
  const win = await qa.app.browserWindow(qa.page);
  await win.evaluate((w) => w.setContentSize(1440, 900));
  const focused = await focusApp(qa);
  record("focus", focused ? "PASS" : "INFO", `window focused: ${focused}`);
  if (!focused) {
    // macOS would not activate a Playwright-launched window. Report the main
    // window as focused so the browser keeps its pages in it, the way it does
    // for a person using the app. This simulates focus; it is not OS focus.
    await qa.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isVisible()) window.isFocused = () => true;
      }
    });
    record(
      "focus-simulated",
      "INFO",
      "window reported as focused inside Electron",
    );
  }

  // Open the sidebar (it may already be open from an earlier state).
  const sidebar = qa.page.locator("aside[data-assistant-sidebar]");
  await qa.page.waitForTimeout(800);
  if (!(await sidebar.isVisible())) await qa.page.keyboard.press("Meta+I");
  await sidebar.waitFor({ state: "visible" });
  await qa.page.evaluate(
    (url) => window.nestor.browser.command({ type: "open", url }),
    site("/greenhouse/"),
  );
  await qa.page.waitForTimeout(3000);
  await focusApp(qa);
  const hosts = await pageHosts(qa);
  const chip = await qa.page
    .locator("[data-assistant-context-chip]")
    .innerText();
  await qa.capture("b1-browser-open");
  const shot = await nativeShot(qa, "b1-browser-open");
  record(
    "side-by-side",
    /Browser/u.test(chip) ? "PASS" : "FAIL",
    `chip "${chip}"; native shot ${shot ?? "unavailable"}; ${JSON.stringify(hosts)}`,
  );

  // m13: collecting the jobs on the page.
  let before = await send(qa, "Collect the jobs on this page.");
  let view = await waitReply(qa, before);
  const collected = view.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "activity")
    .flatMap((part) => part.entries)
    .filter((entry) => entry.toolName === "collect_page_jobs");
  record(
    "m13",
    /\b(10|[5-9]) (jobs|postings)/iu.test(replyText(view)) ||
      collected.some((entry) => entry.outcome === "done")
      ? "PASS"
      : "FAIL",
    replyText(view).slice(0, 220),
  );
  await qa.capture("b2-collected");

  // Tab switching: a second tab, then back; the chip and the model follow the visible tab.
  await qa.page.evaluate(() =>
    window.nestor.browser.command({ type: "new_tab" }),
  );
  await qa.page.waitForTimeout(800);
  await qa.page.evaluate(
    (url) => window.nestor.browser.command({ type: "navigate", url }),
    site("/lever/"),
  );
  await qa.page.waitForTimeout(2500);
  before = await send(
    qa,
    "Which job site is open in the browser right now? One sentence.",
  );
  view = await waitReply(qa, before, 120_000);
  const tabReply = replyText(view);
  record(
    "tab-switch",
    /copper kite|lever/iu.test(tabReply) ? "PASS" : "FAIL",
    tabReply.slice(0, 200),
  );
  await qa.capture("b3-second-tab");

  // Takeover by click: while the assistant works in the lent tab, the person
  // clicks the page. The second time the pointer is already resting on the
  // same pixel as the first click, which must still count as the person.
  const warp = process.env.NESTOR_QA_WARP ?? "";
  const home = warp ? (await run(warp, [])).stdout.trim().split(/\s+/u) : null;
  const takeover = async (id, text, returnHome) => {
    before = await send(qa, text);
    await waitFor(
      () => currentConversation(qa),
      (current) =>
        current?.activity?.toolName?.startsWith("browser") === true ||
        (current?.activeTurn === null && current.messages.length >= before + 2),
      { timeoutMs: 120_000, label: "a browser step" },
    );
    // Click while the lease is held: a few seconds into the page-by-page work.
    await qa.page.waitForTimeout(8000);
    // Where the page sits on screen, in points.
    // The page view on screen now (the agent may have moved to another
    // posting since the message was sent).
    const target = await qa.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((entry) =>
        entry.isVisible(),
      );
      if (!window) return null;
      const content = window.getContentBounds();
      const view = (window.contentView?.children ?? []).find((child) => {
        const bounds = child.getBounds?.();
        return (
          child.webContents &&
          child.webContents.id !== window.webContents.id &&
          (typeof child.getVisible !== "function" || child.getVisible()) &&
          bounds &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      });
      if (!view) return null;
      const bounds = view.getBounds();
      return {
        pageId: view.webContents.id,
        x: content.x + bounds.x + Math.floor(bounds.width / 2),
        y: content.y + bounds.y + Math.floor(bounds.height / 2),
      };
    });
    let clicked = "no page";
    if (target) {
      // The person's hand on the page: the real OS pointer sits on the page
      // (no click is posted by the OS), then the page gets the mouse press.
      if (warp) await run(warp, [String(target.x), String(target.y)]);
      clicked = await qa.app.evaluate(({ webContents }, input) => {
        const page = webContents.fromId(input.pageId);
        if (!page) return "no page";
        for (const type of ["mouseDown", "mouseUp"]) {
          page.sendInputEvent({
            type,
            x: 200,
            y: 200,
            button: "left",
            clickCount: 1,
          });
        }
        return `clicked at ${input.x},${input.y}`;
      }, target);
      if (warp && home && returnHome) await run(warp, home);
      if (!warp) clicked += " (no pointer warp: set NESTOR_QA_WARP)";
    }
    view = await waitReply(qa, before);
    const activity = view.messages
      .slice(before)
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "activity")
      .flatMap((part) => part.entries);
    const refusedAfter = activity.some((entry) =>
      /took this tab back/iu.test(entry.detail ?? ""),
    );
    record(
      id,
      refusedAfter && /took (this tab|it|the tab) back/iu.test(replyText(view))
        ? "PASS"
        : "FAIL",
      `${clicked}; refused after takeover: ${refusedAfter}; reply: ${replyText(view).slice(0, 240)}`,
    );
    await qa.capture(`b4-${id}`);
  };
  try {
    await takeover(
      "takeover",
      "Go through each job on this page one by one and read its full details, then summarize them.",
      false,
    );
    await takeover(
      "takeover-repeat-click",
      "Please carry on: open each job on this page one by one and tell me its location.",
      true,
    );
  } finally {
    if (warp && home) await run(warp, home);
  }

  console.log(JSON.stringify({ provider: qa.provider, results }, null, 2));
}

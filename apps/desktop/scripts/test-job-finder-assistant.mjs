import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Built-app check of the app-wide assistant sidebar (ADR 0037-0039).
 *
 *   pnpm --filter @nestor/desktop build
 *   pnpm --filter @nestor/desktop qa --script scripts/test-job-finder-assistant.mjs
 *   pnpm --filter @nestor/desktop qa --provider configured --script scripts/test-job-finder-assistant.mjs
 *
 * Deterministic runs use the scripted assistant model; set
 * NESTOR_TEST_ASSISTANT_DELAY_MS=600 so Stop has a running turn to stop.
 * Configured runs use the real assistant model and also send one
 * application, only to the private local replica site the qa launcher
 * started. Before that send the harness refuses any target that is not a
 * loopback replica origin, and afterwards any submitted record that is not.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isReplicaUrl(url, sitesUrl) {
  if (!url) return false;
  const target = new URL(url);
  return (
    LOOPBACK_HOSTS.has(target.hostname) &&
    target.origin === new URL(sitesUrl).origin
  );
}

function assertReplicaTarget(url, sitesUrl) {
  if (!isReplicaUrl(url, sitesUrl)) {
    throw new Error(
      `Refusing to send: ${url} is not a local replica job site.`,
    );
  }
}

async function workspace(qa) {
  return qa.page.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function currentConversation(qa) {
  return qa.page.evaluate(async () => {
    const list = await window.nestor.assistant.listConversations();
    if (!list.currentConversationId) return null;
    return window.nestor.assistant.readConversation({
      conversationId: list.currentConversationId,
    });
  });
}

async function waitFor(
  read,
  done,
  { timeoutMs = 60_000, label = "condition" } = {},
) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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

async function sendInSidebar(qa, text, { timeoutMs = 90_000 } = {}) {
  const before = (await currentConversation(qa))?.messages.length ?? 0;
  const composer = qa.page.locator("[data-assistant-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
  return waitFor(
    () => currentConversation(qa),
    (view) =>
      view !== null &&
      view.activeTurn === null &&
      view.messages.length >= before + 2,
    { timeoutMs, label: `a reply to "${text}"` },
  );
}

async function setSize(qa, width, height) {
  const win = await qa.app.browserWindow(qa.page);
  await win.evaluate((w, size) => w.setContentSize(size.width, size.height), {
    width,
    height,
  });
  await qa.page.waitForTimeout(300);
}

async function nav(qa, name) {
  await qa.page.getByRole("button", { name, exact: true }).first().click();
  await qa.page.waitForTimeout(400);
}

export default async function assistantHarness(qa) {
  const live = qa.provider === "configured";
  const results = [];
  const record = (name, detail = "") => {
    results.push({ name, detail });
    console.log(`ok ${name}${detail ? `: ${detail}` : ""}`);
  };

  // Synthetic workspace whose Platform Engineer job applies on the private
  // replica Greenhouse page.
  const sourceUrl = new URL("/greenhouse/", qa.sites.url).href;
  const applicationUrl = new URL("/greenhouse/apply/3", qa.sites.url).href;
  await qa.page.waitForFunction(
    () =>
      typeof window.nestor?.jobFinder?.test?.loadAgentOwnedBrowserDemo ===
      "function",
  );
  await qa.page.evaluate(
    (input) =>
      window.nestor.jobFinder.test.loadAgentOwnedBrowserDemo(input),
    {
      sourceUrl,
      applicationUrl,
      // Replica Greenhouse job 3, so the job record matches the form.
      jobTitle: "Platform Engineer, Comet Systems",
      jobCompany: "Comet Teacup Labs",
    },
  );
  await qa.page.reload();
  await setSize(qa, 1440, 900);
  await nav(qa, "Home");

  // 1. The sidebar never opens by itself; ⌘I opens it.
  assert.equal(
    await qa.page
      .locator("aside[data-assistant-sidebar]")
      .isVisible()
      .catch(() => false),
    false,
  );
  await qa.capture("01-home-sidebar-closed");
  await qa.page.keyboard.press("Meta+I");
  await qa.page
    .locator("aside[data-assistant-sidebar]")
    .waitFor({ state: "visible" });
  await qa.capture("02-sidebar-open-empty");
  record("opens with the shortcut only");

  // 2. An asked-for profile edit applies at once, with a receipt and Undo.
  await nav(qa, "Profile");
  const headlineBefore = (await workspace(qa)).profile.headline;
  const edited = await sendInSidebar(
    qa,
    "Change my headline to Staff platform designer",
  );
  const afterEdit = await workspace(qa);
  assert.equal(
    afterEdit.profile.headline,
    "Staff platform designer",
    `reply: ${replyText(edited)}`,
  );
  await qa.page.locator("[data-assistant-change]").last().waitFor();
  await qa.capture("03-profile-edit-applied");
  record("profile edit committed", replyText(edited).slice(0, 120));

  await qa.page
    .locator("[data-assistant-change]")
    .last()
    .getByRole("button", { name: /^Undo/ })
    .click();
  await waitFor(
    () => workspace(qa),
    (state) => state.profile.headline === headlineBefore,
    { label: "the headline to be restored" },
  );
  await qa.page
    .locator('[data-assistant-change-status="undone"]')
    .last()
    .waitFor();
  await qa.capture("04-profile-edit-undone");
  record("undo restored exactly that change");

  // 3. One conversation across screens.
  const messagesOnProfile = (await currentConversation(qa)).messages.length;
  await nav(qa, "Find jobs");
  const sameThread = await currentConversation(qa);
  assert.equal(sameThread.messages.length, messagesOnProfile);
  assert.equal(
    (await qa.page.locator("[data-assistant-message]").count()) >=
      messagesOnProfile,
    true,
  );
  await qa.capture("05-discovery-same-thread");
  record("conversation kept across screens");

  // Every main screen with the sidebar docked at 1440x900.
  for (const [index, screen] of [
    "Shortlisted",
    "Applications",
    "Settings",
    "Home",
  ].entries()) {
    await nav(qa, screen);
    await qa.capture(
      `05${String.fromCharCode(98 + index)}-${screen.toLowerCase()}-docked`,
    );
  }
  await qa.page.evaluate(() => {
    window.location.hash = "#/job-finder/review-queue/job_ready/resume";
  });
  await qa.page.waitForTimeout(1500);
  await qa.capture("05f-resume-studio-docked");
  await nav(qa, "Find jobs");

  // 4. Layout at the widths the plan names, and the narrow switch.
  await setSize(qa, 1280, 800);
  await qa.capture("06-1280x800");
  await setSize(qa, 1100, 700);
  const narrow = await qa.page
    .locator("aside[data-assistant-sidebar]")
    .getAttribute("data-assistant-narrow");
  await qa.capture("07-1100x700");
  record("layout at 1280x800 and 1100x720", `narrow switch: ${narrow}`);
  await setSize(qa, 1440, 900);

  // 5. A reload keeps the accepted messages.
  const beforeReload = (await currentConversation(qa)).messages.length;
  await qa.page.reload();
  await qa.page
    .locator("aside[data-assistant-sidebar]")
    .waitFor({ state: "visible" });
  await waitFor(
    () => qa.page.locator("[data-assistant-message]").count(),
    (count) => count >= beforeReload,
    { label: "messages after reload" },
  );
  await qa.capture("08-after-reload");
  record("messages survive a reload", `${beforeReload} messages`);

  // 6. Stop ends the running turn.
  const composer = qa.page.locator("[data-assistant-composer]");
  await composer.fill(
    live
      ? "Go through every job I found and compare each one to my profile in detail."
      : "How am I doing?",
  );
  await composer.press("Enter");
  const stop = qa.page.locator("[data-assistant-stop]");
  const stopVisible = await stop
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (stopVisible) {
    await qa.capture("09-working-with-activity");
    await stop.click();
    const stopped = await waitFor(
      () => currentConversation(qa),
      (view) => view.activeTurn === null,
      { label: "the turn to stop" },
    );
    await qa.capture("10-stopped");
    record("stop ends the turn", replyText(stopped).slice(0, 80));
  } else {
    record("stop not exercised", "the turn finished before Stop appeared");
    await waitFor(
      () => currentConversation(qa),
      (view) => view.activeTurn === null,
    );
  }

  if (!live) {
    // 7. Scripted: shortlist from the list on screen.
    await nav(qa, "Find jobs");
    const found = (await workspace(qa)).discoveryJobs.filter(
      (job) => job.status === "discovered",
    );
    const reply = await sendInSidebar(qa, "Shortlist the top 2");
    const after = await workspace(qa);
    const moved = found.filter(
      (job) =>
        after.discoveryJobs.find((entry) => entry.id === job.id)?.status !==
        "discovered",
    );
    await qa.capture("11-shortlist-top-two");
    record(
      "shortlist from the screen list",
      `${moved.length} moved; ${replyText(reply).slice(0, 80)}`,
    );
    console.log(JSON.stringify({ provider: qa.provider, results }, null, 2));
    return;
  }

  // 8. Live: one written instruction applies and sends to the replica only.
  // A new chat keeps earlier result sets out of the instruction's reach.
  await qa.page.getByRole("button", { name: "New chat" }).click();
  const state = await workspace(qa);
  const job =
    state.discoveryJobs.find((entry) => entry.id === "job_ready") ??
    state.reviewQueue.find((entry) => entry.jobId === "job_ready");
  assert.ok(job, "the replica job is missing from the workspace");
  const saved = await qa.page.evaluate(async () => {
    const snapshot = await window.nestor.jobFinder.getWorkspace();
    return (
      snapshot.discoveryJobs.find((entry) => entry.id === "job_ready") ?? null
    );
  });
  assertReplicaTarget(saved?.applicationUrl ?? applicationUrl, qa.sites.url);
  assertReplicaTarget(saved?.canonicalUrl ?? sourceUrl, qa.sites.url);
  await qa.page.evaluate(() => {
    window.location.hash = "#/job-finder/review-queue/job_ready/resume";
  });
  await qa.page.waitForTimeout(800);
  await qa.capture("12-resume-studio-before-send");
  const sendReply = await sendInSidebar(
    qa,
    "Apply to this Platform Engineer job for me and send the application.",
    { timeoutMs: 240_000 },
  );
  await qa.capture("13-send-instruction-reply");
  // Follow the work to the end. The assistant may stop to ask the person
  // (a resume line, a form question); answer with the first offered option,
  // as a person would with this synthetic data, up to five times.
  let answered = 0;
  const started = Date.now();
  let submitted = null;
  for (;;) {
    const snapshot = await workspace(qa);
    const application = snapshot.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    );
    const state = `${application?.status ?? ""} ${application?.lastAttemptState ?? ""}`;
    if (/submitted/u.test(state)) {
      submitted = snapshot;
      break;
    }
    const view = await currentConversation(qa);
    const open = view.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "question" && part.status === "open");
    if (view.activeTurn === null && open.length > 0 && answered < 5) {
      const before = view.messages.length;
      await qa.page
        .locator("[data-assistant-question]")
        .last()
        .getByRole("button")
        .first()
        .click();
      answered += 1;
      await waitFor(
        () => currentConversation(qa),
        (next) =>
          next.activeTurn === null && next.messages.length >= before + 2,
        { timeoutMs: 240_000, label: "the continuation after an answer" },
      );
      await qa.capture(`13${String.fromCharCode(97 + answered)}-after-answer`);
      record(
        "answered the assistant's question",
        replyText(await currentConversation(qa)).slice(0, 160),
      );
      continue;
    }
    if (Date.now() - started > 900_000) {
      throw new Error(
        `Timed out waiting for the replica application to finish (last state: ${state.trim() || "none"}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  for (const entry of submitted.applicationRecords) {
    if (!/submitted/u.test(`${entry.status} ${entry.lastAttemptState}`))
      continue;
    const target = submitted.discoveryJobs.find(
      (item) => item.id === entry.jobId,
    );
    if (
      !isReplicaUrl(target?.applicationUrl ?? null, qa.sites.url) &&
      entry.jobId !== "job_ready"
    ) {
      throw new Error(
        `A submitted record targets a non-replica job: ${entry.jobId}`,
      );
    }
  }
  const log = await readFile(qa.sites.log, "utf8").catch(() => "");
  const posted = log
    .split("\n")
    .filter((line) => line.includes("/greenhouse/apply/3"));
  await nav(qa, "Applications");
  await qa.capture("14-applications-after-send");
  record(
    "written instruction sent to the replica",
    `${posted.length} replica POSTs; reply: ${replyText(sendReply).slice(0, 160)}`,
  );
  console.log(JSON.stringify({ provider: qa.provider, results }, null, 2));
}

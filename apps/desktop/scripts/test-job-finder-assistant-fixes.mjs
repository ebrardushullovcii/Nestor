import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Built-app re-check of the assistant tester's findings, with the configured
 * (live) model:
 *
 *   pnpm --filter @nestor/desktop build
 *   pnpm --filter @nestor/desktop qa --provider configured --script scripts/test-job-finder-assistant-fixes.mjs
 *
 * Sends go only to the private replica site the qa launcher started; the
 * harness refuses any other target before sending.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function assertReplicaTarget(url, sitesUrl) {
  const target = new URL(url);
  if (
    !LOOPBACK_HOSTS.has(target.hostname) ||
    target.origin !== new URL(sitesUrl).origin
  ) {
    throw new Error(
      `Refusing to send: ${url} is not a local replica job site.`,
    );
  }
}

const workspace = (qa) =>
  qa.page.evaluate(() => window.nestor.jobFinder.getWorkspace());

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
    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
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

async function sendInSidebar(qa, text, { timeoutMs = 180_000 } = {}) {
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
    { timeoutMs, label: `a reply to "${text.slice(0, 40)}"` },
  );
}

async function nav(qa, name) {
  await qa.page.getByRole("button", { name, exact: true }).first().click();
  await qa.page.waitForTimeout(600);
}

async function newChat(qa) {
  // Each journey starts clean: a browser left open by the one before covers
  // the page with its backdrop and swallows the next journey's clicks.
  await qa.page
    .evaluate(() => window.nestor.browser.command({ type: "minimize" }))
    .catch(() => undefined);
  await qa.page.keyboard.press("Escape").catch(() => undefined);
  await qa.page.waitForTimeout(600);
  const sidebar = qa.page.locator("aside[data-assistant-sidebar]");
  if (!(await sidebar.isVisible())) await qa.page.keyboard.press("Meta+I");
  await qa.page.getByRole("button", { name: "New chat" }).click();
  await qa.page.waitForTimeout(400);
}

export default async function fixesHarness(qa) {
  const results = [];
  const record = (id, verdict, detail = "") => {
    results.push({ id, verdict, detail });
    console.log(`${verdict} ${id}${detail ? `: ${detail}` : ""}`);
  };
  const site = (path) => new URL(path, qa.sites.url).href;
  // NESTOR_QA_ONLY=M4 runs one journey (comma-separated ids).
  const only = (process.env.NESTOR_QA_ONLY ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const wanted = (id) => only.length === 0 || only.includes(id);
  const alreadySent = async (jobId) =>
    (await workspace(qa)).applicationRecords.some(
      (record) => record.jobId === jobId && record.status === "submitted",
    );
  // One journey failing never stops the rest.
  // Each journey reads only the replica log lines written since it began.
  let logStart = 0;
  const journey = async (id, run) => {
    logStart = (await readFile(qa.sites.log, "utf8").catch(() => "")).length;
    try {
      await run();
    } catch (error) {
      record(
        id,
        "FAIL",
        `crashed: ${String(error?.message ?? error).slice(0, 300)}`,
      );
      await qa.capture(`crash-${id}`).catch(() => undefined);
    }
  };
  // NESTOR_QA_BOARD=lever points the two apply jobs at the Lever replica.
  const board =
    process.env.NESTOR_QA_BOARD === "lever" ? "lever" : "greenhouse";

  await qa.page.waitForFunction(
    () =>
      typeof window.nestor?.jobFinder?.test?.loadAgentOwnedBrowserDemo ===
      "function",
  );
  await qa.page.evaluate(
    (input) => window.nestor.jobFinder.test.loadAgentOwnedBrowserDemo(input),
    {
      sourceUrl: site(`/${board}/`),
      applicationUrl: site(`/${board}/apply/3`),
      secondaryApplicationUrl: site(`/${board}/apply/5`),
      jobTitle: "Platform Engineer, Comet Systems",
      jobCompany: "Comet Teacup Labs",
      foundJobs: [
        {
          title: "Backend Engineer, Lantern Services",
          company: "Lantern Pixel Works",
          applicationUrl: site("/greenhouse/apply/2"),
        },
        {
          title: "Frontend Engineer, Paper Interfaces",
          company: "Paper Orbit Studio",
          applicationUrl: site("/greenhouse/apply/4"),
        },
        {
          title: "Data Engineer, Meadow Pipelines",
          company: "Meadow Byte Guild",
          applicationUrl: site("/greenhouse/apply/6"),
        },
        {
          title: "Backend Engineer, Willow APIs",
          company: "Lantern Pixel Works",
          applicationUrl: site("/greenhouse/apply/7"),
        },
        // N8: the same role the /lever/ listing shows second, saved earlier
        // from another source under a different company name.
        {
          title: "Backend Engineer, Lantern Services",
          company: "Lantern Holdings",
          applicationUrl: site("/lever/jobs/2"),
        },
      ],
    },
  );
  await qa.page.reload();
  const win = await qa.app.browserWindow(qa.page);
  await win.evaluate((w) => w.setContentSize(1440, 900));
  // Open the sidebar (it may already be open from an earlier state).
  const sidebar = qa.page.locator("aside[data-assistant-sidebar]");
  await qa.page.waitForTimeout(800);
  if (!(await sidebar.isVisible())) await qa.page.keyboard.press("Meta+I");
  await sidebar.waitFor({ state: "visible" });

  // M9: the old chat endpoints refuse writes.
  if (wanted("M9"))
    await journey("M9", async () => {
      const legacy = await qa.page.evaluate(async () => {
        const outcomes = [];
        for (const call of [
          () =>
            window.nestor.jobFinder.sendProfileCopilotMessage(
              "Change my headline",
              { surface: "profile", section: "basics" },
            ),
          () =>
            window.nestor.jobFinder.sendResumeAssistantMessage(
              "job_ready",
              "Tighten the summary.",
            ),
        ]) {
          try {
            await call();
            outcomes.push("accepted");
          } catch (error) {
            outcomes.push(
              String(error?.message ?? error).includes("retired")
                ? "refused"
                : "error",
            );
          }
        }
        return outcomes;
      });
      record(
        "M9",
        legacy.every((entry) => entry === "refused") ? "PASS" : "FAIL",
        legacy.join(", "),
      );
    });
  // M1: ticked rows are the selection, not the inspected row.
  if (wanted("M1"))
    await journey("M1", async () => {
      await nav(qa, "Find jobs");
      await qa.page
        .getByRole("checkbox", {
          name: "Select Frontend Engineer, Paper Interfaces",
        })
        .check();
      await qa.page
        .getByRole("checkbox", {
          name: "Select Data Engineer, Meadow Pipelines",
        })
        .check();
      await qa.capture("m1-ticked");
      const m1 = await sendInSidebar(qa, "shortlist the ones I ticked");
      const afterM1 = await workspace(qa);
      const shortlisted = new Set(
        afterM1.reviewQueue.map((item) => item.jobId),
      );
      await qa.capture("m1-after");
      const m1Ok =
        shortlisted.has("job_found_2") &&
        shortlisted.has("job_found_3") &&
        !shortlisted.has("job_found_1");
      record("M1", m1Ok ? "PASS" : "FAIL", replyText(m1).slice(0, 200));
    });
  // M7: excluding an employer hides every found job from them and says so.
  if (wanted("M7"))
    await journey("M7", async () => {
      await newChat(qa);
      const m7 = await sendInSidebar(
        qa,
        "Never show me jobs from Lantern Pixel Works again.",
      );
      const afterM7 = await workspace(qa);
      const stillListed = afterM7.discoveryJobs.filter(
        (job) =>
          job.company === "Lantern Pixel Works" && job.status === "discovered",
      );
      await nav(qa, "Find jobs");
      await qa.capture("m7-after-exclusion");
      record(
        "M7",
        stillListed.length === 0 ? "PASS" : "FAIL",
        `${stillListed.length} still listed; reply: ${replyText(m7).slice(0, 200)}`,
      );
    });
  // M6: a pick for "the best jobs" leaves out the excluded employer.
  if (wanted("M6"))
    await journey("M6", async () => {
      await newChat(qa);
      const m6 = await sendInSidebar(
        qa,
        "Which of my found jobs are the best matches? Just list them, don't change anything.",
      );
      const m6Text = replyText(m6);
      record(
        "M6",
        // Only the excluded employer and its own jobs count; another company
        // with "Lantern" in its name is not excluded.
        /Lantern Pixel Works|Willow APIs/iu.test(m6Text) ? "FAIL" : "PASS",
        m6Text.slice(0, 200),
      );
    });
  // M2 + M3: a resume edit reports only what was saved, and the open studio shows it.
  if (wanted("M2"))
    await journey("M2", async () => {
      await newChat(qa);
      await qa.page.evaluate(() => {
        window.location.hash = "#/job-finder/review-queue/job_ready/resume";
      });
      await qa.page.waitForTimeout(2500);
      const before = await qa.page.evaluate(() =>
        window.nestor.jobFinder.getResumeWorkspace("job_ready"),
      );
      const summaryBefore =
        before.draft.sections.find((section) => section.kind === "summary")
          ?.text ?? "";
      const m2 = await sendInSidebar(
        qa,
        "For this job, add a line to my resume summary saying I care about platform reliability.",
      );
      const after = await qa.page.evaluate(() =>
        window.nestor.jobFinder.getResumeWorkspace("job_ready"),
      );
      const summaryAfter =
        after.draft.sections.find((section) => section.kind === "summary")
          ?.text ?? "";
      const m2Reply = replyText(m2);
      const claimsSaved =
        /(saved|added|now (reads|ends|says))/iu.test(m2Reply) &&
        !/(not|n't) (saved|kept|added)/iu.test(m2Reply);
      const changed = summaryAfter !== summaryBefore;
      record(
        "M2",
        claimsSaved === changed || (changed && /reliab/iu.test(summaryAfter))
          ? "PASS"
          : "FAIL",
        `changed=${changed}; reply: ${m2Reply.slice(0, 220)}`,
      );
      await qa.page.waitForTimeout(2000);
      const shownSummary = await qa.page
        .getByLabel("Section text")
        .first()
        .inputValue()
        .catch(() => null);
      await qa.capture("m3-studio-after-edit");
      record(
        "M3",
        !changed || shownSummary === summaryAfter ? "PASS" : "FAIL",
        changed
          ? `studio shows saved text: ${shownSummary === summaryAfter}`
          : "no edit was saved, so nothing to refresh",
      );
    });
  // M4 + Greenhouse: send two, skip the second; the first sends without a nudge.
  if (wanted("M4"))
    await journey("M4", async () => {
      await newChat(qa);
      const snapshot = await workspace(qa);
      for (const job of snapshot.discoveryJobs.concat(snapshot.companyJobs)) {
        if (job.id === "job_ready" || job.id === "job_consent_queue") {
          assertReplicaTarget(
            job.applicationUrl ?? job.canonicalUrl,
            qa.sites.url,
          );
        }
      }
      await nav(qa, "Shortlisted");
      await sendInSidebar(
        qa,
        "Apply to the Platform Engineer, Comet Systems job and the Staff Product Designer job and send both.",
        { timeoutMs: 240_000 },
      );
      await sendInSidebar(
        qa,
        "Actually skip the Staff Product Designer one, don't send that.",
        { timeoutMs: 240_000 },
      );
      let answered = 0;
      const started = Date.now();
      let sent = false;
      for (;;) {
        const log = (
          await readFile(qa.sites.log, "utf8").catch(() => "")
        ).slice(logStart);
        sent =
          log.includes("/greenhouse/apply/3") &&
          /"path":"\/greenhouse\/apply\/3"/u.test(log);
        if (sent) break;
        const view = await currentConversation(qa);
        const open = view.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "question" && part.status === "open");
        if (view.activeTurn === null && open.length > 0 && answered < 4) {
          const buttons = qa.page
            .locator("[data-assistant-question]")
            .last()
            .getByRole("button");
          answered += 1;
          if ((await buttons.count()) > 0) {
            await buttons.first().click();
            await qa.page.waitForTimeout(3000);
          } else {
            await sendInSidebar(
              qa,
              "Keep that resume line as written, I'm authorized to work there and need no sponsorship. Go ahead and send it.",
              { timeoutMs: 240_000 },
            );
          }
          continue;
        }
        // A decision asked for in plain words gets a plain answer, as a person
        // would give (synthetic resume line, synthetic facts).
        if (
          view.activeTurn === null &&
          open.length === 0 &&
          answered < 4 &&
          /(waiting (on|for) you|your decision|before I can|needs you|which is true)/iu.test(
            replyText(view),
          )
        ) {
          answered += 1;
          await sendInSidebar(
            qa,
            "Keep that resume line as written, I'm authorized to work there and need no sponsorship. Go ahead and send it.",
            { timeoutMs: 240_000 },
          );
          continue;
        }
        if (Date.now() - started > 900_000) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const log = (await readFile(qa.sites.log, "utf8").catch(() => "")).slice(
        logStart,
      );
      const skippedSent = log.includes("/greenhouse/apply/5");
      await nav(qa, "Applications");
      await qa.capture("m4-applications");
      record(
        "M4",
        sent && !skippedSent ? "PASS" : "FAIL",
        `first sent=${sent}, skipped sent=${skippedSent}, questions answered=${answered}; reply: ${replyText(await currentConversation(qa)).slice(0, 200)}`,
      );
    });
  // N1: a prepared-but-unsent application must not hold up a send on the
  // same site, and retries must not pile up.
  if (wanted("N1"))
    await journey("N1", async () => {
      if (await alreadySent("job_ready")) {
        record(
          "N1",
          "SKIP",
          "Platform Engineer was already sent by an earlier journey in this session; run this one in a fresh session (NESTOR_QA_ONLY=N1).",
        );
        return;
      }
      await newChat(qa);
      const snapshot = await workspace(qa);
      for (const job of snapshot.discoveryJobs.concat(snapshot.companyJobs)) {
        if (job.id === "job_ready" || job.id === "job_consent_queue") {
          assertReplicaTarget(
            job.applicationUrl ?? job.canonicalUrl,
            qa.sites.url,
          );
        }
      }
      await nav(qa, "Shortlisted");
      const turnSeconds = [];
      const timed = async (text) => {
        const started = Date.now();
        const view = await sendInSidebar(qa, text, { timeoutMs: 420_000 });
        turnSeconds.push(Math.round((Date.now() - started) / 1000));
        return view;
      };
      await timed(
        "Prepare the application for the Staff Product Designer job but don't send it. I'll look it over and send it myself.",
      );
      await timed(
        "Apply to the Platform Engineer, Comet Systems job and send it.",
      );
      const started = Date.now();
      let answered = 0;
      let sent = false;
      for (;;) {
        const log = (
          await readFile(qa.sites.log, "utf8").catch(() => "")
        ).slice(logStart);
        sent = /"path":"\/greenhouse\/apply\/3"/u.test(log);
        if (sent) break;
        const view = await currentConversation(qa);
        const open = view.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "question" && part.status === "open");
        if (
          view.activeTurn === null &&
          answered < 4 &&
          (open.length > 0 ||
            /(waiting (on|for) you|your decision|which is true|need(s)? your answer)/iu.test(
              replyText(view),
            ))
        ) {
          answered += 1;
          const buttons = qa.page
            .locator("[data-assistant-question]")
            .last()
            .getByRole("button");
          if (open.length > 0 && (await buttons.count()) > 0) {
            await buttons.first().click();
            await qa.page.waitForTimeout(3000);
          } else {
            await timed(
              "Keep any resume line as written, I'm authorized to work there and need no sponsorship. Go ahead and send the Platform Engineer application.",
            );
          }
          continue;
        }
        if (Date.now() - started > 720_000) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const after = await workspace(qa);
      const runsPerJob = {};
      for (const result of after.applyJobResults) {
        runsPerJob[result.jobId] = (runsPerJob[result.jobId] ?? 0) + 1;
      }
      const log = (await readFile(qa.sites.log, "utf8").catch(() => "")).slice(
        logStart,
      );
      const preparedSent = /"path":"\/greenhouse\/apply\/5"/u.test(log);
      await nav(qa, "Applications");
      await qa.capture("n1-applications");
      const longest = Math.max(...turnSeconds);
      record(
        "N1",
        sent && !preparedSent && longest < 180 ? "PASS" : "FAIL",
        `sent=${sent} after ${Math.round((Date.now() - started) / 1000)}s; prepared-only sent=${preparedSent}; runs per job ${JSON.stringify(runsPerJob)}; longest turn ${longest}s; answered ${answered}; reply: ${replyText(await currentConversation(qa)).slice(0, 200)}`,
      );
    });

  // N3: a stopped request does not come back on the next message.
  if (wanted("N3"))
    await journey("N3", async () => {
      await newChat(qa);
      const composer = qa.page.locator("[data-assistant-composer]");
      await composer.click();
      await composer.fill(
        "Compare every shortlisted job against my profile in detail, one by one.",
      );
      await composer.press("Enter");
      await qa.page
        .locator("[data-assistant-stop]")
        .waitFor({ state: "visible", timeout: 20_000 });
      await qa.page.waitForTimeout(6000);
      await qa.page.locator("[data-assistant-stop]").click();
      await waitFor(
        () => currentConversation(qa),
        (view) => view.activeTurn === null,
        {
          timeoutMs: 60_000,
          label: "the stop",
        },
      );
      const next = await sendInSidebar(
        qa,
        "What is my headline? One sentence.",
        {
          timeoutMs: 180_000,
        },
      );
      const text = replyText(next);
      await qa.capture("n3-after-stop");
      record(
        "N3",
        text.length < 400 && !/\b1\.\s.*\b2\.\s/su.test(text) ? "PASS" : "FAIL",
        text.slice(0, 220),
      );
    });

  // N8: saving a page listing that matches a saved job keeps that job as it was.
  if (wanted("N8"))
    await journey("N8", async () => {
      await newChat(qa);
      const beforeJobs = await workspace(qa);
      const before = beforeJobs.discoveryJobs
        .concat(beforeJobs.companyJobs)
        .find((job) => job.id === "job_consent_queue");
      await qa.page.evaluate(
        (url) => window.nestor.browser.command({ type: "open", url }),
        site("/greenhouse/"),
      );
      await qa.page.waitForTimeout(3000);
      await qa.app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isVisible()) window.isFocused = () => true;
        }
      });
      const reply = await sendInSidebar(
        qa,
        "Collect the jobs on this page and save all of them to my jobs.",
        { timeoutMs: 300_000 },
      );
      const afterJobs = await workspace(qa);
      const changed = afterJobs.discoveryJobs
        .concat(afterJobs.companyJobs)
        .filter((job) => {
          const was = beforeJobs.discoveryJobs
            .concat(beforeJobs.companyJobs)
            .find((entry) => entry.id === job.id);
          return (
            was &&
            (was.company !== job.company ||
              was.title !== job.title ||
              was.status !== job.status)
          );
        });
      await qa.capture("n8-after-save");
      record(
        "N8",
        changed.length === 0 ? "PASS" : "FAIL",
        `${changed.length} existing jobs changed (${changed.map((job) => `${job.id}: ${job.company}/${job.status}`).join("; ")}); ${before ? `staff designer still ${before.company}` : ""}; reply: ${replyText(reply).slice(0, 200)}`,
      );

      // The tester's case: the second listing on /lever/ is a job the person
      // already saved (under another company name) and then skipped.
      await qa.page
        .evaluate(() =>
          window.nestor.jobFinder.dismissDiscoveryJob("job_found_5", ["role"]),
        )
        .catch(() => undefined);
      const skippedBefore = await qa.page.evaluate(async () => {
        const state = await window.nestor.jobFinder.getWorkspace();
        const hidden = (state.dismissedDiscoveryJobs ?? []).some(
          (job) => job.id === "job_found_5",
        );
        const job =
          [
            ...state.discoveryJobs,
            ...state.companyJobs,
            ...(state.dismissedDiscoveryJobs ?? []),
          ].find((entry) => entry.id === "job_found_5") ?? null;
        return JSON.stringify(
          job
            ? {
                company: job.company,
                status: `${job.status}/${hidden ? "hidden" : "visible"}`,
              }
            : null,
        );
      });
      await newChat(qa);
      await qa.page.evaluate(
        (url) => window.nestor.browser.command({ type: "open", url }),
        site("/lever/"),
      );
      await qa.page.waitForTimeout(3000);
      const lever = await sendInSidebar(qa, "Save the second one to my jobs.", {
        timeoutMs: 300_000,
      });
      const skippedAfter = await qa.page.evaluate(async () => {
        const state = await window.nestor.jobFinder.getWorkspace();
        const hidden = (state.dismissedDiscoveryJobs ?? []).some(
          (job) => job.id === "job_found_5",
        );
        const job =
          [
            ...state.discoveryJobs,
            ...state.companyJobs,
            ...(state.dismissedDiscoveryJobs ?? []),
          ].find((entry) => entry.id === "job_found_5") ?? null;
        return JSON.stringify(
          job
            ? {
                company: job.company,
                status: `${job.status}/${hidden ? "hidden" : "visible"}`,
              }
            : null,
        );
      });
      const was = JSON.parse(skippedBefore);
      const now = JSON.parse(skippedAfter);
      await qa.capture("n8-lever-second");
      record(
        "N8b",
        was &&
          now &&
          was.company === now.company &&
          was.status === now.status &&
          /hidden/.test(was.status)
          ? "PASS"
          : "FAIL",
        `before ${was?.company}/${was?.status}; after ${now?.company}/${now?.status}; reply: ${replyText(lever).slice(0, 240)}`,
      );
    });

  // m5: a keyboard selection in the resume editor goes with the message.
  if (wanted("m5"))
    await journey("m5", async () => {
      await newChat(qa);
      await qa.page.evaluate(() => {
        window.location.hash = "#/job-finder/review-queue/job_ready/resume";
      });
      const field = qa.page.locator("main textarea:visible").first();
      await field.waitFor({ timeout: 30_000 });
      // NESTOR_QA_DEBUG=1 logs every selection and focus event.
      if (process.env.NESTOR_QA_DEBUG)
        await qa.page.evaluate(() => {
          window.__selLog = [];
          const log = (event) => {
            const active = document.activeElement;
            window.__selLog.push({
              type: event.type,
              target: event.target?.tagName ?? String(event.target),
              active: active?.tagName,
              inSidebar: Boolean(active?.closest?.("[data-assistant-sidebar]")),
              range:
                active && "selectionStart" in active
                  ? [active.selectionStart, active.selectionEnd]
                  : null,
              doc: String(window.getSelection()).slice(0, 30),
              t: Math.round(performance.now()),
            });
          };
          document.addEventListener("selectionchange", log);
          document.addEventListener("select", log, true);
          document.addEventListener("focusin", log, true);
          document.addEventListener("focusout", log, true);
        });
      await field.click();
      await qa.page.keyboard.press("End");
      await qa.page.keyboard.press("Control+End");
      for (let index = 0; index < 30; index += 1)
        await qa.page.keyboard.press("Shift+ArrowLeft");
      const picked = await field.evaluate((element) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      );
      await qa.page.waitForTimeout(300);
      const reply = await sendInSidebar(
        qa,
        "Quote back exactly the text I selected, change nothing.",
      );
      const sent = reply.messages
        .filter((message) => message.role === "user")
        .at(-1);
      const context = sent?.context ?? null;
      const selected = context?.selectedText ?? null;
      await qa.capture("m5-selection");
      if (process.env.NESTOR_QA_DEBUG)
        console.log(
          JSON.stringify(
            await qa.page.evaluate(() => window.__selLog),
            null,
            0,
          ),
        );
      record(
        "m5",
        picked.length > 0 &&
          selected === picked &&
          context?.editor?.selection?.text === picked
          ? "PASS"
          : "FAIL",
        `selected ${JSON.stringify(picked)}; context ${JSON.stringify(selected)}; editor ${JSON.stringify(context?.editor?.selection?.text ?? null)}; reply: ${replyText(reply).slice(0, 160)}`,
      );
    });

  // R2: a search request does not lift the person's pause on its own.
  if (wanted("R2"))
    await journey("R2", async () => {
      await newChat(qa);
      await qa.page.evaluate(() =>
        window.nestor.jobFinder.setActivityControl({
          paused: true,
          reason: null,
        }),
      );
      const runsBefore = (await workspace(qa)).recentDiscoveryRuns?.length ?? 0;
      const reply = await sendInSidebar(qa, "Search for new jobs.");
      const after = await workspace(qa);
      const runsAfter = after.recentDiscoveryRuns?.length ?? 0;
      const stillPaused = after.activityControl.paused === true;
      await qa.capture("r2-paused-search");
      record(
        "R2",
        stillPaused &&
          !after.activeDiscoveryRun &&
          runsAfter === runsBefore &&
          /paus/iu.test(
            replyText(reply) +
              JSON.stringify(
                reply.messages
                  .at(-1)
                  ?.parts.filter((part) => part.type === "question") ?? [],
              ),
          )
          ? "PASS"
          : "FAIL",
        `paused after=${stillPaused}; new runs ${runsAfter - runsBefore}; reply: ${(replyText(reply) || JSON.stringify(reply.messages.at(-1)?.parts ?? [])).slice(0, 240)}`,
      );
      await qa.page.evaluate(() =>
        window.nestor.jobFinder.setActivityControl({ paused: false }),
      );
    });

  // R6: exporting the tracker from chat writes a file and says where.
  if (wanted("R6"))
    await journey("R6", async () => {
      await newChat(qa);
      const reply = await sendInSidebar(
        qa,
        "Export my application tracker as a spreadsheet.",
      );
      const text = replyText(reply);
      const conversation = await currentConversation(qa);
      const results = JSON.stringify(conversation?.messages ?? []);
      const pathMatch = /(\/[^\s"'`]+?\.csv)/u.exec(results);
      const written = pathMatch
        ? await readFile(pathMatch[1], "utf8").then(
            (content) => content.length > 0,
            () => false,
          )
        : false;
      record(
        "R6",
        written &&
          !/dialog|downloads/iu.test(text) &&
          text.includes(pathMatch[1].split("/").slice(-2).join("/"))
          ? "PASS"
          : "FAIL",
        `file ${pathMatch?.[1] ?? "none"} written=${written}; reply: ${text.slice(0, 240)}`,
      );
    });

  // R7: an answer the person gives once is used by the next application.
  if (wanted("R7"))
    await journey("R7", async () => {
      if (await alreadySent("job_ready")) {
        record(
          "R7",
          "SKIP",
          "Platform Engineer was already sent by an earlier journey in this session; run this one in a fresh session (NESTOR_QA_ONLY=R7).",
        );
        return;
      }
      await newChat(qa);
      await nav(qa, "Shortlisted");
      const openStep = (snapshot, jobId) =>
        snapshot.userActionRequests.filter(
          (request) =>
            request.scope?.jobId === jobId &&
            request.kind === "manual_answer" &&
            [
              "pending",
              "page_opened",
              "awaiting_user",
              "still_blocked",
            ].includes(request.state),
        );
      await sendInSidebar(
        qa,
        "Prepare the application for the Staff Product Designer job but don't send it. I'll look it over and send it myself.",
        { timeoutMs: 300_000 },
      );
      await waitFor(
        () => workspace(qa),
        (snapshot) =>
          openStep(snapshot, "job_consent_queue").length > 0 ||
          snapshot.applyJobResults.some(
            (result) =>
              result.jobId === "job_consent_queue" &&
              ["awaiting_review", "failed"].includes(result.state),
          ),
        { timeoutMs: 480_000, label: "the Staff Product Designer form" },
      );
      await waitFor(
        () => currentConversation(qa),
        (view) => view.activeTurn === null,
        { timeoutMs: 300_000, label: "the assistant to finish" },
      );
      await sendInSidebar(
        qa,
        "I'm legally authorized to work there and I don't need sponsorship. Put that on the form, and remember it for future applications.",
        { timeoutMs: 300_000 },
      );
      const withAnswer = await waitFor(
        () => workspace(qa),
        (snapshot) => openStep(snapshot, "job_consent_queue").length === 0,
        { timeoutMs: 300_000, label: "the answer to be taken" },
      ).catch(() => null);
      const bank = (await workspace(qa)).profile.answerBank.customAnswers.map(
        (entry) => entry.question,
      );
      const remembered = bank.some((question) =>
        /authori[sz]ed/iu.test(question),
      );
      await waitFor(
        () => currentConversation(qa),
        (view) => view.activeTurn === null,
        { timeoutMs: 300_000, label: "the assistant to finish" },
      );
      await sendInSidebar(
        qa,
        "Now prepare the application for the Platform Engineer, Comet Systems job too, but don't send it.",
        { timeoutMs: 300_000 },
      );
      const comet = await waitFor(
        () => workspace(qa),
        (snapshot) =>
          openStep(snapshot, "job_ready").length > 0 ||
          snapshot.applyJobResults.some(
            (result) =>
              result.jobId === "job_ready" &&
              ["awaiting_review", "failed", "submitted"].includes(result.state),
          ),
        { timeoutMs: 480_000, label: "the Comet form" },
      );
      const cometSteps = openStep(comet, "job_ready").map(
        (request) => request.title,
      );
      const log = (await readFile(qa.sites.log, "utf8").catch(() => "")).slice(
        logStart,
      );
      const anySent = /"path":"\/greenhouse\/apply\/(3|5)"/u.test(log);
      await qa.capture("r7-second-form");
      record(
        "R7",
        withAnswer && remembered && cometSteps.length === 0 && !anySent
          ? "PASS"
          : "FAIL",
        `first form answered=${Boolean(withAnswer)}; remembered=${remembered} (${bank.join(" | ").slice(0, 160)}); Comet open steps ${JSON.stringify(cometSteps)}; sent=${anySent}; reply: ${replyText(await currentConversation(qa)).slice(0, 200)}`,
      );
    });

  // NC: what goes into the form about the person is exactly what is stored.
  if (wanted("NC"))
    await journey("NC", async () => {
      if (await alreadySent("job_ready")) {
        record(
          "NC",
          "SKIP",
          "Platform Engineer was already sent by an earlier journey in this session; run this one in a fresh session (NESTOR_QA_ONLY=NC).",
        );
        return;
      }
      await newChat(qa);
      // Only the LinkedIn link changes: a different email would no longer
      // match the imported resume, which Job Finder rightly refuses.
      const linkedin = "https://www.linkedin.com/in/alex-vanguard-test-2026";
      const stored = await qa.page.evaluate(async (url) => {
        const state = await window.nestor.jobFinder.getWorkspace();
        const profile = state.profile;
        await window.nestor.jobFinder.saveProfile({
          ...profile,
          linkedinUrl: url,
          links: [
            ...profile.links.filter((link) => link.kind !== "linkedin"),
            {
              // Shortened like the ids the app builds; the value is the url.
              id: "link_linkedin_https_www_linkedin_com_in_alex_vanguard_",
              label: "LinkedIn",
              url,
              kind: "linkedin",
              isDraft: false,
            },
          ],
        });
        return {
          email: profile.applicationIdentity?.preferredEmail ?? profile.email,
          phone: profile.applicationIdentity?.preferredPhone ?? profile.phone,
          linkedin: url,
        };
      }, linkedin);
      const target = (await workspace(qa)).discoveryJobs
        .concat((await workspace(qa)).companyJobs)
        .find((job) => job.id === "job_ready");
      assertReplicaTarget(
        target?.applicationUrl ?? target?.canonicalUrl ?? site("/"),
        qa.sites.url,
      );
      await nav(qa, "Shortlisted");
      await sendInSidebar(
        qa,
        "Apply to the Platform Engineer, Comet Systems job and send it.",
        { timeoutMs: 420_000 },
      );
      const path = `/${board}/apply/3`;
      const started = Date.now();
      let line = null;
      let answered = 0;
      for (;;) {
        const log = (
          await readFile(qa.sites.log, "utf8").catch(() => "")
        ).slice(logStart);
        line =
          log
            .split("\n")
            .filter(Boolean)
            .map((entry) => JSON.parse(entry))
            .find((entry) => entry.method === "POST" && entry.path === path) ??
          null;
        if (line) break;
        const view = await currentConversation(qa);
        const open = view.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "question" && part.status === "open");
        if (view.activeTurn === null && answered < 3 && open.length > 0) {
          answered += 1;
          const buttons = qa.page
            .locator("[data-assistant-question]")
            .last()
            .getByRole("button");
          if ((await buttons.count()) > 0) await buttons.first().click();
          await qa.page.waitForTimeout(3000);
          continue;
        }
        if (
          view.activeTurn === null &&
          answered < 3 &&
          /(waiting (on|for) you|need(s)? your (answer|consent))/iu.test(
            replyText(view),
          )
        ) {
          answered += 1;
          await sendInSidebar(
            qa,
            "Yes, I consent to the background check and I'm authorized to work there with no sponsorship. Go ahead and send it.",
            { timeoutMs: 300_000 },
          );
          continue;
        }
        if (Date.now() - started > 720_000) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const fields = line?.fields ?? {};
      const mismatches = [
        ["email", fields.email, stored.email],
        ["phone", fields.phone, stored.phone],
        ...(board === "lever"
          ? [["linkedin", fields.linkedin, stored.linkedin]]
          : []),
      ].filter(([, sent, want]) => sent !== want);
      record(
        "NC",
        line && mismatches.length === 0 ? "PASS" : "FAIL",
        `POST ${path} ${line ? "sent" : "not sent"}; sent ${JSON.stringify({ email: fields.email, phone: fields.phone, linkedin: fields.linkedin })}; mismatches ${JSON.stringify(mismatches)}`,
      );
    });

  // SM: the side-menu switch acts when flipped, without Save appearance.
  if (wanted("SM"))
    await journey("SM", async () => {
      await newChat(qa);
      await qa.page.evaluate(() => {
        window.location.hash = "#/job-finder/settings";
      });
      const sidebar = qa.page.locator("aside[data-assistant-sidebar]");
      if (!(await sidebar.isVisible())) await qa.page.keyboard.press("Meta+I");
      await qa.page.waitForTimeout(1000);
      const rail = () =>
        qa.page.evaluate(
          () =>
            document.querySelector("[data-job-finder-shell]")?.dataset
              .sidebarCollapsed ?? null,
        );
      const width = await qa.page.evaluate(() => window.innerWidth);
      const foldedBefore = await rail();
      const toggle = qa.page.getByRole("switch", {
        name: "Collapse the side menu while the assistant is open",
      });
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await qa.page.waitForTimeout(1500);
      const saved = (await workspace(qa)).settings
        .collapseSideMenuWithAssistant;
      const foldedAfter = await rail();
      const unsaved = await qa.page
        .getByText("Not saved yet")
        .count()
        .catch(() => 0);
      await qa.capture("sm-switch-off");
      await toggle.click();
      await qa.page.waitForTimeout(1500);
      const savedOn = (await workspace(qa)).settings
        .collapseSideMenuWithAssistant;
      const foldedOn = await rail();
      record(
        "SM",
        saved === false &&
          savedOn === true &&
          unsaved === 0 &&
          (width < 1440 ||
            (foldedBefore === "true" &&
              foldedAfter === "false" &&
              foldedOn === "true"))
          ? "PASS"
          : "FAIL",
        `width ${width}; folded ${foldedBefore} -> off: saved=${saved}, folded ${foldedAfter} -> on: saved=${savedOn}, folded ${foldedOn}; "Not saved yet" shown ${unsaved}`,
      );
    });

  // m9: an over-long message stays in the box.
  if (wanted("m9"))
    await journey("m9", async () => {
      await newChat(qa);
      const composer = qa.page.locator("[data-assistant-composer]");
      await composer.fill("x".repeat(20_050));
      await composer.press("Enter");
      const kept = (await composer.inputValue()).length;
      await qa.capture("m9-too-long");
      record(
        "m9",
        kept === 20_050 ? "PASS" : "FAIL",
        `kept ${kept} characters`,
      );
      await composer.fill("");
    });
  console.log(JSON.stringify({ provider: qa.provider, results }, null, 2));
  assert.ok(results.length > 0);
}

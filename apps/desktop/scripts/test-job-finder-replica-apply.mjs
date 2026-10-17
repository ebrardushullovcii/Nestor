import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession } from "./agent-qa/session.mjs";
import { startReplicaModel } from "./replica-apply-model.mjs";
import prepareValues from "./test-job-finder-prepare-values.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workspace = (qa) =>
  qa.page.evaluate(() => window.nestor.jobFinder.getWorkspace());

function localUrl(qa, route) {
  const url = new URL(route, qa.sites.url);
  assert.equal(
    url.hostname,
    "127.0.0.1",
    "Replica checks refuse non-loopback targets",
  );
  assert.equal(url.origin, new URL(qa.sites.url).origin);
  return url.href;
}

async function formContents(qa, url, script) {
  return qa.app.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL() === input.url);
      if (!contents)
        throw new Error(`No retained replica form at ${input.url}`);
      return contents.executeJavaScript(input.script);
    },
    { url, script },
  );
}

async function captureForm(qa, url, label) {
  const png = await qa.app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => entry.getURL() === target);
    return (await contents.capturePage()).toPNG().toString("base64");
  }, url);
  await writeFile(
    path.join(qa.runDir, `${label}.png`),
    Buffer.from(png, "base64"),
  );
}

async function prepare(qa, site, { takeover = false } = {}) {
  const applicationUrl = localUrl(
    qa,
    `/${site}/apply/3${site === "workday" ? "?stage=application" : ""}`,
  );
  await qa.page.waitForFunction(
    () =>
      typeof window.nestor?.jobFinder?.test?.loadAgentOwnedBrowserDemo ===
      "function",
  );
  await qa.page.evaluate(
    (input) => window.nestor.jobFinder.test.loadAgentOwnedBrowserDemo(input),
    {
      sourceUrl: localUrl(qa, `/${site}/`),
      applicationUrl,
      jobTitle: "Platform Engineer, Comet Systems",
      jobCompany: "Comet Teacup Labs",
    },
  );
  await qa.page.reload();
  await qa.page.evaluate(async () => {
    const state = await window.nestor.jobFinder.getWorkspace();
    await window.nestor.jobFinder.saveProfile({
      ...state.profile,
      firstName: "Alex",
      lastName: "Morgan",
      currentCity: "London",
      currentCountry: "United Kingdom",
      experiences: [
        {
          ...state.profile.experiences[0],
          id: "replica_role_one",
          title: "Platform Engineer",
          companyName: "Synthetic Comet Labs",
          startDate: "2021-04",
          endDate: "2025-09",
          isCurrent: false,
          isDraft: false,
          summary: "Built TypeScript workflow tools.",
          achievements: [],
        },
        {
          ...state.profile.experiences[0],
          id: "replica_role_two",
          title: "Software Engineer",
          companyName: "Synthetic Teacup Tools",
          startDate: "2018-06",
          endDate: "2021-03",
          isCurrent: false,
          isDraft: false,
          summary: "Maintained accessible interfaces.",
          achievements: [],
        },
      ],
      answerBank: {
        ...state.profile.answerBank,
        noticePeriod: "30 days",
        customAnswers: [
          {
            id: "replica_source",
            label: "Source",
            question: "How did you hear about this job?",
            answer: "Referral",
          },
          {
            id: "replica_address",
            label: "Address",
            question: "Address",
            answer: "42 Synthetic Road",
          },
          {
            id: "replica_postal",
            label: "Postal code",
            question: "Postal code",
            answer: "SW1A 1AA",
          },
          {
            id: "replica_authorized",
            kind: "work_authorization",
            label: "Authorization",
            question: "Are you legally authorized to work in this country?",
            answer: "Yes",
          },
          {
            id: "replica_sponsorship",
            kind: "visa_sponsorship",
            label: "Sponsorship",
            question: "Will you require sponsorship?",
            answer: "No",
          },
          {
            id: "replica_remote",
            label: "Remote",
            question: "Can you work remotely?",
            answer: "Yes",
          },
          {
            id: "replica_experience",
            label: "Experience",
            question: "Years of professional experience",
            answer: "5–9",
          },
          {
            id: "replica_motivation",
            label: "Motivation",
            question: "Why do you want to work here?",
            answer: "I enjoy building accessible TypeScript workflow tools.",
          },
        ],
      },
    });
  });
  if (site === "workday") {
    // Only this private replica accepts the synthetic account. Cookie stays in
    // the isolated Electron session and is never written to evidence.
    const account = new FormData();
    for (const [name, value] of Object.entries({
      email: "alex@example.test",
      password: "replica-only-password",
      verifyPassword: "replica-only-password",
      agree: "yes",
    }))
      account.set(name, value);
    const response = await fetch(localUrl(qa, "/workday/account/register/3"), {
      method: "POST",
      redirect: "manual",
      body: account,
    });
    assert.equal(response.status, 303);
    const cookie = response.headers
      .get("set-cookie")
      .match(/fixture_session=([^;]+)/u)[1];
    await qa.app.evaluate(
      async ({ session }, input) => {
        await session.fromPartition("persist:nestor-browser").cookies.set({
          url: input.url,
          name: "fixture_session",
          value: input.cookie,
          path: "/workday",
          httpOnly: true,
          sameSite: "lax",
        });
      },
      { url: qa.sites.url, cookie },
    );
  }
  await qa.page.evaluate(async () => {
    await window.nestor.jobFinder.generateResume("job_ready");
    const exported = await window.nestor.jobFinder.exportResumePdf(
      "job_ready",
      "approval",
    );
    const state = await window.nestor.jobFinder.getWorkspace();
    const artifact =
      exported?.artifact ??
      state.resumeExportArtifacts.find((entry) => entry.jobId === "job_ready");
    await window.nestor.jobFinder.approveResume("job_ready", artifact.id);
  });
  assert.equal(
    (await workspace(qa)).settings.applicationAutomationMode,
    "prepare_only",
  );
  await qa.page.evaluate(() => {
    void window.nestor.jobFinder.startApplyCopilotRun({
      jobId: "job_ready",
      visualCheckpointsEnabled: false,
    });
  });
  const deadline = Date.now() + 180_000;
  let state;
  let result;
  do {
    state = await workspace(qa);
    result = state.applyJobResults
      .filter((entry) => entry.jobId === "job_ready")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (
      result &&
      ["awaiting_review", "failed", "skipped", "submitted"].includes(
        result.state,
      )
    )
      break;
    await pause(500);
  } while (Date.now() < deadline);
  console.log(
    `RESULT ${JSON.stringify({ site, driver: state.browserSession?.driver, state: result?.state, blocker: result?.blocker, summary: result?.summary })}`,
  );
  await captureForm(qa, applicationUrl, `${site}-prepared`);
  assert.equal(state.browserSession.driver, "embedded_browser_agent");
  if (takeover)
    assert.equal(result?.summary, "You took over this application.");
  else assert.equal(result?.state, "awaiting_review", result?.summary);
  return { applicationUrl, result, state };
}

export async function replicaFlow(qa, site, { takeover = false } = {}) {
  const { applicationUrl, result, state } = await prepare(qa, site, {
    takeover,
  });
  if (site === "workday") {
    const form = await formContents(
      qa,
      applicationUrl,
      `JSON.stringify({ step: document.querySelector('[aria-current="step"]').textContent, fields: Object.fromEntries([...document.querySelectorAll('input,select,textarea')].filter(e => e.name && e.type !== 'file' && (e.type !== 'radio' || e.checked)).map(e => [e.name, e.type === 'checkbox' ? e.checked : e.value])) })`,
    );
    const { step, fields } = JSON.parse(form);
    if (!takeover) {
      assert.match(step, /Review/u);
      for (const [name, value] of Object.entries({
        source: "Referral",
        address: "42 Synthetic Road",
        postalCode: "SW1A 1AA",
        authorized: "Yes",
        sponsorship: "No",
        remote: "Yes",
        notice: "30 days",
        terms: true,
      }))
        assert.equal(fields[name], value, name);
      for (const [index, role] of state.profile.experiences.entries()) {
        for (const [suffix, value] of Object.entries({
          Title: role.title,
          Company: role.companyName,
          From: role.startDate,
          To: role.endDate,
          Description: role.summary,
        }))
          assert.equal(
            fields[`experience${index + 1}${suffix}`],
            value,
            `role ${index + 1} ${suffix}`,
          );
      }
      const record = state.applicationRecords.find(
        (entry) => entry.jobId === "job_ready",
      );
      await qa.page.evaluate(
        (input) => window.nestor.jobFinder.focusPreparedApplicationPage(input),
        {
          runId: result.runId,
          jobId: result.jobId,
          resultId: result.id,
          applicationRecordId: record.id,
        },
      );
    }
    // Simulate the person's edits through the actual retained form after the
    // product hands it over. No guard state is changed by the test.
    await formContents(
      qa,
      applicationUrl,
      `while (!document.querySelector('[aria-current="step"]').textContent.includes('My Information')) document.querySelector('fieldset[data-step]:not([hidden]) [data-back]').click(); const phone = document.querySelector('[name="phone"]'); phone.value = '+44 7700 900456'; phone.dispatchEvent(new Event('input', { bubbles: true })); phone.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-step="0"] [data-next]').click();`,
    );
    let personState;
    for (let i = 0; i < 40; i++) {
      personState = await formContents(
        qa,
        applicationUrl,
        `JSON.stringify({step: document.querySelector('[aria-current="step"]').textContent, phone: document.querySelector('[name="phone"]').value, status: document.querySelector('[role="status"]').textContent})`,
      );
      if (JSON.parse(personState).step.includes("My Experience")) break;
      await pause(100);
    }
    assert.match(JSON.parse(personState).step, /My Experience/u, personState);
    assert.equal(JSON.parse(personState).phone, "+44 7700 900456");
    await captureForm(qa, applicationUrl, "workday-person-continued");
  } else {
    const fields = JSON.parse(
      await formContents(
        qa,
        applicationUrl,
        `JSON.stringify(Object.fromEntries([...document.querySelectorAll('input,select,textarea')].filter(e => e.name && e.type !== 'file' && (e.type !== 'radio' || e.checked)).map(e => [e.name, e.value])))`,
      ),
    );
    assert.equal(fields.experience, "5–9");
    assert.equal(
      fields.motivation,
      "I enjoy building accessible TypeScript workflow tools.",
    );
    assert.equal(fields.authorized, "Yes");
    assert.equal(fields.sponsorship, "No");
  }
  const log = await readFile(qa.sites.log, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const posts = log.trim().split("\n").filter(Boolean).map(JSON.parse);
  console.log(`RECEIPTS ${qa.sites.log}\n${log}`);
  assert.ok(
    !posts.some((entry) =>
      /\/apply\/|\/api\/submit/u.test(entry.path ?? entry.url ?? ""),
    ),
    "Prepare-only run must never send",
  );
  if (site === "workday")
    assert.ok(
      posts.some(
        (entry) =>
          entry.path === "/workday/api/save" &&
          entry.fields.phone === "+44 7700 900456",
      ),
      "Person's save must reach the replica",
    );
  console.log(
    `PASS ${takeover ? "workday-takeover: active run handed over, person edit and Save and continue" : `${site}: retained embedded form, saved answers${site === "workday" ? ", two work-history rows, Review, person edit and Save and continue" : ", resume attached"}`}; no final submission`,
  );
}

// Existing Workday/complete-flow entry points opt into this local scenario
// with JOB_FINDER_LOCAL_REPLICA=1. This never contacts a live model or board.
export async function runReplicaHarness(scenario) {
  assert.ok(
    ["workday", "workday-takeover", "complete-flow", "prepare-values"].includes(
      scenario,
    ),
  );
  const model = await startReplicaModel();
  let qa;
  try {
    qa = await createAgentSession({ provider: "configured", env: model.env });
    console.log(
      `QA artifacts: ${qa.runDir}\nAI: deterministic scripted loopback model (configured transport), not a live provider`,
    );
    let takenOver = false;
    if (scenario === "workday-takeover")
      model.beforeAction(async (messages, action) => {
        const observation =
          messages.findLast((message) => message.content?.includes("Page:"))
            ?.content ?? "";
        if (
          takenOver ||
          action.name !== "click" ||
          !observation.includes("Step 1 of 4.")
        )
          return;
        takenOver = true;
        const url = localUrl(qa, "/workday/apply/3?stage=application");
        await qa.app.evaluate(({ webContents }, target) => {
          const contents = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL() === target);
          // Input through Electron, outside the agent's input ledger, exercises
          // the real takeover handler. The test never edits a guard flag.
          contents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
        }, url);
      });
    if (scenario === "prepare-values") await prepareValues(qa);
    else
      await replicaFlow(
        qa,
        scenario === "complete-flow" ? "greenhouse" : "workday",
        { takeover: scenario === "workday-takeover" },
      );
  } finally {
    if (qa)
      await writeFile(
        path.join(qa.runDir, "scripted-model-turns.json"),
        JSON.stringify(model.turns, null, 2),
      );
    await qa?.close();
    await model.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await runReplicaHarness(process.argv[2] ?? "workday");

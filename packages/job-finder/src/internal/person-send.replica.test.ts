import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import { createSendGuards, openJobStore } from "@nestor/db/job-store";
import { createApplyPageHands, runApplyAgent } from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "@nestor/browser-runtime";
import { PERSON_SEND_INSTRUCTION } from "../applications/application-service";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionRuntimeInput,
} from "./application-submission-runtime";

/**
 * The person's Send on a Fill in for me form whose send button belongs to no
 * form, like Soundsnap's careers-page "Apply now" (application 46): the run
 * the press starts lets the in-app model find and press that button on the
 * page as it is now, after nothing changed, a reload, or a closed tab.
 */

const profile = CandidateProfileSchema.parse({
  id: "synthetic",
  fullName: "Alex Synthetic",
  yearsExperience: 3,
  baseResume: {
    id: "resume",
    fileName: "synthetic-resume.txt",
    uploadedAt: "2026-11-06T10:00:00Z",
    textContent: "Synthetic local resume",
    textUpdatedAt: "2026-11-06T10:00:00Z",
    extractionStatus: "ready",
  },
});
const resume = new TextEncoder().encode("Synthetic local resume only.");
const reviewed = {
  name: "Alex Synthetic",
  email: "alex@example.test",
  phone: "+441234567890",
  coverLetter: "Synthetic local regression application.",
};

let server: ChildProcess;
let browser: Browser;
let base: string;
beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
    {
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: join(
          mkdtempSync(join(tmpdir(), "nestor-person-send-")),
          "posts.log",
        ),
      },
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    server.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    server.once("exit", () => reject(Error("Replica server exited")));
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.kill();
});

/** On every load the form's own submit gives way to a script button outside it. */
function scriptButtonOutsideTheForm(): void {
  document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector("form");
    if (!form) return;
    form
      .querySelector("button[type=submit],button:not([type])")
      ?.setAttribute("hidden", "");
    form.querySelector("button[hidden]")?.remove();
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Apply now";
    apply.addEventListener("click", () => form.requestSubmit());
    form.after(apply);
  });
}

async function fillAsReviewed(page: Page): Promise<void> {
  await page.locator("[name=name]").fill(reviewed.name);
  await page.locator("[name=email]").fill(reviewed.email);
  await page.locator("[name=phone]").fill(reviewed.phone);
  await page.locator("[name=coverLetter]").fill(reviewed.coverLetter);
  await page.locator("[name=certify]").check();
  await page.locator("input[type=file]").setInputFiles({
    name: "synthetic-resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(resume),
  });
}

function runtimeInput(
  page: Page,
  repository: ReturnType<typeof createSendGuards>,
  overrides: Partial<ApplicationSubmissionRuntimeInput>,
): ApplicationSubmissionRuntimeInput {
  return {
    repository,
    source: "target_site",
    savedMode: "autonomous_submit",
    authorityEnvelopeId: "application_1",
    authorityRevision: 1,
    preflightId: "preflight_person",
    idempotencyKey: "submission_person",
    lineage: {
      runId: "application_run_1",
      jobId: "1",
      resultId: "application_1_attempt_2",
      applicationRecordId: "application_1",
      campaignId: null,
    },
    resumeBytes: resume,
    answers: { revision: 1, digest: "0".repeat(64) },
    capacity: { remainingRunCapacity: 1 },
    currentPolicyFacts: {
      policy: null,
      answers: { revision: 1, digest: "0".repeat(64) },
      mandatoryStops: [],
    },
    now: new Date().toISOString(),
    browserRuntime: {
      observeApplicationForm: (_source, options) =>
        observeApplicationForm(page, options),
      executeExactlyOneFinalAction: (_source, input) =>
        executeExactlyOneFinalAction(page, input),
    },
    ...overrides,
  };
}

test.each(["unchanged", "reloaded", "closed"] as const)(
  "the person's Send on a Ready Fill in for me form sends once when the page is %s",
  async (change) => {
    const context = await browser.newContext();
    await context.addInitScript(scriptButtonOutsideTheForm);
    let page = await context.newPage();
    const store = openJobStore(":memory:");
    const repository = createSendGuards(store);
    let accepted = 0;
    context.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        response.status() === 200 &&
        response.url().includes("/employer-a/apply/")
      )
        accepted++;
    });
    const url = `${base}/employer-a/apply/1`;
    try {
      // What the Fill in for me run left Ready for the person.
      await page.goto(url);
      await fillAsReviewed(page);

      // The cause: a Send that only reads the page without the model finds
      // no control, because this send button belongs to no form.
      expect((await observeApplicationForm(page)).controls).toEqual([]);
      const before = await runApplicationSubmissionRuntime(
        runtimeInput(page, repository, {}),
      );
      expect(before).toMatchObject({
        status: "blocked",
        detail: "That control is stale or missing; observe again.",
      });

      if (change === "reloaded") await page.reload();
      if (change === "closed") {
        await page.close();
        page = await context.newPage();
        await page.goto(url);
      }
      const formPage = page;

      // The run the person's Send starts: Send for me on this page, told to
      // send what they reviewed, with the earlier answers as its facts.
      const hands = createApplyPageHands(
        createPlaywrightApplyPageMechanics(formPage),
      );
      const sent: ApplicationSubmissionRuntimeInput[] = [];
      const prompts: string[] = [];
      let turn = 0;
      const result = await runApplyAgent(
        {
          hands,
          authority: {
            mode: "autonomous_submit",
            submitAuthorized: false,
            allowedOrigins: [],
            preApprovedAttestationKinds: ["truthfulness_certification"],
            salaryDisclosure: "answer_from_profile",
          },
          application: {
            jobId: "1",
            applicationId: "application_1",
            startingUrl: formPage.url(),
            instructions: [PERSON_SEND_INSTRUCTION],
          },
          replay: {
            answers: [
              ["Name", reviewed.name],
              ["Email", reviewed.email],
              ["Phone", reviewed.phone],
              ["Cover letter", reviewed.coverLetter],
              ["I certify the information is true", "Yes"],
            ].map(([question, answer]) => ({
              question: question!,
              answer: answer!,
              source: "Profile",
              written: false,
              groundedIn: [],
            })),
            attachments: [
              {
                field: "Resume / CV",
                fileName: "synthetic-resume.txt",
                label: "Resume",
              },
            ],
            path: [],
            formUrl: url,
          },
          siteLabel: "local replica",
          sources: {
            profile,
            resumeText: "Synthetic local resume",
            posting: {
              title: "Engineer",
              company: "Replica",
              location: "Remote",
              description: "Local regression",
            },
            reusableAnswers: [],
            documents: [
              {
                id: "resume",
                label: "Resume",
                fileName: "synthetic-resume.txt",
                mimeType: "text/plain",
                kind: "resume",
                loadBytes: () => Promise.resolve(resume),
              },
            ],
          },
          submitApplication: async (decision) => {
            const input = runtimeInput(formPage, repository, {
              idempotencyKey: `model_send_application_1_${decision.callId!}`,
              preflightId: `intent_application_1_${decision.callId!}`,
              finalAction: decision,
            });
            sent.push(input);
            const receipt = await runApplicationSubmissionRuntime(input);
            expect(receipt.status).toBe("outcome_uncertain");
            return {
              sendCallId: input.idempotencyKey,
              outcome: "outcome_uncertain",
              content: "Pressed once; inspect the page and record the outcome.",
            };
          },
          recordSendOutcome: () =>
            Promise.resolve({ recorded: true, content: "Recorded." }),
        },
        {
          chatWithTools: async (messages) => {
            prompts.push(JSON.stringify(messages));
            const observation = await hands.observe();
            const ref = (label: string) =>
              observation.controls.find((control) => control.label === label)!
                .ref;
            const call = (name: string, args: object) => ({
              toolCalls: [
                {
                  id: `person-send-${++turn}`,
                  type: "function" as const,
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            });
            if (/received/iu.test(observation.bodyTextExcerpt ?? ""))
              return turn > 0 && !sent.length
                ? call("finish", { reason: "Unexpected receipt" })
                : call("finish", {
                    reason: "The replica received the application.",
                    sendOutcome: {
                      outcome: "confirmed",
                      evidence: "Your application has been received",
                    },
                  });
            // The page lost what the person reviewed: restore it first.
            if (!(await formPage.locator("[name=name]").inputValue()))
              return call("fill_fields", {
                fields: [
                  { tool: "type", ref: ref("Name *"), text: reviewed.name },
                  { tool: "type", ref: ref("Email *"), text: reviewed.email },
                  { tool: "type", ref: ref("Phone *"), text: reviewed.phone },
                  {
                    tool: "type",
                    ref: ref("Cover letter"),
                    text: reviewed.coverLetter,
                  },
                  {
                    tool: "set_checkbox",
                    ref: ref("I certify the information is true"),
                    checked: true,
                  },
                  {
                    tool: "upload",
                    ref: ref("Resume / CV"),
                    documentId: "resume",
                  },
                ],
              });
            const apply = [
              ...observation.actions,
              ...observation.clickables,
            ].find((action) => action.label === "Apply now")!;
            return call("submit_application", { ref: apply.ref });
          },
        },
      );

      expect(prompts[0]).toContain("pressed Send");
      expect(prompts[0]).toContain(reviewed.coverLetter);
      expect(result.outcome).not.toBe("stuck");
      expect(sent).toHaveLength(1);
      expect(accepted).toBe(1);
      expect(await repository.listSubmissionArmedMarkers()).toHaveLength(1);
      expect(await formPage.locator("body").innerText()).toMatch(/received/iu);

      // The same send call again never presses the button a second time.
      expect((await runApplicationSubmissionRuntime(sent[0]!)).status).not.toBe(
        "blocked",
      );
      expect(accepted).toBe(1);
      expect(await repository.listSubmissionArmedMarkers()).toHaveLength(1);
    } finally {
      await context.close();
      store.close();
    }
  },
  60_000,
);

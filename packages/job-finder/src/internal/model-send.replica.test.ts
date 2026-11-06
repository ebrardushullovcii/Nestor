import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  SubmissionOutcomeRecordSchema,
  CandidateProfileSchema,
} from "@nestor/contracts";
import { createSendGuards, openJobStore } from "@nestor/db/job-store";
import { createApplyPageHands, runApplyAgent } from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "@nestor/browser-runtime";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionRuntimeInput,
} from "./application-submission-runtime";

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
          mkdtempSync(join(tmpdir(), "nestor-send-replica-")),
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
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test.each([false, true])(
  "a model Send is accepted once by the replica and recorded before/after the click (trace %s)",
  async (trace) => {
    vi.stubEnv(
      "NESTOR_RUN_TRACE_DIR",
      trace ? mkdtempSync(join(tmpdir(), "nestor-send-trace-")) : "",
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = openJobStore(":memory:");
    const repository = createSendGuards(store);
    try {
      await page.goto(`${base}/employer-a/apply/1`);
      await page.locator("[name=name]").fill("Alex Synthetic");
      await page.locator("[name=email]").fill("alex@example.test");
      await page.locator("[name=phone]").fill("+441234567890");
      await page
        .locator("[name=coverLetter]")
        .fill("Synthetic local regression application.");
      await page.locator("[name=certify]").check();
      const resume = new TextEncoder().encode("Synthetic local resume only.");
      await page.locator("input[type=file]").setInputFiles({
        name: "synthetic-resume.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(resume),
      });
      let accepted = 0;
      page.on("response", (response) => {
        if (
          response.request().method() === "POST" &&
          response.status() === 200 &&
          response.url().includes("/employer-a/apply/")
        )
          accepted++;
      });
      const mechanics = createPlaywrightApplyPageMechanics(page);
      const hands = createApplyPageHands(mechanics);
      const observation = await hands.observe();
      const action = observation.actions.find(
        (action) => action.kind === "final",
      )!;
      let input: ApplicationSubmissionRuntimeInput | null = null;
      const submit = vi.fn(
        async (decision: {
          actionRef: string;
          actionLabel: string;
          callId?: string;
        }) => {
          input = {
            repository,
            source: "target_site",
            savedMode: "autonomous_submit",
            authorityEnvelopeId: "instruction",
            authorityRevision: 1,
            preflightId: `intent_${decision.callId!}`,
            idempotencyKey: decision.callId!,
            lineage: {
              runId: "run",
              jobId: "job",
              resultId: "result",
              applicationRecordId: "application",
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
            finalAction: decision,
            browserRuntime: {
              observeApplicationForm: (_source, options) =>
                observeApplicationForm(page, options),
              executeExactlyOneFinalAction: async (_source, actionInput) => {
                expect(
                  await repository.listSubmissionArmedMarkers(),
                ).toHaveLength(1);
                expect(
                  await repository.listSubmissionOutcomeRecords(),
                ).toHaveLength(0);
                return executeExactlyOneFinalAction(page, actionInput);
              },
            },
          };
          const sent = await runApplicationSubmissionRuntime(input);
          expect(sent.status).toBe("outcome_uncertain");
          return {
            outcome: "outcome_uncertain" as const,
            content: `Send ledger: sendCallId=${decision.callId!}; requests=${JSON.stringify("outcome" in sent ? sent.outcome?.browserAction?.requestsAfterClick : [])}. Inspect the page and record your observed outcome.`,
          };
        },
      );
      let turn = 0;
      const result = await runApplyAgent(
        {
          hands,
          submitApplication: submit,
          recordSendOutcome: async (decision) => {
            const key = await repository.getSubmissionIdempotencyRecord(
              decision.sendCallId,
            );
            const previous = await repository.getSubmissionOutcomeRecord(
              key!.outcomeId!,
            );
            const at = new Date().toISOString();
            const receipt = SubmissionOutcomeRecordSchema.parse({
              ...previous,
              id: `${previous!.id}_model`,
              outcome: "submitted",
              verifiedAt: at,
              evidence: [
                {
                  id: "model_evidence",
                  kind: "employer_site_state",
                  observedAt: at,
                  destination: {
                    origin: new URL(page.url()).origin,
                    safePath: new URL(page.url()).pathname,
                  },
                  artifactRefId: null,
                  summary: decision.evidence,
                },
              ],
              retry: { eligible: false, blockReason: "submission_confirmed" },
            });
            const recorded = await repository.resolveSubmissionOutcome({
              expectedOutcomeId: previous!.id,
              expectedIdempotencyRevision: key!.revision,
              outcome: receipt,
            });
            expect(recorded.status).toBe("recorded");
            return {
              recorded: true,
              content: "Recorded model-confirmed outcome.",
            };
          },
          authority: {
            mode: "autonomous_submit",
            submitAuthorized: true,
            allowedOrigins: [],
            preApprovedAttestationKinds: [],
            salaryDisclosure: "answer_from_profile",
          },
          application: {
            jobId: "job",
            applicationId: "application",
            startingUrl: page.url(),
          },
          siteLabel: "local replica",
          sources: {
            profile: profile,
            resumeText: null,
            posting: {
              title: "Engineer",
              company: "Replica",
              location: "Remote",
              description: "Local regression",
            },
            reusableAnswers: [],
            documents: [],
          },
        },
        {
          chatWithTools: () => {
            const decision =
              ++turn === 1
                ? { name: "submit_application", args: { ref: action.ref } }
                : turn === 2
                  ? {
                      name: "record_send_outcome",
                      args: {
                        sendCallId: "provider-send-1",
                        outcome: "confirmed",
                        evidence: "Your application has been received",
                      },
                    }
                  : {
                      name: "finish",
                      args: { reason: "The replica received the application." },
                    };
            return Promise.resolve({
              toolCalls: [
                {
                  id: turn === 1 ? "provider-send-1" : `provider-${turn}`,
                  type: "function" as const,
                  function: {
                    name: decision.name,
                    arguments: JSON.stringify(decision.args),
                  },
                },
              ],
            });
          },
        },
      );
      expect(result.outcome).toBe("submitted");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(accepted).toBe(1);
      expect(await repository.listSubmissionOutcomeRecords()).toEqual([
        expect.objectContaining({ outcome: "outcome_uncertain" }),
        expect.objectContaining({ outcome: "submitted" }),
      ]);
      expect(await page.locator("body").innerText()).toContain(
        "Your application has been received",
      );
      // Reconnect/retry with the same call uses the recorded outcome even after
      // replacing the browser adapter with one that cannot observe or click.
      const replay = {
        ...input!,
        browserRuntime: {
          observeApplicationForm: () =>
            Promise.reject(Error("No replay observation")),
          executeExactlyOneFinalAction: () =>
            Promise.reject(Error("No replay click")),
        },
      };
      expect((await runApplicationSubmissionRuntime(replay)).status).toBe(
        "submitted",
      );
      expect(accepted).toBe(1);
    } finally {
      await context.close();
      store.close();
    }
  },
  30_000,
);

test.each(["prepare_only", "confirm_before_submit"] as const)(
  "the replica receives no application during %s",
  async (mode) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/employer-a/apply/1`);
      let sends = 0;
      page.on("request", (request) => {
        if (request.method() === "POST") sends++;
      });
      const hands = createApplyPageHands(
        createPlaywrightApplyPageMechanics(page),
      );
      let turn = 0;
      const submit = vi.fn(() => Promise.reject(Error("Fill must not send")));
      await runApplyAgent(
        {
          hands,
          submitApplication: submit,
          authority: {
            mode,
            submitAuthorized: false,
            allowedOrigins: [],
            preApprovedAttestationKinds: [],
            salaryDisclosure: "answer_from_profile",
          },
          application: {
            jobId: "job",
            applicationId: "application",
            startingUrl: page.url(),
          },
          siteLabel: "local replica",
          sources: {
            profile: profile,
            resumeText: null,
            posting: {
              title: "Engineer",
              company: "Replica",
              location: "Remote",
              description: "Local regression",
            },
            reusableAnswers: [],
            documents: [],
          },
        },
        {
          chatWithTools: () => {
            turn++;
            return Promise.resolve({
              toolCalls: [
                {
                  id: `fill-${turn}`,
                  type: "function",
                  function: {
                    name: "finish",
                    arguments: JSON.stringify({
                      reason:
                        "The person chose Fill in for me; leave this Ready without sending.",
                    }),
                  },
                },
              ],
            });
          },
        },
      );
      expect(submit).not.toHaveBeenCalled();
      expect(sends).toBe(0);
    } finally {
      await context.close();
    }
  },
  30_000,
);

test("the model receives every long-page item and child frame on its first turn", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/employer-a/apply/1`);
    const content = Array.from(
      { length: 300 },
      (_, i) => `Page item ${i}: ${"complete evidence ".repeat(30)}`,
    ).join("\n");
    await page.evaluate((text) => {
      document.body.replaceChildren();
      const main = document.createElement("main");
      main.textContent = text;
      document.body.append(main);
      for (let i = 0; i < 20; i++) {
        const frame = document.createElement("iframe");
        frame.srcdoc = `<p>Child frame ${i}: last-frame-evidence-${i}</p>`;
        document.body.append(frame);
      }
    }, content);
    await expect.poll(() => page.frames().length).toBe(21);
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    let read = "";
    await runApplyAgent(
      {
        hands,
        authority: {
          mode: "confirm_before_submit",
          submitAuthorized: false,
          allowedOrigins: [],
          preApprovedAttestationKinds: [],
          salaryDisclosure: "answer_from_profile",
        },
        application: {
          jobId: "job",
          applicationId: "application",
          startingUrl: page.url(),
        },
        siteLabel: "local replica",
        sources: {
          profile,
          resumeText: null,
          posting: {
            title: "Engineer",
            company: "Replica",
            location: "Remote",
            description: "Local regression",
          },
          reusableAnswers: [],
          documents: [],
        },
      },
      {
        chatWithTools: (messages) => {
          read = messages.map((message) => message.content).join("\n");
          return Promise.resolve({
            toolCalls: [
              {
                id: "finish-long-page",
                type: "function",
                function: {
                  name: "finish",
                  arguments: JSON.stringify({
                    reason: "Read complete local evidence.",
                  }),
                },
              },
            ],
          });
        },
      },
    );
    for (const line of content.split("\n")) expect(read).toContain(line.trim());
    for (let i = 0; i < 20; i++)
      expect(read).toContain(`last-frame-evidence-${i}`);
  } finally {
    await context.close();
  }
}, 30_000);

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  SubmissionOutcomeRecordSchema,
} from "@nestor/contracts";
import { createSendGuards, openJobStore } from "@nestor/db/job-store";
import { createSavedAnswersStore } from "@nestor/db/applications";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  observeApplicationForm,
  executeExactlyOneFinalAction,
} from "@nestor/browser-runtime";
import { traceEvent, withTraceScope } from "@nestor/core/run-trace";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionRuntimeInput,
} from "./application-submission-runtime";

let server: ChildProcess, browser: Browser, base: string;
beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve("apps/desktop/test-fixtures/job-sites/serve.mjs")],
    {
      windowsHide: true,
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: join(
          mkdtempSync(join(tmpdir(), "email-replica-")),
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
    server.once("error", reject);
    server.once("exit", () => reject(Error("Replica exited")));
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  server?.kill();
  await browser?.close();
}, 30_000);

test.each([
  "autonomous_submit",
  "prepare_only",
  "confirm_before_submit",
] as const)(
  "%s keeps its form and records one code-completed send or no Fill send, without retaining codes",
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "email-verification-trace-"));
    vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
    const context = await browser.newContext();
    const page = await context.newPage();
    const unrelated = await context.newPage();
    const store = openJobStore(":memory:");
    const repository = createSendGuards(store);
    const id = randomUUID();
    const url = (step: string) => `${base}/verification-replica/${step}/${id}`;
    let code = "",
      turn = 0,
      input: ApplicationSubmissionRuntimeInput | undefined;
    try {
      await page.goto(url("apply"));
      await context.addCookies([
        {
          name: "replica-google-account",
          value: "synthetic-session",
          domain: "mail.google.com",
          path: "/",
          secure: true,
        },
      ]);
      // Every Gmail request is a local inbox replica with this same session.
      await context.route("https://mail.google.com/**", async (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: await (await context.request.get(url("inbox"))).text(),
        }),
      );
      const mechanics = createPlaywrightApplyPageMechanics(page);
      const hands = createApplyPageHands(mechanics);
      const submit = vi.fn<NonNullable<ApplyAgentConfig["submitApplication"]>>(
        async (decision) => {
          input = {
            repository,
            source: "target_site",
            savedMode: "autonomous_submit",
            authorityEnvelopeId: "instruction",
            authorityRevision: 1,
            preflightId: "original-send",
            idempotencyKey: decision.callId!,
            lineage: {
              runId: "run",
              jobId: "job",
              resultId: "result",
              applicationRecordId: "application",
              campaignId: null,
            },
            resumeBytes: new TextEncoder().encode("Synthetic local resume."),
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
              executeExactlyOneFinalAction: async (_source, action) => {
                expect(
                  await repository.listSubmissionArmedMarkers(),
                ).toHaveLength(1);
                return executeExactlyOneFinalAction(page, action);
              },
            },
          };
          const sent = await runApplicationSubmissionRuntime(input);
          expect(sent.status).toBe("outcome_uncertain");
          return {
            outcome: "outcome_uncertain",
            sendCallId: decision.callId!,
            content: `sendCallId=${decision.callId}; inspect the open email verification step.`,
          };
        },
      );
      const reports: string[] = [];
      const config: ApplyAgentConfig = {
        hands,
        authority: {
          mode,
          submitAuthorized: mode === "autonomous_submit",
          allowedOrigins: [],
          preApprovedAttestationKinds: ["terms_acceptance"],
          salaryDisclosure: "answer_from_profile",
        },
        application: {
          jobId: "job",
          applicationId: "application",
          startingUrl: url("apply"),
        },
        siteLabel: "Local email replica",
        sources: {
          profile: CandidateProfileSchema.parse({
            id: "synthetic",
            fullName: "Alex Synthetic",
            yearsExperience: 3,
            baseResume: {
              id: "resume",
              fileName: "synthetic.txt",
              uploadedAt: "2026-11-07T00:00:00Z",
              textUpdatedAt: "2026-11-07T00:00:00Z",
              textContent: "Synthetic local resume.",
              extractionStatus: "ready",
            },
          }),
          resumeText: null,
          reusableAnswers: [],
          documents: [],
          posting: {
            title: "Engineer",
            company: "Synthetic",
            location: "Remote",
            description: "Local replica",
          },
        },
        submitApplication: submit,
        recordSendOutcome: async (decision) => {
          reports.push(decision.outcome);
          expect(decision.sendCallId).toBe("send-call");
          const key = await repository.getSubmissionIdempotencyRecord(
            decision.sendCallId,
          );
          const previous = await repository.getSubmissionOutcomeRecord(
            key!.outcomeId!,
          );
          const at = new Date().toISOString();
          const waiting = decision.outcome === "waiting";
          const receipt = SubmissionOutcomeRecordSchema.parse({
            ...previous,
            id: `model-${reports.length}`,
            outcome: waiting ? "outcome_uncertain" : "submitted",
            verifiedAt: waiting ? null : at,
            evidence: [
              {
                id: `evidence-${reports.length}`,
                kind: "employer_site_state",
                observedAt: at,
                destination: {
                  origin: base,
                  safePath: `/verification-replica/${waiting ? "send" : "verify"}/${id}`,
                },
                artifactRefId: null,
                summary: decision.evidence,
              },
            ],
            retry: {
              eligible: false,
              blockReason: waiting
                ? "outcome_uncertain"
                : "submission_confirmed",
            },
            browserAction: {
              ...previous!.browserAction,
              reason: waiting
                ? "awaiting_email_verification"
                : "model_observed_outcome",
            },
          });
          expect(
            (
              await repository.resolveSubmissionOutcome({
                expectedOutcomeId: previous!.id,
                expectedIdempotencyRevision: key!.revision,
                outcome: receipt,
              })
            ).status,
          ).toBe("recorded");
          if (waiting) {
            expect(
              await page.locator('[autocomplete="one-time-code"]').count(),
            ).toBe(1);
            const waitingStats: unknown = await context.request
              .get(url("stats"))
              .then((r) => r.json());
            expect(waitingStats).toMatchObject({ accepted: 0 });
          }
          return {
            recorded: true,
            content: `Recorded ${decision.outcome}; the original send is consumed.`,
          };
        },
      };
      const result = await withTraceScope(
        { applicationKey: "application_1_attempt_1" },
        () =>
          runApplyAgent(config, {
            chatWithTools: async (messages) => {
              turn++;
              if (turn === 1) {
                expect(JSON.stringify(messages)).toContain(
                  "synthetic@example.test",
                );
                expect(JSON.stringify(messages)).toContain(
                  "are signed in in this browser",
                );
              }
              const observed = await hands.observe();
              const ref = (label: string) =>
                [...observed.controls, ...observed.actions].find((entry) =>
                  entry.label.includes(label),
                )!.ref;
              let name: string, args: Record<string, unknown>;
              if (turn === 1) {
                name = "fill_fields";
                args = {
                  fields: [
                    { tool: "type", ref: ref("Name"), text: "Alex Synthetic" },
                    {
                      tool: "set_checkbox",
                      ref: ref("arbitration"),
                      checked: true,
                    },
                  ],
                };
              } else if (mode !== "autonomous_submit") {
                name = "finish";
                args = { reason: "The form is filled; the person sends it." };
              } else if (turn === 2) {
                name = "submit_application";
                args = { ref: ref("Send application") };
              } else if (turn === 3) {
                name = "record_send_outcome";
                args = {
                  sendCallId: "send-call",
                  outcome: "waiting",
                  evidence:
                    "The employer asks for the emailed verification step.",
                };
              } else if (turn === 4) {
                name = "open_tab";
                args = { url: "https://mail.google.com/mail/u/0/#inbox" };
              } else if (turn === 5) {
                name = "read_text";
                args = {};
              } else if (turn === 6) {
                code =
                  /verification code is\s+([a-f0-9]+)/u.exec(
                    messages.filter((message) => message.role === "tool").at(-1)
                      ?.content ?? "",
                  )?.[1] ?? "";
                expect(code.length > 0).toBe(true);
                expect(
                  await page.locator('[autocomplete="one-time-code"]').count(),
                ).toBe(1);
                name = "switch_tab";
                args = { tabId: "form" };
              } else if (turn === 7) {
                name = "fill_fields";
                args = {
                  fields: [
                    { tool: "type", ref: ref("Verification code"), text: code },
                  ],
                };
              } else if (turn === 8) {
                name = "click";
                args = { ref: ref("Verify email") };
              } else if (turn === 9) {
                name = "record_send_outcome";
                args = {
                  sendCallId: "send-call",
                  outcome: "confirmed",
                  evidence: "Your application has been received.",
                };
              } else if (turn === 10) {
                name = "close_tab";
                args = { tabId: "tab1" };
              } else {
                name = "finish";
                args = { reason: "The employer confirmed the application." };
              }
              const response = {
                toolCalls: [
                  {
                    id: turn === 2 ? "send-call" : `call-${turn}`,
                    type: "function" as const,
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              };
              traceEvent("provider_response_raw", { response });
              return response;
            },
          }),
      );
      const stats: unknown = await context.request
        .get(url("stats"))
        .then((r) => r.json());
      expect(stats).toEqual(
        mode === "autonomous_submit"
          ? { sends: 1, verifications: 1, accepted: 1 }
          : { sends: 0, verifications: 0, accepted: 0 },
      );
      expect(submit).toHaveBeenCalledTimes(
        mode === "autonomous_submit" ? 1 : 0,
      );
      expect(reports).toEqual(
        mode === "autonomous_submit" ? ["waiting", "confirmed"] : [],
      );
      expect(page.isClosed()).toBe(false);
      expect(unrelated.isClosed()).toBe(false);
      expect(context.pages()).toHaveLength(2);
      if (mode === "autonomous_submit") {
        expect(result.outcome).toBe("submitted");
        expect(JSON.stringify(result).includes(code)).toBe(false);
        expect(createSavedAnswersStore(store).list().rows).toEqual([]);
        expect(await repository.listSubmissionArmedMarkers()).toHaveLength(1);
        const replay = await runApplicationSubmissionRuntime({
          ...input!,
          browserRuntime: {
            observeApplicationForm: () =>
              Promise.reject(Error("No replay read")),
            executeExactlyOneFinalAction: () =>
              Promise.reject(Error("No replay send")),
          },
        });
        expect(replay.status).toBe("submitted");
        const traceFile = readdirSync(dir).find((file) =>
          file.endsWith(".jsonl"),
        )!;
        expect(readFileSync(join(dir, traceFile), "utf8").includes(code)).toBe(
          false,
        );
        const pack = join(dir, "pack");
        execFileSync(
          process.execPath,
          [
            resolve("packages/ai-evals/scripts/isolated-app/pack.mjs"),
            "--trace",
            dir,
            "--out",
            pack,
            "--application",
            "1",
            "--application-key",
            "application_1_attempt_1",
          ],
          { stdio: "pipe" },
        );
        for (const file of readdirSync(pack, { recursive: true }))
          if (
            typeof file === "string" &&
            /\.(?:json|jsonl|md|log)$/u.test(file)
          )
            expect(readFileSync(join(pack, file), "utf8").includes(code)).toBe(
              false,
            );
      }
    } finally {
      await context.close();
      store.close();
    }
  },
  60_000,
);

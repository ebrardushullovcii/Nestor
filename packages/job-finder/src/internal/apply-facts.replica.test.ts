import { chromium, type Browser } from "playwright";
import { beforeAll, afterAll, expect, test } from "vitest";
import {
  CandidateProfileSchema,
  SubmissionOutcomeRecordSchema,
} from "@nestor/contracts";
import { createApplyPageHands, runApplyAgent } from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "@nestor/browser-runtime";
import {
  createSendGuards,
  openJobStore,
  approveOriginalResumesForTests,
} from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionRuntimeInput,
} from "./application-submission-runtime";
import {
  startApplyFactsReplica,
  refusalText,
} from "../../../../apps/desktop/test-fixtures/job-finder/apply-facts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test.each([
  "autonomous_submit",
  "prepare_only",
  "confirm_before_submit",
] as const)(
  "%s gives the model the refused form body and keeps sends ledgered",
  async (mode) => {
    const replica = await startApplyFactsReplica(200);
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = openJobStore(":memory:");
    const repository = createSendGuards(store);
    const applications = createApplicationStore(store);
    const ids = store.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: "Engineer",
          company: "Replica",
          location: "Remote",
          workModes: ["remote"],
          url: replica.url,
          applyUrl: replica.url,
          sourceId: "replica",
          sourceLabel: "Replica",
          sourceJobId: "job",
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: "Synthetic listing",
        },
      ],
    }).added;
    approveOriginalResumesForTests(store, ids);
    applications.applyJobs({ selection: { ids } }, "autonomous_submit");
    let application = applications.claimNext()!;
    const resume = new TextEncoder().encode("Synthetic resume bytes");
    const inputs: ApplicationSubmissionRuntimeInput[] = [];
    const controller = new AbortController();
    let modelFailure: unknown;
    try {
      await page.goto(replica.url);
      const hands = createApplyPageHands(
        createPlaywrightApplyPageMechanics(page),
      );
      let turn = 0;
      const result = await runApplyAgent(
        {
          hands,
          signal: controller.signal,
          recordSendOutcome: () =>
            Promise.resolve({
              recorded: true,
              content: "Recorded model observation",
            }),
          authority: {
            mode,
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
          siteLabel: "Synthetic form",
          sources: {
            profile: CandidateProfileSchema.parse({
              id: "synthetic",
              fullName: "Alex Synthetic",
              yearsExperience: 3,
              baseResume: {
                id: "resume",
                fileName: "synthetic.txt",
                uploadedAt: "2026-11-07T00:00:00Z",
              },
            }),
            resumeText: "Synthetic resume bytes",
            posting: {
              title: "Engineer",
              company: "Replica",
              location: "Remote",
              description: "Synthetic",
            },
            reusableAnswers: [],
            documents: [
              {
                id: "resume",
                label: "Resume",
                fileName: "synthetic.txt",
                mimeType: "text/plain",
                kind: "resume",
                loadBytes: () => Promise.resolve(resume),
              },
            ],
          },
          submitApplication: async (decision) => {
            if (inputs.length) {
              // The same store command used by the visible Apply again action.
              expect(applications.getApplication(application.id)?.state).toBe(
                "failed",
              );
              expect(
                applications.retryPreparation(
                  application.id,
                  application.attempt,
                ),
              ).toBe(true);
              application = applications.claimNext()!;
              expect(application.attempt).toBe(2);
            }
            expect(
              applications.beginSubmission(application.id, application.attempt),
            ).toBe(true);
            const response = page.waitForResponse(
              (response) => response.request().method() === "POST",
            );
            const input: ApplicationSubmissionRuntimeInput = {
              repository,
              source: "target_site",
              savedMode: "autonomous_submit",
              authorityEnvelopeId: "permission",
              authorityRevision: 1,
              preflightId: `intent_${decision.callId}`,
              idempotencyKey: decision.callId!,
              lineage: {
                runId: `application_run_${application.id}`,
                jobId: String(application.jobId),
                resultId: `application_${application.id}_attempt_${application.attempt}`,
                applicationRecordId: `application_${application.id}`,
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
                executeExactlyOneFinalAction: (_source, input) =>
                  executeExactlyOneFinalAction(page, input),
              },
            };
            inputs.push(input);
            const sent = await runApplicationSubmissionRuntime(input);
            await response;
            if (inputs.length === 2)
              await page
                .getByText("Application received", { exact: true })
                .waitFor();
            expect(sent.status).toBe("outcome_uncertain");
            const receipt = "outcome" in sent ? sent.outcome : null;
            if (inputs.length === 1 && receipt) {
              const key = await repository.getSubmissionIdempotencyRecord(
                decision.callId!,
              );
              const failed = SubmissionOutcomeRecordSchema.parse({
                ...receipt,
                browserAction: {
                  ...receipt.browserAction,
                  reason: "model_observed_outcome",
                },
                id: `${receipt.id}_failed`,
                outcome: "not_submitted",
                verifiedAt: new Date().toISOString(),
                evidence: [
                  {
                    id: "refusal",
                    kind: "employer_site_state",
                    observedAt: new Date().toISOString(),
                    destination: { origin: replica.url, safePath: "/" },
                    artifactRefId: null,
                    summary: "HTTP 422; correct the phone field",
                  },
                ],
                retry: { eligible: false, blockReason: "policy_decision" },
              });
              expect(
                (
                  await repository.resolveSubmissionOutcome({
                    expectedOutcomeId: receipt.id,
                    expectedIdempotencyRevision: key!.revision,
                    outcome: failed,
                  })
                ).status,
              ).toBe("recorded");
              expect(
                applications.recordSubmission(
                  application.id,
                  application.attempt,
                  failed,
                ),
              ).toBe(true);
            }
            return {
              sendCallId: decision.callId!,
              outcome: "outcome_uncertain",
              content: `Send ledger: ${JSON.stringify(receipt?.browserAction)}`,
            };
          },
        },
        {
          chatWithTools: async (messages) => {
            try {
              const observation = await hands.observe();
              const field = (label: string) =>
                observation.controls.find((control) => control.label === label)!
                  .ref;
              const send = observation.actions.find(
                (action) => action.label === "Send application",
              )!.ref;
              const last =
                [...messages]
                  .reverse()
                  .find((message) => message.role === "tool")?.content ?? "";
              const call = (name: string, args: object) => ({
                toolCalls: [
                  {
                    id: `decision_${++turn}`,
                    type: "function" as const,
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              });
              if (turn === 0)
                return call("fill_fields", {
                  fields: [
                    {
                      tool: "type",
                      ref: field("Name"),
                      text: "Alex Synthetic",
                    },
                    { tool: "type", ref: field("Phone"), text: "2025550123" },
                    {
                      tool: "upload",
                      ref: field("Resume"),
                      documentId: "resume",
                    },
                  ],
                });
              if (turn === 1) {
                expect(last.match(/Page:/g)).toHaveLength(1);
                expect(last).toContain('Name now holds "Alex Synthetic"');
                expect(last).toContain("synthetic.txt");
                expect(replica.state).toEqual({ posts: 0, accepted: 0 });
                return mode === "autonomous_submit"
                  ? call("submit_application", { ref: send })
                  : call("finish", { reason: "Filled for the person" });
              }
              if (turn === 2) {
                expect(last).toContain("422");
                expect(last).toContain(
                  "Include the international calling code",
                );
                expect(last).not.toContain('network: "rejected"');
                const raw =
                  await createPlaywrightApplyPageMechanics(page).readPage();
                expect(
                  raw.uploads?.some((upload) => upload.network === "rejected"),
                ).not.toBe(true);
                expect(
                  raw.controls.find((control) => control.label === "Resume")
                    ?.upload?.network,
                ).not.toBe("rejected");
                return call("type", {
                  ref: field("Phone"),
                  text: "+12025550123",
                });
              }
              if (turn === 3) return call("submit_application", { ref: send });
              expect(observation.bodyTextExcerpt).toContain(
                "Application received",
              );
              return call("finish", {
                reason: "Employer received the application",
                sendOutcome: {
                  outcome: "confirmed",
                  evidence: "Application received",
                },
              });
            } catch (error) {
              modelFailure = error;
              return {
                toolCalls: [
                  {
                    id: "stop_test",
                    type: "function",
                    function: {
                      name: "finish",
                      arguments: JSON.stringify({
                        stuck: true,
                        reason: String(error),
                      }),
                    },
                  },
                ],
              };
            }
          },
        },
      );
      expect(modelFailure).toBeUndefined();
      const sends = mode === "autonomous_submit" ? 2 : 0;
      expect(replica.state).toEqual({ posts: sends, accepted: sends ? 1 : 0 });
      expect(inputs).toHaveLength(sends);
      for (const input of inputs) await runApplicationSubmissionRuntime(input);
      expect(replica.state.posts).toBe(sends);
      expect(await repository.listSubmissionArmedMarkers()).toHaveLength(sends);
      if (sends) {
        const receipts = await repository.listSubmissionOutcomeRecords();
        expect(receipts[0]?.browserAction?.requestsAfterClick).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: 422, responseText: refusalText }),
          ]),
        );
      }
      expect(result.outcome).toBe(
        mode === "confirm_before_submit"
          ? "awaiting_your_review"
          : sends
            ? "submitted"
            : "prepared",
      );
    } finally {
      controller.abort();
      await context.close();
      store.close();
      await replica.close();
    }
  },
  60_000,
);

test("a plain press also returns the refused form body as press facts", async () => {
  const replica = await startApplyFactsReplica();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(replica.url);
    const mechanics = createPlaywrightApplyPageMechanics(page);
    const form = await mechanics.readPage();
    const result = await mechanics.clickElement(form.actions[0]!.ref!);
    expect(result.clickFacts?.requestsAfterClick).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          status: 422,
          responseText: refusalText,
        }),
      ]),
    );
    expect(replica.state).toEqual({ posts: 1, accepted: 0 });
  } finally {
    await context.close();
    await replica.close();
  }
});

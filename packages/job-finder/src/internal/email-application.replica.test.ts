import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  SubmissionOutcomeRecordSchema,
} from "@nestor/contracts";
import { createSendGuards, openJobStore } from "@nestor/db/job-store";
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
import { runApplicationSubmissionRuntime } from "./application-submission-runtime";

// A synthetic employer contact page and a synthetic mail client, served by
// local routes. Nothing leaves the test browser.
const employerPage = `<!doctype html><title>Kontakt</title><h1>Kontakt</h1>
<p>Bewerbungen bitte per E-Mail an jobs@employer.invalid.</p>
<form><label>E-Mail Adresse<input name="email"></label><button>Senden</button></form>`;
const composePage = `<!doctype html><title>Compose - Mail</title>
<div role="dialog" aria-label="New Message">
<label>To<input aria-label="To recipients" name="to"></label>
<label>Subject<input name="subjectbox" aria-label="Subject"></label>
<label>Message Body<textarea aria-label="Message Body" name="body"></textarea></label>
<div role="button" tabindex="0" aria-label="Send" id="send">Send</div>
</div><p id="status"></p>
<script>
document.getElementById("send").addEventListener("click", async () => {
  await fetch("/sync/send", { method: "POST", body: JSON.stringify({
    to: document.querySelector("[name=to]").value,
    subject: document.querySelector("[name=subjectbox]").value,
    body: document.querySelector("[name=body]").value }) });
  document.querySelector("[role=dialog]").remove();
  document.getElementById("status").textContent = "Message sent";
});
</script>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await browser?.close();
}, 30_000);

const traceLines = (dir: string): Record<string, unknown>[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );

test("an application by email from a second tab goes through the send ledger with the mailbox as destination and readable evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-application-trace-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  const context: BrowserContext = await browser.newContext();
  const posts: string[] = [];
  await context.route("https://employer.invalid/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: employerPage,
    }),
  );
  await context.route("https://mail.google.com/**", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postData() ?? "");
      return route.fulfill({ status: 200, body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: composePage,
    });
  });
  const page = await context.newPage();
  const store = openJobStore(":memory:");
  const repository = createSendGuards(store);
  const body =
    "Dear hiring team, please find my application for the Engineer role attached.";
  let turn = 0;
  try {
    await page.goto("https://employer.invalid/kontakt");
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const recorded: { sendCallId: string; pageUrl: string | null }[] = [];
    const config: ApplyAgentConfig = {
      hands,
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
        startingUrl: "https://employer.invalid/kontakt",
      },
      siteLabel: "Synthetic employer",
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
          description: "Apply by email.",
        },
      },
      submitApplication: async (decision) => {
        const sent = await runApplicationSubmissionRuntime({
          repository,
          source: "target_site",
          savedMode: "autonomous_submit",
          authorityEnvelopeId: "instruction",
          authorityRevision: 1,
          preflightId: "mail-send-preflight",
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
          // The runtime hands over the bound form page, as the app does.
          browserRuntime: {
            observeApplicationForm: (_source, options) =>
              observeApplicationForm(page, options),
            executeExactlyOneFinalAction: async (_source, action) => {
              // The intent row exists before the press, and nothing was sent.
              expect(
                await repository.listSubmissionArmedMarkers(),
              ).toHaveLength(1);
              expect(posts).toEqual([]);
              return executeExactlyOneFinalAction(page, action);
            },
          },
        });
        expect(sent.status).toBe("outcome_uncertain");
        return {
          outcome: "outcome_uncertain",
          sendCallId: decision.callId!,
          content: `Send ledger: sendCallId=${decision.callId}, outcome_uncertain.`,
        };
      },
      recordSendOutcome: async (decision) => {
        recorded.push({
          sendCallId: decision.sendCallId,
          pageUrl: decision.pageUrl ?? null,
        });
        const key = await repository.getSubmissionIdempotencyRecord(
          decision.sendCallId,
        );
        const previous = await repository.getSubmissionOutcomeRecord(
          key!.outcomeId!,
        );
        const at = new Date().toISOString();
        const destination = new URL(decision.pageUrl!);
        await repository.resolveSubmissionOutcome({
          expectedOutcomeId: previous!.id,
          expectedIdempotencyRevision: key!.revision,
          outcome: SubmissionOutcomeRecordSchema.parse({
            ...previous,
            id: `${previous!.id}_model`,
            outcome: "submitted",
            verifiedAt: at,
            evidence: [
              {
                id: "mail-evidence",
                kind: "employer_site_state",
                observedAt: at,
                destination: {
                  origin: destination.origin,
                  safePath: destination.pathname,
                },
                artifactRefId: null,
                summary: decision.evidence,
              },
            ],
            retry: { eligible: false, blockReason: "submission_confirmed" },
            browserAction: {
              ...previous!.browserAction,
              reason: "model_observed_outcome",
            },
          }),
        });
        return { recorded: true, content: "Recorded confirmed." };
      },
    };
    const result = await withTraceScope(
      { applicationKey: "application_1_attempt_1" },
      () =>
        runApplyAgent(config, {
          chatWithTools: async () => {
            turn++;
            const observed = await hands.observe();
            const ref = (label: string) =>
              [
                ...observed.controls,
                ...observed.actions,
                ...observed.clickables,
              ].find((entry) => entry.label.includes(label))!.ref;
            let name: string, args: Record<string, unknown>;
            if (turn === 1) {
              name = "open_tab";
              args = {
                url: "https://mail.google.com/mail/u/0/#inbox?compose=new",
              };
            } else if (turn === 2) {
              name = "fill_fields";
              args = {
                fields: [
                  {
                    tool: "type",
                    ref: ref("To"),
                    text: "jobs@employer.invalid",
                  },
                  {
                    tool: "type",
                    ref: ref("Subject"),
                    text: "Application: Engineer",
                  },
                  { tool: "type", ref: ref("Message Body"), text: body },
                ],
              };
            } else if (turn === 3) {
              name = "submit_application";
              args = { ref: ref("Send") };
            } else if (turn === 4) {
              name = "record_send_outcome";
              args = {
                sendCallId: "mail-send",
                outcome: "confirmed",
                evidence: "The mail client showed Message sent.",
              };
            } else {
              name = "finish";
              args = { reason: "The application email was sent." };
            }
            const response = {
              toolCalls: [
                {
                  id: turn === 3 ? "mail-send" : `call-${turn}`,
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
    expect(result.outcome).toBe("submitted");
    // One email left, through the ledger, to the mailbox destination.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(body);
    expect(
      (await repository.getSubmissionPreflightRecord("mail-send-preflight"))
        ?.origin,
    ).toBe("https://mail.google.com");
    expect(recorded).toEqual([
      {
        sendCallId: "mail-send",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
      },
    ]);
    const outcomes = await repository.listSubmissionOutcomeRecords();
    expect(outcomes.map((row) => row.outcome)).toEqual([
      "outcome_uncertain",
      "submitted",
    ]);
    expect(outcomes[1]?.evidence[0]?.destination.origin).toBe(
      "https://mail.google.com",
    );
    // The tab that carried the send stays for final evidence until its form
    // tab closes.
    const mailbox = context
      .pages()
      .find((open) => open.url().startsWith("https://mail.google.com/"));
    expect(mailbox?.isClosed()).toBe(false);
    // Evidence after Gmail opened stays readable: no code was involved.
    const lines = traceLines(dir);
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("[secret omitted]");
    expect(
      lines.some(
        (line) =>
          line.event === "provider_response_raw" &&
          JSON.stringify(line).includes("submit_application"),
      ),
    ).toBe(true);
    expect(raw).toContain(body);
    const mailboxShot = lines.find(
      (line) =>
        line.event === "page_snapshot" &&
        String(line.url).startsWith("https://mail.google.com/") &&
        line.shot,
    );
    expect(mailboxShot).toBeDefined();
    expect(existsSync(join(dir, String(mailboxShot!.shot)))).toBe(true);
    await page.close();
    await vi.waitFor(() => expect(mailbox?.isClosed()).toBe(true));
  } finally {
    await context.close();
    store.close();
  }
}, 60_000);

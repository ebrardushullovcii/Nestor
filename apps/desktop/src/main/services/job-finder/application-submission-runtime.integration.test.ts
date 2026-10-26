import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
} from "@nestor/contracts";
import { createFileJobFinderRepository } from "@nestor/db";
import { createApplicationStore } from "@nestor/db/applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "@nestor/browser-runtime";
import {
  runApplicationSubmissionRuntime,
  type ApplicationSubmissionBrowserRuntime,
} from "@nestor/job-finder/application-submission-runtime-main";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterEach, describe, expect, test } from "vitest";

import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";

const NOW = "2026-08-27T10:00:00.000Z";
const EXPIRES_AT = "2026-08-27T11:00:00.000Z";
const ANSWER_SHA256 = "b".repeat(64);
const RESUME_BYTES = new TextEncoder().encode("trusted resume bytes");
const RESUME_SHA256 = createHash("sha256").update(RESUME_BYTES).digest("hex");

const POLICY_RULES = {
  version: 1 as const,
  answerPolicy: {
    approvedAnswerSnapshot: { revision: 1, digest: ANSWER_SHA256 },
    unknownRequiredQuestion: "pause_for_user" as const,
    unknownEligibility: "pause_for_user" as const,
    unknownLegalRequirement: "pause_for_user" as const,
  },
  stopConditions: {
    unavailableCredentials: "pause_for_user" as const,
    loginRequired: "pause_for_user" as const,
    mfaRequired: "pause_for_user" as const,
    captcha: "pause_for_user" as const,
    antiBot: "pause_for_user" as const,
    accountCreation: "pause_for_user" as const,
    staleObservation: "pause_for_user" as const,
    ambiguousFinalControl: "pause_for_user" as const,
    originDrift: "pause_for_user" as const,
    outcomeUncertain: "stop_no_retry" as const,
  },
};
const POLICY_IDENTITY = {
  version: POLICY_RULES.version,
  revision: 1,
  digest: createHash("sha256")
    .update(
      serializeApplicationAuthorityDecisionPolicyForDigest(POLICY_RULES),
      "utf8",
    )
    .digest("hex"),
};

interface SubmissionFixtureServer {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly postReceived: Promise<void>;
  readonly close: () => Promise<void>;
}

function startSubmissionFixtureServer(): Promise<SubmissionFixtureServer> {
  const requests: string[] = [];
  let resolvePostReceived: () => void = () => undefined;
  const postReceived = new Promise<void>((resolve) => {
    resolvePostReceived = resolve;
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    requests.push(`${method} ${requestUrl.pathname}`);
    if (method === "POST" && requestUrl.pathname === "/submit") {
      resolvePostReceived();
    }

    response.writeHead(200, { "content-type": "text/html" });
    if (requestUrl.pathname === "/submit") {
      response.end("<main>fixture action received</main>");
      return;
    }
    response.end(`
      <form id="application" method="post" action="/submit?token=fixture-secret">
        <button id="send" type="submit">Send application</button>
      </form>
      <script>
        document.querySelector("#application").addEventListener("submit", (event) => {
          event.preventDefault();
          void fetch(event.currentTarget.action, { method: "POST" });
        });
      </script>
    `);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        postReceived,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}

async function waitForPostReceived(postReceived: Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("The local fixture did not receive the expected POST"));
    }, 5_000);
    void postReceived.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("desktop main application submission composition", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("executes one local action, persists uncertainty, and blocks the same key", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-desktop-submission-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const fixture = await startSubmissionFixtureServer();
    let jobs: JobStore | null = null;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let repository: Awaited<
      ReturnType<typeof createFileJobFinderRepository>
    > | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      const activePage = await context.newPage();
      await activePage.goto(`${fixture.baseUrl}/apply`);
      const initialObservation = await observeApplicationForm(activePage);
      const origin = initialObservation.page.origin;
      if (!origin) {
        throw new Error("The local fixture did not expose an HTTP origin");
      }

      repository = await createFileJobFinderRepository({
        filePath: path.join(temporaryDirectory, "job-finder-state.sqlite"),
        seed: createEmptyJobFinderRepositoryState(),
      });
      jobs = openJobStore(":memory:");
      const [jobId] = jobs.saveFoundJobs({
        searchId: null,
        jobs: [
          {
            title: "Synthetic application",
            company: "Synthetic employer",
            location: "Remote",
            workModes: ["remote"],
            url: `${origin}/apply`,
            applyUrl: null,
            sourceId: "replica",
            sourceLabel: "Local replica",
            sourceJobId: "1",
            postedAt: null,
            salaryText: null,
            salaryMin: null,
            salaryMax: null,
            salaryCurrency: null,
            seniority: null,
            employmentType: null,
            summary: null,
            description: "Synthetic submission guard fixture",
          },
        ],
      }).added;
      approveOriginalResumesForTests(jobs, [jobId!]);
      const applications = createApplicationStore(jobs);
      applications.applyJobs(
        { selection: { ids: [jobId!] } },
        "autonomous_submit",
      );
      const application = applications.claimNext()!;
      const lineage = {
        runId: `application_run_${application.id}`,
        jobId: String(application.jobId),
        resultId: `application_${application.id}_attempt_${application.attempt}`,
        applicationRecordId: `application_${application.id}`,
        campaignId: null,
      };
      const authority = ApplicationAuthorityEnvelopeSchema.parse({
        id: "authority_1",
        mode: "autonomous_submit",
        status: "active",
        revision: 1,
        scope: { campaignId: null, jobIds: [lineage.jobId] },
        maxApplicationsPerRun: 1,
        intermediateMutationsAuthorized: false,
        accountCreationAuthorized: false,
        allowedResumeSha256: [RESUME_SHA256],
        allowedOrigins: [origin],
        createdAt: NOW,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
        decisionPolicy: { ...POLICY_RULES, ...POLICY_IDENTITY },
      });
      await repository.commitApplicationAuthorityEnvelope({
        envelope: authority,
        expectedRevision: null,
      });

      const browserRuntime: ApplicationSubmissionBrowserRuntime = {
        observeApplicationForm: (_source, options) =>
          observeApplicationForm(activePage, options),
        executeExactlyOneFinalAction: (_source, input) =>
          executeExactlyOneFinalAction(activePage, input),
      };
      const input = {
        repository,
        browserRuntime,
        source: "target_site" as const,
        savedMode: "autonomous_submit" as const,
        authorityEnvelopeId: authority.id,
        authorityRevision: authority.revision,
        preflightId: "preflight_1",
        idempotencyKey: "idempotency_1",
        lineage,
        resumeBytes: RESUME_BYTES,
        answers: { revision: 1, digest: ANSWER_SHA256 },
        capacity: { remainingRunCapacity: 1 },
        currentPolicyFacts: {
          policy: POLICY_IDENTITY,
          answers: { revision: 1, digest: ANSWER_SHA256 },
          mandatoryStops: [],
        },
        now: NOW,
      };

      expect(
        applications.beginSubmission(application.id, application.attempt),
      ).toBe(true);
      const first = await runApplicationSubmissionRuntime(input);
      await waitForPostReceived(fixture.postReceived);

      expect(first.status).toBe("outcome_uncertain");
      expect(
        fixture.requests.filter((request) => request === "POST /submit"),
      ).toHaveLength(1);
      await expect(
        repository.listSubmissionOutcomeRecords(),
      ).resolves.toMatchObject([
        { outcome: "outcome_uncertain", retry: { eligible: false } },
      ]);
      if (!("outcome" in first) || !first.outcome)
        throw new Error("Missing uncertain outcome");
      expect(
        applications.recordSubmission(
          application.id,
          application.attempt,
          first.outcome,
        ),
      ).toBe(true);
      expect(applications.getApplication(application.id)?.state).toBe(
        "uncertain",
      );
      expect(applications.getSubmissionReceipt(application.id)?.retry).toEqual({
        eligible: false,
        blockReason: "outcome_uncertain",
      });
      expect(
        applications.applyJobs({ selection: { ids: [application.jobId] } })
          .queued,
      ).toBe(0);
      expect(applications.claimNext()).toBeNull();
      expect(
        applications.beginSubmission(application.id, application.attempt),
      ).toBe(false);

      const second = await runApplicationSubmissionRuntime(input);
      expect(second).toMatchObject({
        status: "blocked",
        reason: "idempotency_outcome_uncertain",
      });
      expect(
        fixture.requests.filter((request) => request === "POST /submit"),
      ).toHaveLength(1);
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      jobs?.close();
      await repository?.close().catch(() => undefined);
      await fixture.close().catch(() => undefined);
    }
  }, 120_000);
});

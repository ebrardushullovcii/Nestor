import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  ApplyJobResultSchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationRecordSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
} from "@nestor/contracts";
import { createFileJobFinderRepository } from "@nestor/db";
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

async function seedParents(
  repository: Awaited<ReturnType<typeof createFileJobFinderRepository>>,
  origin: string,
): Promise<void> {
  await repository.upsertApplicationRecord(
    ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Synthetic application",
      company: "Synthetic employer",
      status: "approved",
      lastActionLabel: "Application prepared",
      nextActionLabel: "Review the prepared application",
      lastUpdatedAt: NOW,
      lastAttemptState: "ready",
    }),
  );
  await repository.upsertApplyJobResult(
    ApplyJobResultSchema.parse({
      id: "result_1",
      runId: "run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
      state: "submitting",
      summary: "Synthetic final action is ready.",
      detail: "The synthetic executor is awaiting a durable outcome.",
      startedAt: NOW,
      updatedAt: NOW,
      privacyReceipt: {
        generatedAt: NOW,
        lineage: {
          runId: "run_1",
          jobId: "job_1",
          resultId: "result_1",
          applicationRecordId: "application_1",
        },
        destination: { origin, safePath: "/apply" },
        resume: {
          source: "original_upload",
          sourceDocumentId: "resume_1",
          exportArtifactId: null,
          fileName: "resume.pdf",
          sha256: RESUME_SHA256,
        },
        finalSubmitAuthorized: true,
        finalSubmitOccurred: false,
        submissionOutcome: null,
      },
    }),
  );
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
      await seedParents(repository, origin);
      const authority = ApplicationAuthorityEnvelopeSchema.parse({
        id: "authority_1",
        mode: "autonomous_submit",
        status: "active",
        revision: 1,
        scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
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
        lineage: {
          runId: "run_1",
          jobId: "job_1",
          resultId: "result_1",
          applicationRecordId: "application_1",
          campaignId: "campaign_1",
        },
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
      const [projectedResult] = await repository.listApplyJobResults({
        jobId: "job_1",
      });
      expect(projectedResult).toMatchObject({
        state: "blocked",
        privacyReceipt: {
          finalSubmitOccurred: false,
          submissionOutcome: { outcome: "outcome_uncertain" },
        },
      });
      const [projectedApplication] = await repository.listApplicationRecords();
      expect(projectedApplication).toMatchObject({
        lastAttemptState: "paused",
        latestBlocker: { code: "requires_manual_review" },
      });

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
      await repository?.close().catch(() => undefined);
      await fixture.close().catch(() => undefined);
    }
  }, 120_000);
});

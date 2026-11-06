import { createHash } from "node:crypto";
import type {
  ApplicationAuthorityEnvelope,
  ApplicationAutomationMode,
  ApplySendOutcomeDecision,
} from "@nestor/contracts";
import {
  buildSubmissionPreflightRecord,
  type SubmissionPreflightLineageFacts,
} from "./application-submission-preflight";
import {
  runSyntheticApplicationSubmission,
  type SyntheticSubmissionAuthorityRepository,
} from "./application-submission-orchestrator";

/** Record a model's report of an earlier send. This never calls browser hands. */
export async function recordReportedSend(input: {
  repository: SyntheticSubmissionAuthorityRepository;
  lineage: SubmissionPreflightLineageFacts;
  envelope: ApplicationAuthorityEnvelope | null;
  mode: ApplicationAutomationMode;
  resumeBytes: Uint8Array;
  decision: ApplySendOutcomeDecision & { pageUrl: string };
  now: string;
}) {
  const { decision, now } = input;
  const destination = new URL(decision.pageUrl);
  const digest = createHash("sha256").update(decision.sendCallId).digest("hex");
  const preflight = buildSubmissionPreflightRecord({
    id: `reported_${decision.sendCallId}`,
    idempotencyKey: decision.sendCallId,
    lineage: input.lineage,
    authorityEnvelopeId:
      input.envelope?.id ?? input.lineage.applicationRecordId,
    authorityRevision: input.envelope?.revision ?? 1,
    decisionPolicy: null,
    origin: destination.origin,
    formObservation: { id: `reported_${digest}`, digest, revision: 1 },
    finalControl: {
      ref: "model_report_without_prior_intent",
      signature: digest,
    },
    resumeBytes: input.resumeBytes,
    answers: { revision: 1, digest: "0".repeat(64) },
    capacity: { remainingRunCapacity: 1 },
    createdAt: now,
  });
  return runSyntheticApplicationSubmission({
    repository: input.repository,
    preflight,
    savedMode: input.mode,
    jobId: input.lineage.jobId,
    campaignId: input.lineage.campaignId,
    observation: {
      origin: preflight.origin!,
      formObservation: preflight.formObservation,
      resumeSha256: preflight.resumeSha256,
      answers: preflight.answers,
      finalControl: preflight.finalControl,
      remainingRunCapacity: 1,
      currentPolicyFacts: {
        policy: null,
        answers: preflight.answers,
        mandatoryStops: [],
      },
    },
    now,
    executor: {
      execute: async () => {
        await Promise.resolve();
        const evidence = [
          {
            id: `reported_${digest}`,
            kind: "employer_site_state" as const,
            observedAt: now,
            destination: {
              origin: destination.origin,
              safePath: destination.pathname,
            },
            artifactRefId: null,
            summary: decision.evidence,
          },
        ];
        const browserAction = {
          reason: "model_reported_send_without_prior_intent",
          actionAttempted: false,
          actionIssued: false,
          actionCompleted: false,
        };
        if (decision.outcome === "confirmed")
          return {
            outcome: "submitted",
            verifiedAt: now,
            evidence,
            browserAction,
          };
        if (decision.outcome === "uncertain")
          return { outcome: "outcome_uncertain", evidence, browserAction };
        return {
          outcome: "not_submitted",
          evidence,
          browserAction,
          retry: { eligible: false, blockReason: "policy_decision" },
        };
      },
    },
  });
}

import { createHash } from "node:crypto";

import {
  deriveApprovedApplicationAnswerSnapshotContent,
  isActiveApplicationAuthorityEnvelope,
  isApprovedApplicationAnswerSnapshot,
  serializeApprovedApplicationAnswerSnapshotForDigest,
  type SavedJob,
  type CandidateReusableAnswer,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

export type PrepareOnlyIntermediateMutationAuthorityDecision =
  | {
      authorized: true;
      authorityEnvelopeId: string;
      authorityRevision: number;
      allowedOrigins: string[];
    }
  | {
      authorized: false;
      allowedOrigins: [];
      reason:
        | "ambiguous_authority"
        | "answer_policy_stale"
        | "authority_inactive"
        | "authority_scope_mismatch"
        | "capability_disabled"
        | "destination_origin_mismatch"
        | "destination_unavailable"
        | "resume_mismatch";
    };

function denied(
  reason: Extract<
    PrepareOnlyIntermediateMutationAuthorityDecision,
    { authorized: false }
  >["reason"],
): PrepareOnlyIntermediateMutationAuthorityDecision {
  return { authorized: false, allowedOrigins: [], reason };
}

function canonicalOrigins(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    try {
      return [new URL(value).origin];
    } catch {
      return [];
    }
  });
}

function destinationOrigin(job: SavedJob): string | null {
  try {
    return new URL(job.applicationUrl ?? job.canonicalUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Last-instant, repository-backed gate for prepare-only ATS autosaves.
 *
 * It grants no final action. Every call re-reads the active envelope, current
 * profile answers, and approved snapshot so revocation, expiry, answer drift,
 * origin drift, scope drift, or resume drift closes the capability before the
 * browser opens one short field-save window.
 */
export async function resolvePrepareOnlyIntermediateMutationAuthority(input: {
  job: SavedJob;
  now: string;
  observedOrigin?: string;
  repository: JobFinderRepository;
  resumeSha256: string | null | undefined;
  readSavedAnswers?: () => readonly CandidateReusableAnswer[];
}): Promise<PrepareOnlyIntermediateMutationAuthorityDecision> {
  const origin = destinationOrigin(input.job);
  if (origin === null) {
    return denied("destination_unavailable");
  }
  if (input.observedOrigin !== undefined && input.observedOrigin !== origin) {
    return denied("destination_origin_mismatch");
  }

  const activeEnvelopes =
    await input.repository.listApplicationAuthorityEnvelopes({
      status: "active",
    });
  if (activeEnvelopes.length !== 1) {
    return denied("ambiguous_authority");
  }
  const envelope = activeEnvelopes[0]!;
  if (
    envelope.mode !== "prepare_only" ||
    !isActiveApplicationAuthorityEnvelope(envelope, input.now)
  ) {
    return denied("authority_inactive");
  }
  if (!envelope.intermediateMutationsAuthorized) {
    return denied("capability_disabled");
  }
  const scopeMatches =
    envelope.scope.campaignId === null &&
    envelope.scope.jobIds.length === 1 &&
    envelope.scope.jobIds[0] === input.job.id;
  if (!scopeMatches) {
    return denied("authority_scope_mismatch");
  }
  // Allowed origins may be saved with their trailing slash while `URL.origin`
  // never has one, so both sides are reduced before they are compared.
  if (!canonicalOrigins(envelope.allowedOrigins).includes(origin)) {
    return denied("destination_origin_mismatch");
  }
  const resumeSha256 = input.resumeSha256?.toLowerCase() ?? null;
  if (
    resumeSha256 === null ||
    !envelope.allowedResumeSha256.includes(resumeSha256)
  ) {
    return denied("resume_mismatch");
  }

  const profileState = await input.repository.getProfileWithRevision();
  const approvedSnapshot =
    await input.repository.getLatestApplicationAnswerSnapshot(
      profileState.profile.id,
    );
  const current = deriveApprovedApplicationAnswerSnapshotContent(
    profileState.profile,
    input.readSavedAnswers?.() ?? [],
  );
  if (
    approvedSnapshot === null ||
    current.content === null ||
    !isApprovedApplicationAnswerSnapshot(envelope, approvedSnapshot)
  ) {
    return denied("answer_policy_stale");
  }
  const currentDigest = createHash("sha256")
    .update(
      serializeApprovedApplicationAnswerSnapshotForDigest(current.content),
      "utf8",
    )
    .digest("hex");
  if (currentDigest !== approvedSnapshot.digest) {
    return denied("answer_policy_stale");
  }

  return {
    authorized: true,
    authorityEnvelopeId: envelope.id,
    authorityRevision: envelope.revision,
    allowedOrigins: [...envelope.allowedOrigins],
  };
}

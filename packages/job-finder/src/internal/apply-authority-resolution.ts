import { randomUUID } from "node:crypto";

import type { ApplyAuthority } from "@nestor/browser-agent";
import {
  ApplicationAuthorityEnvelopeSchema,
  isActiveApplicationAuthorityEnvelope,
  type ApplicationAuthorityEnvelope,
} from "@nestor/contracts";
import type { SendGuards } from "@nestor/db/job-store";

import {
  recordApplicationAuthoritySuccessor,
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "./application-authority-gate";

/**
 * What one application is actually allowed to do.
 *
 * The saved authority document is the only thing that can widen this, and only
 * for the exact application it names. Everything else — an expired document, a
 * revoked one, a job it does not cover, a resume it does not list, a site it
 * does not include — falls back to filling the form in and stopping. Falling
 * back is silent by design: the person set a boundary and the run stayed
 * inside it.
 */

/** Filling in and stopping. What every application does without an authority. */
export const PREPARE_ONLY_AUTHORITY: ApplyAuthority = {
  mode: "prepare_only",
  submitAuthorized: false,
  preApprovedAttestationKinds: [],
  salaryDisclosure: "pause_for_user",
  allowedOrigins: [],
};

export interface ApplyAuthorityResolution {
  authority: ApplyAuthority;
  /**
   * Why a saved authority did not apply to this application, in plain words.
   * Null when it did apply, or when there was no authority to begin with.
   */
  narrowedBecause: string | null;
}

/**
 * The bare origin of a URL.
 *
 * A saved allowed origin is written with its trailing slash ("https://x/")
 * while `URL.origin` has none, so both sides go through here before they are
 * compared. Getting this wrong would quietly narrow every authority to
 * nothing.
 */
function canonicalOriginOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function canonicalOrigins(values: readonly string[]): string[] {
  return values
    .map((value) => canonicalOriginOf(value))
    .filter((value): value is string => value !== null);
}

function resolveSendingAuthority(input: {
  envelope: ApplicationAuthorityEnvelope | null;
  job: { id: string; campaignId?: string | null };
  /** The digest of the resume going out with this application, when known. */
  resumeSha256: string | null | undefined;
  applicationUrl: string;
  now: string;
}): ApplyAuthorityResolution {
  const { envelope } = input;
  if (!envelope) {
    return { authority: PREPARE_ONLY_AUTHORITY, narrowedBecause: null };
  }

  if (!isActiveApplicationAuthorityEnvelope(envelope, input.now)) {
    return {
      authority: PREPARE_ONLY_AUTHORITY,
      narrowedBecause:
        envelope.status === "revoked"
          ? "You turned off sending applications, so this one was filled in and left for you."
          : "Your permission to send applications has run out, so this one was filled in and left for you.",
    };
  }

  if (envelope.mode === "prepare_only") {
    return {
      authority: {
        ...PREPARE_ONLY_AUTHORITY,
        salaryDisclosure:
          envelope.decisionPolicy?.answerPolicy.salaryDisclosure ??
          "pause_for_user",
      },
      narrowedBecause: null,
    };
  }

  const scopedToJob =
    envelope.scope.jobIds.includes(input.job.id) ||
    (envelope.scope.campaignId !== null &&
      envelope.scope.campaignId === (input.job.campaignId ?? null));
  if (!scopedToJob) {
    return {
      authority: PREPARE_ONLY_AUTHORITY,
      narrowedBecause:
        "This job is outside what you allowed Job Finder to send, so it was filled in and left for you.",
    };
  }

  const resumeDigest = input.resumeSha256?.trim().toLowerCase() ?? "";
  if (
    envelope.allowedResumeSha256.length > 0 &&
    (!resumeDigest || !envelope.allowedResumeSha256.includes(resumeDigest))
  ) {
    return {
      authority: PREPARE_ONLY_AUTHORITY,
      narrowedBecause:
        "The resume for this application is not one you approved for sending, so it was filled in and left for you.",
    };
  }

  const origin = canonicalOriginOf(input.applicationUrl);
  const allowedOrigins = canonicalOrigins(envelope.allowedOrigins);
  if (!origin || !allowedOrigins.includes(origin)) {
    return {
      authority: PREPARE_ONLY_AUTHORITY,
      narrowedBecause:
        "This application is on a site outside what you allowed, so it was filled in and left for you.",
    };
  }

  const policy = envelope.decisionPolicy;
  if (!policy) {
    return {
      authority: PREPARE_ONLY_AUTHORITY,
      narrowedBecause:
        "Your saved permission is missing its answer rules, so this application was filled in and left for you.",
    };
  }

  return {
    authority: {
      mode: envelope.mode,
      // Confirm-first means the person presses send, so the run itself is
      // never authorized to; only autonomous mode is.
      submitAuthorized: envelope.mode === "autonomous_submit",
      preApprovedAttestationKinds: [
        ...policy.answerPolicy.preApprovedAttestationKinds,
      ],
      salaryDisclosure: policy.answerPolicy.salaryDisclosure,
      allowedOrigins,
    },
    narrowedBecause: null,
  };
}

export function resolveApplyAuthority(
  input: Parameters<typeof resolveSendingAuthority>[0] & {
    salaryDisclosure?: ApplyAuthority["salaryDisclosure"];
  },
): ApplyAuthorityResolution {
  const resolution = resolveSendingAuthority(input);
  return {
    ...resolution,
    authority: {
      ...resolution.authority,
      salaryDisclosure: input.salaryDisclosure ?? "pause_for_user",
    },
  };
}

/**
 * Adds one independently reviewed ATS origin to the active task permission.
 * The CAS update happens before a final-submit preflight can use the origin.
 */
export async function authorizeReviewedApplicationOrigin(input: {
  repository: Pick<
    SendGuards,
    | "getApplicationAuthorityEnvelope"
    | "commitApplicationAuthorityEnvelope"
    | "replaceApplicationAuthorityEnvelope"
  >;
  envelope: ApplicationAuthorityEnvelope;
  jobId: string;
  origin: string;
  now: string;
}): Promise<ApplicationAuthorityEnvelope | null> {
  const origin = canonicalOriginOf(input.origin);
  if (!origin) return null;
  return withApplicationAuthorityGate(input.repository, undefined, async () => {
    let current = await input.repository.getApplicationAuthorityEnvelope(
      resolveApplicationAuthoritySuccessorId(
        input.repository,
        input.envelope.id,
      ),
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (
        !current ||
        current.mode === "prepare_only" ||
        current.mode !== input.envelope.mode ||
        !isActiveApplicationAuthorityEnvelope(
          current,
          new Date().toISOString(),
        ) ||
        !current.scope.jobIds.includes(input.jobId)
      ) {
        return null;
      }
      if (canonicalOrigins(current.allowedOrigins).includes(origin)) {
        return current;
      }

      const expandedOrigins = [...current.allowedOrigins, origin];
      const envelope = ApplicationAuthorityEnvelopeSchema.parse({
        ...current,
        revision: current.revision + 1,
        allowedOrigins: expandedOrigins,
      });
      const committed =
        await input.repository.commitApplicationAuthorityEnvelope({
          envelope,
          expectedRevision: current.revision,
        });
      if (committed.status === "applied") return committed.envelope;
      if (
        committed.current?.status === "active" &&
        committed.current.revision !== current.revision
      ) {
        current = committed.current;
        continue;
      }
      if (
        committed.current?.status !== "active" ||
        committed.current.revision !== current.revision
      )
        return null;

      // A preflight makes this envelope immutable. Atomically replace that
      // exact revision, preserving every existing permission and the policy.
      const replacedAt = new Date().toISOString();
      const replacement = ApplicationAuthorityEnvelopeSchema.parse({
        ...current,
        id: `authority_${randomUUID()}`,
        status: "active",
        revision: 1,
        createdAt: replacedAt,
        revokedAt: null,
        allowedOrigins: expandedOrigins,
      });
      const replaced =
        await input.repository.replaceApplicationAuthorityEnvelope({
          currentId: current.id,
          expectedRevision: current.revision,
          replacement,
          revokedAt: replacedAt,
        });
      if (replaced.status === "applied") {
        recordApplicationAuthoritySuccessor(
          input.repository,
          current.id,
          replaced.envelope.id,
        );
        return replaced.envelope;
      }
      if (replaced.status !== "stale" || replaced.current?.status !== "active")
        return null;
      current = replaced.current;
    }
    return null;
  });
}

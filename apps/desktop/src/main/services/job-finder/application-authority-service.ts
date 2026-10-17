import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationAuthorityEnvelopeSchema,
  ApplicationAuthorityDecisionPolicySchema,
  ApplicationAuthorityReadinessSchema,
  ApplicationAuthorityEnvelopeMutationResultSchema,
  ApproveCurrentApplicationAnswersInputSchema,
  ApproveCurrentApplicationAnswersResultSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  deriveApprovedApplicationAnswerSnapshotContent,
  CurrentApplicationAnswerSummarySchema,
  CreateApplicationAuthorityEnvelopeInputSchema,
  GetApplicationAuthorityEnvelopeInputSchema,
  ListApplicationAuthorityEnvelopesInputSchema,
  ListApplicationAuthorityEnvelopesResultSchema,
  RevokeApplicationAuthorityEnvelopeInputSchema,
  ResolveSubmissionOutcomeInputSchema,
  ResolveSubmissionOutcomeResultSchema,
  SubmissionOutcomeRecordSchema,
  serializeApprovedApplicationAnswerSnapshotForDigest,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  type ApplicationAttestationKind,
  type ApplicationSalaryDisclosureRule,
  type ApplicationAuthorityReadiness,
  type ApproveCurrentApplicationAnswersInput,
  type ApproveCurrentApplicationAnswersResult,
  type ApprovedApplicationAnswerSnapshot,
  UpdateApplicationAuthorityEnvelopeInputSchema,
  type ApplicationAuthorityEnvelope,
  type ApplicationAuthorityEnvelopeMutationResult,
  type CreateApplicationAuthorityEnvelopeInput,
  type GetApplicationAuthorityEnvelopeInput,
  type ListApplicationAuthorityEnvelopesInput,
  type ListApplicationAuthorityEnvelopesResult,
  type RevokeApplicationAuthorityEnvelopeInput,
  type ResolveSubmissionOutcomeInput,
  type ResolveSubmissionOutcomeResult,
  type UpdateApplicationAuthorityEnvelopeInput,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { getJobFinderRepositoryForWorkspaceService } from "./create-workspace-service";
import { getJobFinderWorkspaceService } from "./workspace-service";

export type JobFinderApplicationAuthorityErrorCode =
  | "unsupported_mode"
  | "approved_answers_required"
  | "active_authority_exists"
  | "invalid_clock"
  | "repository_unavailable";

/**
 * Safe, user-facing failures from authority management. The service does not
 * expose SQLite errors or accept a renderer-supplied lifecycle timestamp.
 */
export class JobFinderApplicationAuthorityError extends Error {
  readonly code: JobFinderApplicationAuthorityErrorCode;

  constructor(code: JobFinderApplicationAuthorityErrorCode, message: string) {
    super(message);
    this.name = "JobFinderApplicationAuthorityError";
    this.code = code;
  }
}

export interface JobFinderApplicationAuthorityService {
  getReadiness(): Promise<ApplicationAuthorityReadiness>;
  approveCurrentAnswers(
    input: ApproveCurrentApplicationAnswersInput,
  ): Promise<ApproveCurrentApplicationAnswersResult>;
  list(
    input?: ListApplicationAuthorityEnvelopesInput,
  ): Promise<ListApplicationAuthorityEnvelopesResult>;
  get(
    input: GetApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelope | null>;
  create(
    input: CreateApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelopeMutationResult>;
  update(
    input: UpdateApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelopeMutationResult>;
  /** Atomically replaces a used grant while keeping its previous revision inspectable. */
  replaceUsed(
    input: UpdateApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelopeMutationResult>;
  revoke(
    input: RevokeApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelopeMutationResult>;
  resolveSubmissionOutcome(
    input: ResolveSubmissionOutcomeInput,
  ): Promise<ResolveSubmissionOutcomeResult>;
}

export interface CreateJobFinderApplicationAuthorityServiceOptions {
  repository?: JobFinderRepository;
  resolveRepository?: () => Promise<JobFinderRepository>;
  now?: () => string;
  idFactory?: () => string;
  releaseApplicationPage?: (resultId: string) => void;
}

const APPROVED_ANSWERS_REQUIRED_MESSAGE =
  "Approve your saved application answers before Job Finder can send applications for you.";
const ACTIVE_AUTHORITY_MESSAGE =
  "An active application authority already exists; revoke it before creating another.";

function buildAnswerSummary(
  profile: Parameters<typeof deriveApprovedApplicationAnswerSnapshotContent>[0],
  profileRevision: number,
): {
  current: ReturnType<typeof CurrentApplicationAnswerSummarySchema.parse>;
  content: ReturnType<
    typeof deriveApprovedApplicationAnswerSnapshotContent
  >["content"];
} {
  const { content, kinds, missingRequiredKinds } =
    deriveApprovedApplicationAnswerSnapshotContent(profile);
  const digest =
    content !== null
      ? createHash("sha256")
          .update(
            serializeApprovedApplicationAnswerSnapshotForDigest(content),
            "utf8",
          )
          .digest("hex")
      : null;
  return {
    content,
    current: CurrentApplicationAnswerSummarySchema.parse({
      sourceProfileRevision: Math.max(1, profileRevision),
      digest,
      entryCount: content?.entries.length ?? 0,
      kinds,
      missingRequiredKinds,
    }),
  };
}

function summarizeApprovedSnapshot(
  snapshot: ApprovedApplicationAnswerSnapshot | null,
) {
  return snapshot
    ? {
        id: snapshot.id,
        revision: snapshot.revision,
        digest: snapshot.digest,
        sourceProfileRevision: snapshot.sourceProfileRevision,
        approvedAt: snapshot.approvedAt,
        entryCount: snapshot.entries.length,
        kinds: [...new Set(snapshot.entries.map((entry) => entry.kind))],
      }
    : null;
}

/**
 * Builds the immutable decision document an authority carries.
 *
 * Every fail-closed rule in it is fixed: unknown questions, missing
 * credentials, sign-in walls, security checks, account creation, a stale page,
 * an ambiguous send button, and origin drift all stop for the person, and an
 * uncertain outcome is never retried. The only parts the person chooses are
 * which declarations they approve in advance and what to do about pay.
 *
 * Sending applications, and letting a site save fields as they are filled,
 * both require the person's saved answers to be approved and current: the
 * authority is bound to that exact snapshot, so answers cannot drift out from
 * under a running authority.
 */
async function buildDecisionPolicy(input: {
  repository: JobFinderRepository;
  mode: CreateApplicationAuthorityEnvelopeInput["mode"];
  intermediateMutationsAuthorized: boolean;
  preApprovedAttestationKinds: readonly ApplicationAttestationKind[];
  salaryDisclosure: ApplicationSalaryDisclosureRule;
  revision: number;
}) {
  const elevated =
    input.mode === "confirm_before_submit" ||
    input.mode === "autonomous_submit";
  if (!elevated && !input.intermediateMutationsAuthorized) {
    return null;
  }

  const profileState = await input.repository.getProfileWithRevision();
  const approvedSnapshot =
    await input.repository.getLatestApplicationAnswerSnapshot(
      profileState.profile.id,
    );
  const { current } = buildAnswerSummary(
    profileState.profile,
    profileState.revision,
  );
  // Missing work-authorisation or sponsorship answers do not gate sending:
  // the run hands any such question back at the form (ADR 0021), and a gate
  // here only produced a misleading "approve your answers" error on a profile
  // that had nothing to approve.
  if (
    approvedSnapshot === null ||
    current.digest === null ||
    approvedSnapshot.digest !== current.digest
  ) {
    throw new JobFinderApplicationAuthorityError(
      "approved_answers_required",
      APPROVED_ANSWERS_REQUIRED_MESSAGE,
    );
  }

  const content = {
    version: 1 as const,
    answerPolicy: {
      approvedAnswerSnapshot: {
        revision: approvedSnapshot.revision,
        digest: approvedSnapshot.digest,
      },
      unknownRequiredQuestion: "pause_for_user" as const,
      unknownEligibility: "pause_for_user" as const,
      unknownLegalRequirement: "pause_for_user" as const,
      preApprovedAttestationKinds: [...input.preApprovedAttestationKinds],
      salaryDisclosure: input.salaryDisclosure,
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
  return ApplicationAuthorityDecisionPolicySchema.parse({
    ...content,
    revision: input.revision,
    digest: createHash("sha256")
      .update(
        serializeApplicationAuthorityDecisionPolicyForDigest(content),
        "utf8",
      )
      .digest("hex"),
  });
}

function parseClockValue(now: string): string {
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) {
    throw new JobFinderApplicationAuthorityError(
      "invalid_clock",
      "The authority clock returned an invalid timestamp.",
    );
  }
  return parsed.toISOString();
}

function assertExpiryIsFuture(expiresAt: string | null, now: string): void {
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now)) {
    throw new JobFinderApplicationAuthorityError(
      "invalid_clock",
      "An authority expiry must be later than the current time.",
    );
  }
}

function assertRevocationClockIsValid(
  envelope: ApplicationAuthorityEnvelope,
  now: string,
): void {
  if (Date.parse(now) < Date.parse(envelope.createdAt)) {
    throw new JobFinderApplicationAuthorityError(
      "invalid_clock",
      "The authority clock cannot precede the envelope creation time.",
    );
  }
}

function parseMutationResult(
  result: Awaited<
    ReturnType<JobFinderRepository["commitApplicationAuthorityEnvelope"]>
  >,
): ApplicationAuthorityEnvelopeMutationResult {
  return ApplicationAuthorityEnvelopeMutationResultSchema.parse(result);
}

/**
 * Creates the management-only authority slice. It deliberately owns no
 * preflight, grant, arm, navigation, or final-submit operation.
 */
export function createJobFinderApplicationAuthorityService(
  options: CreateJobFinderApplicationAuthorityServiceOptions,
): JobFinderApplicationAuthorityService {
  const suppliedRepository = options.repository;
  const resolveRepository =
    options.resolveRepository ??
    (suppliedRepository
      ? () => Promise.resolve(suppliedRepository)
      : () =>
          Promise.reject(
            new JobFinderApplicationAuthorityError(
              "repository_unavailable",
              "The Job Finder workspace repository is unavailable.",
            ),
          ));
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;

  // Serialize the list-then-CAS create check within this one main-process
  // service. Repository CAS still protects revisions and revocation.
  let mutationTail = Promise.resolve();
  function withMutationLock<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function deriveReadiness(
    repository: JobFinderRepository,
  ): Promise<ApplicationAuthorityReadiness> {
    const state = await repository.getProfileWithRevision();
    const [approvedSnapshot, activeAuthority] = await Promise.all([
      repository.getLatestApplicationAnswerSnapshot(state.profile.id),
      repository
        .listApplicationAuthorityEnvelopes({ status: "active" })
        .then((envelopes) => envelopes[0] ?? null),
    ]);
    const { current } = buildAnswerSummary(state.profile, state.revision);
    const approvedSummary = summarizeApprovedSnapshot(approvedSnapshot);
    const answerApprovalStatus =
      current.entryCount === 0
        ? "missing_answers"
        : approvedSnapshot === null
          ? "not_approved"
          : approvedSnapshot.digest !== current.digest
            ? "stale"
            : "current";
    const blockers: ApplicationAuthorityReadiness["blockers"] = [];
    if (current.entryCount === 0) {
      blockers.push({ code: "no_reusable_answers", remediation: "profile" });
    } else if (current.missingRequiredKinds.length > 0) {
      blockers.push({
        code: "required_answer_missing",
        remediation: "profile",
      });
    }
    if (approvedSnapshot === null && current.entryCount > 0) {
      blockers.push({
        code: "no_approved_answer_snapshot",
        remediation: "settings",
      });
    } else if (answerApprovalStatus === "stale") {
      blockers.push({
        code: "approved_answer_snapshot_stale",
        remediation: "settings",
      });
    }
    blockers.push({
      code: "elevated_execution_unavailable",
      remediation: "unavailable",
    });
    return ApplicationAuthorityReadinessSchema.parse({
      generatedAt: parseClockValue(now()),
      executionCapability: "prepare_only",
      elevatedExecutionAvailable: false,
      answerApprovalStatus,
      currentAnswers: current,
      approvedSnapshot: approvedSummary,
      activeAuthority: activeAuthority
        ? {
            id: activeAuthority.id,
            revision: activeAuthority.revision,
            status: activeAuthority.status,
            mode: activeAuthority.mode,
          }
        : null,
      blockers,
    });
  }

  const service: JobFinderApplicationAuthorityService = {
    async getReadiness(): Promise<ApplicationAuthorityReadiness> {
      return withMutationLock(async () => {
        const repository = await resolveRepository();
        return deriveReadiness(repository);
      });
    },

    async approveCurrentAnswers(
      input: ApproveCurrentApplicationAnswersInput,
    ): Promise<ApproveCurrentApplicationAnswersResult> {
      return withMutationLock(async () => {
        const parsedInput =
          ApproveCurrentApplicationAnswersInputSchema.parse(input);
        const repository = await resolveRepository();
        const state = await repository.getProfileWithRevision();
        if (state.revision !== parsedInput.expectedProfileRevision) {
          return ApproveCurrentApplicationAnswersResultSchema.parse({
            status: "stale",
            snapshot: null,
            readiness: await deriveReadiness(repository),
          });
        }
        const { content } = buildAnswerSummary(state.profile, state.revision);
        if (content === null) {
          return ApproveCurrentApplicationAnswersResultSchema.parse({
            status: "blocked",
            snapshot: null,
            readiness: await deriveReadiness(repository),
          });
        }
        const previous = await repository.getLatestApplicationAnswerSnapshot(
          state.profile.id,
        );
        const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse({
          ...content,
          id: `answer_snapshot_${idFactory()}`,
          revision: (previous?.revision ?? 0) + 1,
          digest: createHash("sha256")
            .update(
              serializeApprovedApplicationAnswerSnapshotForDigest(content),
              "utf8",
            )
            .digest("hex"),
          sourceProfileRevision: state.revision,
          approvedAt: parseClockValue(now()),
        });
        const committed = await repository.commitApplicationAnswerSnapshot({
          expectedLatestRevision: previous?.revision ?? null,
          snapshot,
        });
        const readiness = await deriveReadiness(repository);
        if (committed.status === "stale" || committed.status === "conflict") {
          return ApproveCurrentApplicationAnswersResultSchema.parse({
            status: "stale",
            snapshot: summarizeApprovedSnapshot(committed.current),
            readiness,
          });
        }
        const persisted = committed.snapshot;
        return ApproveCurrentApplicationAnswersResultSchema.parse({
          status: committed.status,
          snapshot: summarizeApprovedSnapshot(persisted),
          readiness,
        });
      });
    },

    async list(input = {}): Promise<ListApplicationAuthorityEnvelopesResult> {
      const parsedInput =
        ListApplicationAuthorityEnvelopesInputSchema.parse(input);
      const repository = await resolveRepository();
      const envelopes = await repository.listApplicationAuthorityEnvelopes({
        ...(parsedInput.id === undefined ? {} : { id: parsedInput.id }),
        ...(parsedInput.status === undefined
          ? {}
          : { status: parsedInput.status }),
      });
      return ListApplicationAuthorityEnvelopesResultSchema.parse(envelopes);
    },

    async get(
      input: GetApplicationAuthorityEnvelopeInput,
    ): Promise<ApplicationAuthorityEnvelope | null> {
      const parsedInput =
        GetApplicationAuthorityEnvelopeInputSchema.parse(input);
      const repository = await resolveRepository();
      const envelope = await repository.getApplicationAuthorityEnvelope(
        parsedInput.id,
      );
      return ApplicationAuthorityEnvelopeSchema.nullable().parse(envelope);
    },

    async create(
      input: CreateApplicationAuthorityEnvelopeInput,
    ): Promise<ApplicationAuthorityEnvelopeMutationResult> {
      return withMutationLock(async () => {
        const parsedInput =
          CreateApplicationAuthorityEnvelopeInputSchema.parse(input);
        const createdAt = parseClockValue(now());
        assertExpiryIsFuture(parsedInput.expiresAt, createdAt);

        const repository = await resolveRepository();
        const existing = await repository.listApplicationAuthorityEnvelopes({
          status: "active",
        });
        if (existing.some((envelope) => envelope.status === "active")) {
          throw new JobFinderApplicationAuthorityError(
            "active_authority_exists",
            ACTIVE_AUTHORITY_MESSAGE,
          );
        }

        const decisionPolicy = await buildDecisionPolicy({
          repository,
          mode: parsedInput.mode,
          intermediateMutationsAuthorized:
            parsedInput.intermediateMutationsAuthorized,
          preApprovedAttestationKinds: parsedInput.preApprovedAttestationKinds,
          salaryDisclosure: parsedInput.salaryDisclosure,
          revision: 1,
        });

        // The answer decisions live inside the immutable policy document, not
        // on the envelope itself.
        const envelopeFields = { ...parsedInput } as Partial<
          typeof parsedInput
        >;
        delete envelopeFields.preApprovedAttestationKinds;
        delete envelopeFields.salaryDisclosure;
        const envelope = ApplicationAuthorityEnvelopeSchema.parse({
          ...envelopeFields,
          id: `authority_${idFactory()}`,
          status: "active",
          revision: 1,
          accountCreationAuthorized: false,
          createdAt,
          revokedAt: null,
          decisionPolicy,
        });
        return parseMutationResult(
          await repository.commitApplicationAuthorityEnvelope({
            envelope,
            expectedRevision: null,
          }),
        );
      });
    },

    async update(
      input: UpdateApplicationAuthorityEnvelopeInput,
    ): Promise<ApplicationAuthorityEnvelopeMutationResult> {
      return withMutationLock(async () => {
        const parsedInput =
          UpdateApplicationAuthorityEnvelopeInputSchema.parse(input);
        const nowValue = parseClockValue(now());
        assertExpiryIsFuture(parsedInput.expiresAt, nowValue);

        const repository = await resolveRepository();
        const current = await repository.getApplicationAuthorityEnvelope(
          parsedInput.id,
        );
        if (current === null) {
          return parseMutationResult({ status: "missing", current: null });
        }
        if (
          current.status !== "active" ||
          current.revision !== parsedInput.expectedRevision
        ) {
          return parseMutationResult({ status: "stale", current });
        }

        const decisionPolicy = await buildDecisionPolicy({
          repository,
          mode: parsedInput.mode,
          intermediateMutationsAuthorized:
            parsedInput.intermediateMutationsAuthorized,
          preApprovedAttestationKinds: parsedInput.preApprovedAttestationKinds,
          salaryDisclosure: parsedInput.salaryDisclosure,
          revision: (current.decisionPolicy?.revision ?? 0) + 1,
        });

        const envelope = ApplicationAuthorityEnvelopeSchema.parse({
          mode: parsedInput.mode,
          scope: parsedInput.scope,
          maxApplicationsPerRun: parsedInput.maxApplicationsPerRun,
          maxApplicationsPerLocalDay: parsedInput.maxApplicationsPerLocalDay,
          intermediateMutationsAuthorized:
            parsedInput.intermediateMutationsAuthorized,
          accountCreationAuthorized: false,
          allowedResumeSha256: parsedInput.allowedResumeSha256,
          allowedOrigins: parsedInput.allowedOrigins,
          expiresAt: parsedInput.expiresAt,
          id: current.id,
          status: "active",
          revision: current.revision + 1,
          createdAt: current.createdAt,
          revokedAt: null,
          decisionPolicy,
        });
        return parseMutationResult(
          await repository.commitApplicationAuthorityEnvelope({
            envelope,
            expectedRevision: current.revision,
          }),
        );
      });
    },

    async replaceUsed(
      input: UpdateApplicationAuthorityEnvelopeInput,
    ): Promise<ApplicationAuthorityEnvelopeMutationResult> {
      return withMutationLock(async () => {
        const parsedInput =
          UpdateApplicationAuthorityEnvelopeInputSchema.parse(input);
        const replacedAt = parseClockValue(now());
        assertExpiryIsFuture(parsedInput.expiresAt, replacedAt);
        const repository = await resolveRepository();
        const current = await repository.getApplicationAuthorityEnvelope(
          parsedInput.id,
        );
        if (current === null) {
          return parseMutationResult({ status: "missing", current: null });
        }
        if (
          current.status !== "active" ||
          current.revision !== parsedInput.expectedRevision
        ) {
          return parseMutationResult({ status: "stale", current });
        }
        const decisionPolicy = await buildDecisionPolicy({
          repository,
          mode: parsedInput.mode,
          intermediateMutationsAuthorized:
            parsedInput.intermediateMutationsAuthorized,
          preApprovedAttestationKinds: parsedInput.preApprovedAttestationKinds,
          salaryDisclosure: parsedInput.salaryDisclosure,
          revision: 1,
        });
        const replacement = ApplicationAuthorityEnvelopeSchema.parse({
          mode: parsedInput.mode,
          scope: parsedInput.scope,
          maxApplicationsPerRun: parsedInput.maxApplicationsPerRun,
          maxApplicationsPerLocalDay: parsedInput.maxApplicationsPerLocalDay,
          intermediateMutationsAuthorized:
            parsedInput.intermediateMutationsAuthorized,
          accountCreationAuthorized: false,
          allowedResumeSha256: parsedInput.allowedResumeSha256,
          allowedOrigins: parsedInput.allowedOrigins,
          expiresAt: parsedInput.expiresAt,
          id: `authority_${idFactory()}`,
          status: "active",
          revision: 1,
          createdAt: replacedAt,
          revokedAt: null,
          decisionPolicy,
        });
        const result = await repository.replaceApplicationAuthorityEnvelope({
          currentId: current.id,
          expectedRevision: current.revision,
          replacement,
          revokedAt: replacedAt,
        });
        if (result.status === "applied") {
          return parseMutationResult({
            status: "applied",
            envelope: result.envelope,
          });
        }
        if (result.status === "missing") {
          return parseMutationResult({ status: "missing", current: null });
        }
        return parseMutationResult({
          status: "stale",
          current: result.current,
        });
      });
    },

    async revoke(
      input: RevokeApplicationAuthorityEnvelopeInput,
    ): Promise<ApplicationAuthorityEnvelopeMutationResult> {
      return withMutationLock(async () => {
        const parsedInput =
          RevokeApplicationAuthorityEnvelopeInputSchema.parse(input);
        const repository = await resolveRepository();
        const current = await repository.getApplicationAuthorityEnvelope(
          parsedInput.id,
        );
        if (current === null) {
          return parseMutationResult({ status: "missing", current: null });
        }
        if (
          current.status !== "active" ||
          current.revision !== parsedInput.expectedRevision
        ) {
          return parseMutationResult({ status: "stale", current });
        }
        const revokedAt = parseClockValue(now());
        assertRevocationClockIsValid(current, revokedAt);
        return parseMutationResult(
          await repository.revokeApplicationAuthorityEnvelope({
            id: current.id,
            expectedRevision: current.revision,
            revokedAt,
          }),
        );
      });
    },

    async resolveSubmissionOutcome(
      input: ResolveSubmissionOutcomeInput,
    ): Promise<ResolveSubmissionOutcomeResult> {
      return withMutationLock(async () => {
        const parsedInput = ResolveSubmissionOutcomeInputSchema.parse(input);
        const repository = await resolveRepository();
        const uncertainOutcome = await repository.getSubmissionOutcomeRecord(
          parsedInput.uncertainOutcomeId,
        );
        if (uncertainOutcome === null) {
          return ResolveSubmissionOutcomeResultSchema.parse({
            status: "missing",
            outcome: null,
            idempotency: null,
          });
        }

        const [result] = (
          await repository.listApplyJobResults({
            runId: uncertainOutcome.runId,
            jobId: uncertainOutcome.jobId,
            applicationRecordId: uncertainOutcome.applicationRecordId,
          })
        ).filter((candidate) => candidate.id === uncertainOutcome.resultId);
        const receipt = result?.privacyReceipt ?? null;
        const idempotency = await repository.getSubmissionIdempotencyRecord(
          uncertainOutcome.idempotencyKey,
        );
        if (
          uncertainOutcome.outcome !== "outcome_uncertain" ||
          receipt === null ||
          receipt.lineage.resultId !== uncertainOutcome.resultId ||
          receipt.submissionOutcome?.id !== uncertainOutcome.id
        ) {
          return ResolveSubmissionOutcomeResultSchema.parse({
            status: "blocked",
            outcome: null,
            idempotency,
          });
        }
        if (idempotency === null) {
          return ResolveSubmissionOutcomeResultSchema.parse({
            status: "missing",
            outcome: null,
            idempotency: null,
          });
        }

        const verifiedAt = parseClockValue(now());
        const outcome = SubmissionOutcomeRecordSchema.parse({
          ...uncertainOutcome,
          id: `outcome_${idFactory()}`,
          outcome: parsedInput.resolution,
          verifiedAt,
          evidence: [
            {
              id: `evidence_${idFactory()}`,
              kind: "operator_confirmation",
              observedAt: verifiedAt,
              destination: receipt.destination,
              artifactRefId: null,
              summary:
                parsedInput.resolution === "submitted"
                  ? "User verified on the employer site that this application was submitted."
                  : "User verified on the employer site that this application was not submitted.",
            },
          ],
          retry: {
            eligible: false,
            blockReason:
              parsedInput.resolution === "submitted"
                ? "submission_confirmed"
                : "policy_decision",
          },
        });
        const resolution = await repository.resolveSubmissionOutcome({
          expectedOutcomeId: uncertainOutcome.id,
          expectedIdempotencyRevision: idempotency.revision,
          outcome,
        });
        if (resolution.status === "recorded")
          options.releaseApplicationPage?.(uncertainOutcome.resultId);
        return ResolveSubmissionOutcomeResultSchema.parse({
          status: resolution.status,
          outcome: resolution.outcome,
          idempotency: resolution.idempotency,
        });
      });
    },
  };

  return service;
}

let defaultService: JobFinderApplicationAuthorityService | null = null;

export function getJobFinderApplicationAuthorityService(): JobFinderApplicationAuthorityService {
  defaultService ??= createJobFinderApplicationAuthorityService({
    releaseApplicationPage: (resultId) =>
      getEmbeddedBrowser().releaseOwnedTabs(resultId),
    resolveRepository: async () => {
      const workspaceService = await getJobFinderWorkspaceService();
      const repository =
        getJobFinderRepositoryForWorkspaceService(workspaceService);
      if (repository === null) {
        throw new JobFinderApplicationAuthorityError(
          "repository_unavailable",
          "The Job Finder workspace repository is unavailable.",
        );
      }
      return repository;
    },
  });
  return defaultService;
}

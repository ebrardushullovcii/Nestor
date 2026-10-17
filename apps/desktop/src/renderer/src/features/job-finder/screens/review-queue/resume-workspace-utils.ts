import type {
  ResumeAssistantMessage,
  ResumeClaimAssessment,
  ResumeDraft,
  ResumeDraftBullet,
  ResumeDraftOrigin,
  ResumeDraftRevision,
  TailoredAsset,
} from "@nestor/contracts";

const generatedResumeOrigins = new Set<ResumeDraftOrigin>([
  "ai_generated",
  "assistant_edited",
  "deterministic_fallback",
]);

export function isGeneratedResumeOrigin(origin: ResumeDraftOrigin): boolean {
  return generatedResumeOrigins.has(origin);
}

export function listGeneratedResumeBullets(
  draft: ResumeDraft,
): ResumeDraftBullet[] {
  return draft.sections.flatMap((section) => [
    ...section.bullets,
    ...section.entries.flatMap((entry) => entry.bullets),
  ]);
}

const DETERMINISTIC_FALLBACK_NOTE_PATTERN =
  /deterministic|fell back to the deterministic|timed out after \d+s/i;

export type ResumeGenerationPathInput = Pick<
  TailoredAsset,
  "generationMethod" | "generationReason" | "generationDetail"
> & { notes: readonly string[] };

export interface ResumeGenerationPathDisclosure {
  message: string;
  /**
   * The draft-origin sentences on their own, without the trailing review
   * reminder. Kept separate so a merged provenance statement can put the
   * assistant-edit clause before the reminder instead of after it.
   */
  originSentence: string;
  /**
   * True when a configured model exists and a retry could change the
   * outcome. False when no provider is configured or the deterministic path
   * was forced, because retrying would only reproduce the same draft.
   */
  canRetryWithAi: boolean;
}

/**
 * Read once, before and after approval, and true whatever rewrite strength the
 * user picked. The old wording said "before approval" — which the same screen
 * contradicts the moment the resume is approved — and named Strong/aggressive
 * settings to users who never chose them.
 */
const REVIEW_SUFFIX =
  "Read the draft against your own experience before you use it.";

/**
 * Every sentence below is scoped to the *first* draft. Accepting an assistant
 * proposal changes the document after that point, and an unscoped "Job Finder
 * used the built-in fallback instead of the AI draft" then contradicted the
 * edit the user had just watched land in the preview. Accepted AI edits are
 * reported separately by `describeAcceptedAssistantEdits`.
 */
const FIRST_DRAFT_PREFIX = "The first draft came from the built-in generator";

/**
 * A draft that kept the person's own wording because the listing body was
 * never captured is not a tailored resume, whatever the job's saved resume
 * choice says. Calling it "tailored" while the same panel explains that
 * nothing could be tailored asked the user to trust two opposite statements,
 * so every surface routes this case to the original-resume presentation.
 */
export interface UntailorableListingPresentation {
  /** Short label for the badge that would otherwise read as tailored. */
  badgeLabel: string;
  /** Why the original wording is what gets sent. */
  reason: string;
  /** One sentence for the approval action. */
  approvalMessage: string;
}

/**
 * What approving actually does, in one sentence.
 *
 * "Approving sends your resume" stopped a tester dead — "'Sends' made me stop.
 * I do not want anything sent anywhere" — and the job was left sitting at
 * NEEDS APPROVAL. Nothing is ever sent: approving lets Job Finder fill the
 * form on screen, and the person presses the final button themselves.
 */
export const APPROVAL_FILLS_NOTHING_SENT_MESSAGE =
  "Approving lets Job Finder fill the application form with this resume, on your screen. Whether it is then sent follows your Applying setting. Read the listing on the job site before you apply.";

export function describeUntailorableListing(
  asset: ResumeGenerationPathInput | null | undefined,
): UntailorableListingPresentation | null {
  if (!asset || asset.generationMethod !== "deterministic") {
    return null;
  }

  if (asset.generationReason === "listing_text_missing") {
    return {
      badgeLabel: "Your original wording",
      reason:
        "This job's listing text was not captured, so nothing could be written for it and the resume keeps your original wording.",
      approvalMessage: APPROVAL_FILLS_NOTHING_SENT_MESSAGE,
    };
  }

  // A body that says nothing specific about the job is the same outcome: a
  // draft the job did not shape is not tailored, and two unrelated jobs were
  // getting the same "tailored" resume because of it.
  if (asset.generationReason === "listing_text_not_distinguishing") {
    return {
      badgeLabel: "Your original wording",
      reason:
        "This listing says almost nothing about the job itself, so there was nothing to tailor toward and the resume keeps your original wording.",
      approvalMessage: APPROVAL_FILLS_NOTHING_SENT_MESSAGE,
    };
  }

  return null;
}

/**
 * Internal stop reasons ("permanent_failure", stream errors) mean nothing to
 * the person. Say what happened in plain words; keep short provider details
 * such as "HTTP 502 from provider" as they are.
 */
function plainGenerationDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }
  if (
    /stopped before completing|permanent_failure|budget_exhausted/i.test(detail)
  ) {
    return "the AI stopped partway through";
  }
  if (/closed the stream before finishing/i.test(detail)) {
    return "the connection to the AI service dropped";
  }
  return detail;
}

/**
 * Shortlisted's one sentence for a resume the AI could not write, or null
 * when the AI wrote it or retrying would change nothing.
 */
export function describeAiUnavailableResume(
  asset: ResumeGenerationPathInput | null | undefined,
): string | null {
  if (!asset || asset.generationMethod !== "deterministic") {
    return null;
  }
  switch (asset.generationReason) {
    case "no_provider_configured":
    case "provider_failed":
    case "provider_timeout":
    case "provider_output_unverified":
      return "AI could not write this resume, so it keeps your saved wording. Try again, or apply it as it is.";
    default:
      return null;
  }
}

/**
 * Explains why the built-in generator wrote the first draft. Prefers the
 * structured reason recorded by the AI boundary; the note-prose match remains
 * only for assets saved before the structured reason existed.
 */
export function describeResumeGenerationPath(
  asset: ResumeGenerationPathInput | null | undefined,
): ResumeGenerationPathDisclosure | null {
  if (!asset || asset.generationMethod !== "deterministic") {
    return null;
  }

  const detail = plainGenerationDetail(asset.generationDetail?.trim() || null);
  const disclose = (
    originSentence: string,
    canRetryWithAi: boolean,
  ): ResumeGenerationPathDisclosure => ({
    canRetryWithAi,
    message: `${originSentence} ${REVIEW_SUFFIX}`,
    originSentence,
  });

  switch (asset.generationReason) {
    // AI ships with the product; the user never configures it. Its absence is
    // an outage from their side, so it reads like one and stays retryable.
    case "no_provider_configured":
      return disclose(
        `${FIRST_DRAFT_PREFIX} because AI writing is not available right now.`,
        true,
      );
    case "forced_deterministic":
      return disclose(
        `${FIRST_DRAFT_PREFIX} because AI drafting is turned off for this session.`,
        false,
      );
    case "provider_timeout":
      return disclose(
        `${FIRST_DRAFT_PREFIX} because the AI draft timed out${detail ? ` (${detail})` : ""}.`,
        true,
      );
    case "provider_failed":
      return disclose(
        `${FIRST_DRAFT_PREFIX} because the AI draft failed${detail ? ` (${detail})` : ""}.`,
        true,
      );
    case "listing_text_missing":
      // Not a model failure and not retryable: the AI was never asked because
      // there was no listing body. Retrying would change nothing.
      return {
        canRetryWithAi: false,
        message:
          "This listing's text was not captured, so the resume could not be tailored to it and keeps your original wording. Read the listing before applying, or apply with your original resume.",
        originSentence:
          "This listing's text was not captured, so the resume could not be tailored to it and keeps your original wording.",
      };
    case "listing_text_not_distinguishing":
      // Not a model failure and not retryable either: the listing carries
      // nothing the AI could tailor toward, so a retry produces the same
      // draft.
      return {
        canRetryWithAi: false,
        message:
          "This listing says almost nothing about the job itself, so the resume could not be tailored to it and keeps your original wording. Read the listing before applying, or apply with your original resume.",
        originSentence:
          "This listing says almost nothing about the job itself, so the resume could not be tailored to it and keeps your original wording.",
      };
    case "provider_output_unverified":
      return disclose(
        `${detail ?? "The AI draft's proposals could not be verified against your saved evidence"}${detail?.endsWith(".") ? "" : "."} ${FIRST_DRAFT_PREFIX} instead.`,
        true,
      );
    case null:
    case undefined:
      break;
  }

  const legacyOriginSentence = getDeterministicResumeFallbackOriginSentence(
    asset.notes,
  );
  // Retrying is offered for every note-derived fallback. The narrower prose
  // match dropped the escape hatch on exactly the assets whose reason was not
  // recorded, so the same draft explained itself one way before approval and
  // offered no way forward after it.
  return legacyOriginSentence ? disclose(legacyOriginSentence, true) : null;
}

function getDeterministicResumeFallbackOriginSentence(
  notes: readonly string[],
): string | null {
  const matchedNote = notes.find((note) =>
    DETERMINISTIC_FALLBACK_NOTE_PATTERN.test(note),
  );
  if (!matchedNote) {
    return null;
  }

  if (notes.some((note) => /timed out after \d+s/i.test(note))) {
    return `${FIRST_DRAFT_PREFIX} because the AI resume draft timed out.`;
  }

  return `${FIRST_DRAFT_PREFIX} instead of the AI draft.`;
}

export function getDeterministicResumeFallbackMessage(
  notes: readonly string[],
): string | null {
  const originSentence = getDeterministicResumeFallbackOriginSentence(notes);

  return originSentence ? `${originSentence} ${REVIEW_SUFFIX}` : null;
}

/**
 * One accepted assistant proposal is the clearest evidence that the AI did
 * help, and it must be visible on the page it changed. Counts the exact
 * patches the user accepted (never the proposed-but-rejected ones) and names
 * the revision an Undo restores, which is the pre-edit snapshot recorded by
 * the newest assistant patch.
 */
export interface AcceptedAssistantEditSummary {
  count: number;
  label: string;
  /** Section, entry, and bullet ids the accepted patches landed on. */
  changedTargetIds: readonly string[];
}

export function describeAcceptedAssistantEdits(
  messages: readonly ResumeAssistantMessage[],
  revisions?: readonly ResumeDraftRevision[],
): AcceptedAssistantEditSummary | null {
  const acceptedMessages = messages
    .filter(
      (message) =>
        message.role === "assistant" && message.proposalStatus === "accepted",
    )
    .sort((left, right) =>
      (left.resolvedAt ?? left.createdAt).localeCompare(
        right.resolvedAt ?? right.createdAt,
      ),
    );
  // Each accepted proposal wrote exactly one assistant revision, in the same
  // order. An edit that was undone, or that a full regeneration replaced, no
  // longer shapes the draft, so it is not counted or marked.
  const liveMessages = (() => {
    if (!revisions) {
      return acceptedMessages;
    }
    const assistantRevisions = listAssistantEditRevisions(revisions);
    const liveIds = new Set(listLiveAssistantEditRevisionIds(revisions));
    if (assistantRevisions.length === acceptedMessages.length) {
      return acceptedMessages.filter((_message, index) =>
        liveIds.has(assistantRevisions[index]!.id),
      );
    }
    // Older history without a one-to-one match: keep only edits accepted
    // after the latest full regeneration.
    const latestRegeneration = latestRegenerationAt(revisions);
    return acceptedMessages.filter(
      (message) =>
        !latestRegeneration ||
        (message.resolvedAt ?? message.createdAt) > latestRegeneration,
    );
  })();
  const acceptedPatches = liveMessages.flatMap((message) =>
    message.patches.filter((patch) =>
      message.resolvedPatchIds.includes(patch.id),
    ),
  );

  if (acceptedPatches.length === 0) {
    return null;
  }

  const changedTargetIds = Array.from(
    new Set(
      acceptedPatches.flatMap((patch) =>
        [
          patch.targetSectionId,
          patch.targetEntryId ?? null,
          patch.targetBulletId ?? null,
        ].filter((value): value is string => Boolean(value)),
      ),
    ),
  );

  return {
    count: acceptedPatches.length,
    label:
      acceptedPatches.length === 1
        ? "1 AI edit applied"
        : `${acceptedPatches.length} AI edits applied`,
    changedTargetIds,
  };
}

/**
 * One truthful provenance statement for the studio.
 *
 * The studio used to stack "1 AI edit applied" directly above "The configured
 * AI model returned no usable rewrite proposals. The first draft came from the
 * built-in generator instead", which reads as a contradiction. The two facts
 * are about different moments: who wrote the *first draft*, and what the user
 * has accepted from the Assistant *since*. They are now one sentence pair in
 * that order, with the review reminder last.
 */
export function describeResumeDraftProvenance(input: {
  acceptedAssistantEdits: AcceptedAssistantEditSummary | null;
  generationPath: ResumeGenerationPathDisclosure | null;
}): string | null {
  const edits = input.acceptedAssistantEdits;
  const generationPath = input.generationPath;

  if (!generationPath) {
    return edits
      ? `${edits.label}. The changed lines are marked in the preview.`
      : null;
  }

  if (!edits) {
    return generationPath.message;
  }

  const editsClause =
    edits.count === 1
      ? "1 assistant edit has been applied since"
      : `${edits.count} assistant edits have been applied since`;

  return `${generationPath.originSentence} ${editsClause}, and the changed lines are marked in the preview. ${REVIEW_SUFFIX}`;
}

/**
 * The AI edit an Undo removes: the newest accepted assistant patch that has
 * not been undone yet and that a full regeneration has not replaced. Undo
 * removes only that edit; later manual edits stay.
 */
export function findLatestAssistantEditRevisionId(
  revisions: readonly ResumeDraftRevision[],
): string | null {
  return listLiveAssistantEditRevisionIds(revisions).at(-1) ?? null;
}

/**
 * Accepted AI edits that still shape the draft, oldest first: not undone and
 * not replaced by a later full regeneration.
 */
function listLiveAssistantEditRevisionIds(
  revisions: readonly ResumeDraftRevision[],
): string[] {
  const undoneRevisionIds = new Set(
    revisions
      .map((revision) => revision.restoredFromRevisionId)
      .filter((id): id is string => Boolean(id)),
  );
  const latestRegeneration = latestRegenerationAt(revisions);
  return listAssistantEditRevisions(revisions)
    .filter(
      (revision) =>
        !undoneRevisionIds.has(revision.id) &&
        (!latestRegeneration || revision.createdAt > latestRegeneration),
    )
    .map((revision) => revision.id);
}

function latestRegenerationAt(
  revisions: readonly ResumeDraftRevision[],
): string | undefined {
  return revisions
    .filter((revision) => revision.mutationKind === "regenerate_draft")
    .map((revision) => revision.createdAt)
    .sort()
    .at(-1);
}

function listAssistantEditRevisions(
  revisions: readonly ResumeDraftRevision[],
): ResumeDraftRevision[] {
  return revisions
    .filter((revision) => revision.mutationKind === "assistant_patch")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not set";
  }

  return new Date(value).toLocaleString();
}

export function formatOptionalDate(
  value: string | null,
  fallback?: string | null,
): string {
  if (value) {
    return new Date(value).toLocaleDateString();
  }

  return fallback ?? "Unknown";
}

/**
 * Export stays blocked until confirm_needed rows are owned and unsupported
 * rows are gone. The copy says that plainly so the studio never asks the
 * person to "ground" a line they are meant to confirm.
 */
export function describeResumeExportClaimBlock(input: {
  blockingAssessments: readonly Pick<ResumeClaimAssessment, "status">[];
}): string | null {
  const count = input.blockingAssessments.length;
  if (count === 0) {
    return null;
  }

  return count === 1
    ? "1 line needs your decision before this resume can be approved."
    : `${count} lines need your decision before this resume can be approved.`;
}

export function resumeExportClaimBlockActionLabel(input: {
  blockingAssessments: readonly Pick<ResumeClaimAssessment, "status">[];
}): string {
  const count = input.blockingAssessments.length;
  return count === 1 ? "Review 1 line" : `Review ${count} lines`;
}

export function cloneDraft(draft: ResumeDraft): ResumeDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      bullets: section.bullets.map((bullet) => ({
        ...bullet,
        sourceRefs: [...bullet.sourceRefs],
      })),
      entries: section.entries.map((entry) => ({
        ...entry,
        bullets: entry.bullets.map((bullet) => ({
          ...bullet,
          sourceRefs: [...bullet.sourceRefs],
        })),
        sourceRefs: [...entry.sourceRefs],
      })),
      sourceRefs: [...section.sourceRefs],
    })),
  };
}

/**
 * The person's newest Assistant request when the reply to it changed nothing
 * (no proposal), so a route that makes the draft editable can send it again
 * instead of making the person retype it.
 */
export function findUnansweredAssistantRequest(
  messages: readonly Pick<
    ResumeAssistantMessage,
    "role" | "content" | "patches"
  >[],
): string | null {
  const reply = messages.at(-1);
  const request = messages.at(-2);
  if (
    !reply ||
    !request ||
    reply.role !== "assistant" ||
    reply.patches.length > 0 ||
    request.role !== "user"
  ) {
    return null;
  }
  return request.content.trim() || null;
}

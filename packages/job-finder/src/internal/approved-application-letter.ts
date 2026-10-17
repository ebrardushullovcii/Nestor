import {
  createApplyPageHands,
  replaceApprovedApplicationLetter,
} from "@nestor/browser-agent";
import {
  buildPreparationResult,
  type ExecuteApplicationFlowInput,
} from "@nestor/browser-runtime";
import {
  ApplicationReviewCardSchema,
  ApplyJobResultSchema,
  type ApplicationDocumentRevision,
  type ApplicationReviewCard,
} from "@nestor/contracts";
import {
  buildApplyLetterDependencies,
  toApplyLlmClient,
} from "./agent-application-preparation";
import { createApplicationLetterProvider } from "./application-letter-provider";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/** Approval never claims to have changed a form until the guarded replacement succeeds. */
export async function refreshApprovedApplicationLetter(
  ctx: WorkspaceServiceContext,
  document: ApplicationDocumentRevision,
  resolveInput: () => Promise<
    Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">
  >,
): Promise<void> {
  if (document.kind !== "cover_letter" || document.status === "proposed")
    return;
  const result = (
    await ctx.repository.listApplyJobResults({
      applicationRecordId: document.job.applicationRecordId,
    })
  )
    .filter((entry) => entry.jobId === document.job.jobId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const card = result?.reviewCard;
  if (
    !result ||
    !card?.letter ||
    result.state !== "awaiting_review" ||
    result.privacyReceipt?.finalSubmitOccurred ||
    result.privacyReceipt?.submissionOutcome
  )
    return;
  const save = async (reviewCard: ApplicationReviewCard) => {
    const current = (
      await ctx.repository.listApplyJobResults({
        applicationRecordId: document.job.applicationRecordId,
      })
    ).find((entry) => entry.id === result.id);
    if (
      !current ||
      current.state !== "awaiting_review" ||
      current.privacyReceipt?.finalSubmitOccurred ||
      current.privacyReceipt?.submissionOutcome
    )
      return;
    await ctx.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        ...current,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
        ).toISOString(),
        reviewCard,
      }),
    );
  };
  if (card.letter.text === document.content && !card.letter.needsRefresh) {
    await save({ ...card, letter: { ...card.letter, needsRefresh: false } });
    return;
  }
  await save({ ...card, letter: { ...card.letter, needsRefresh: true } });
  const runtime = ctx.browserRuntime;
  try {
    if (
      !runtime.hasApplicationPageBinding ||
      !card.pageUrl ||
      !card.letter.fields?.length ||
      !(await runtime.hasApplicationPageBinding(
        (await ctx.repository.listSavedJobs()).find(
          (job) => job.id === result.jobId,
        )?.source ?? "target_site",
        result.id,
      ))
    )
      return;
    const facts = await resolveInput();
    const client = toApplyLlmClient(ctx.aiClient);
    const dependencies = buildApplyLetterDependencies({
      aiClient: ctx.aiClient,
      documentManager: ctx.documentManager,
      job: facts.job,
      profile: facts.profile,
      settings: facts.settings,
    });
    if (!client || !dependencies) return;
    let replaced: ApplicationReviewCard | null = null;
    await runtime.executeApplicationFlow(facts.job.source, {
      ...facts,
      applicationPageBindingKey: result.id,
      startingUrl: card.pageUrl,
      mode: "prepare_only",
      applyAutomationMode: "prepare_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      prepareApplicationForm: async ({ session, startedAt }) => {
        const now = () => new Date();
        await session.installPrepareOnlyGuard({
          intermediateMutationsAuthorized:
            facts.intermediateMutationsAuthorized === true,
          allowedOrigins: facts.applyAllowedOrigins ?? [
            new URL(card.pageUrl!).origin,
          ],
        });
        const outcome = await replaceApprovedApplicationLetter({
          client,
          fields: card.letter!.fields!,
          config: {
            hands: createApplyPageHands(session, now),
            safety: session,
            now,
            intermediateWritesAuthorized:
              facts.intermediateMutationsAuthorized === true,
            authority: {
              mode: "prepare_only",
              submitAuthorized: false,
              preApprovedAttestationKinds: [],
              salaryDisclosure: "pause_for_user",
              allowedOrigins: facts.applyAllowedOrigins ?? [
                new URL(card.pageUrl!).origin,
              ],
            },
            sources: {
              profile: facts.profile,
              resumeText: facts.profile.baseResume.textContent,
              posting: facts.job,
              reusableAnswers: [],
              documents: [],
              approvedLetterText: document.content,
            },
            application: {
              jobId: facts.job.id,
              applicationId: document.job.applicationRecordId,
              applicationRecordId: document.job.applicationRecordId,
              resultId: result.id,
              startingUrl: card.pageUrl!,
            },
            siteLabel: card.siteLabel,
            letters: createApplicationLetterProvider({
              ...dependencies,
              application: {
                jobId: facts.job.id,
                applicationId: document.job.applicationRecordId,
              },
            }),
          },
        });
        if (outcome) {
          replaced = ApplicationReviewCardSchema.parse({
            ...card,
            answers: card.answers.map((answer) => {
              const filled = outcome.filled.find(
                (entry) => entry.label === answer.question,
              );
              return filled
                ? {
                    ...answer,
                    answer: filled.answer.value,
                    source: filled.answer.provenanceLabel,
                    written: false,
                    groundedIn: filled.answer.groundedIn,
                  }
                : answer;
            }),
            attachments: card.attachments.map((attachment) => {
              const attached = outcome.attachments.find(
                (entry) => entry.controlLabel === attachment.field,
              );
              return attached
                ? {
                    ...attachment,
                    label: attached.label,
                    fileName: attached.fileName,
                  }
                : attachment;
            }),
            letter: {
              ...card.letter,
              text: document.content,
              groundedIn: ["your approved letter"],
              needsRefresh: false,
            },
          });
        }
        return buildPreparationResult({
          executionInput: facts,
          state: "ready",
          summary: "Letter approval saved",
          detail: "Nothing was sent.",
          questions: [],
          blocker: null,
          checkpoints: [],
          checkpointLabel: "Letter approval saved",
          checkpointDetail: "Nothing was sent.",
          checkpointUrls: [card.pageUrl!],
          lastUrl: card.pageUrl,
          now: startedAt,
          nextActionLabel: "Review it before sending",
        });
      },
    });
    // A newer approval can land while rendering or the browser is busy.
    const approved = await ctx.documentManager.getApprovedApplicationLetter?.(
      result.jobId,
      document.job.applicationRecordId,
    );
    if (replaced && (!approved || approved.content === document.content))
      await save(replaced);
  } catch {
    // Keep the inline warning and require re-preparation; approval itself succeeded.
  }
}

import {
  buildCoverLetterRequest,
  looksLikeUsableLetter,
} from "@nestor/browser-agent";
import { ApplicationLetterGroundingError } from "./application-letter-provider";
import { buildApplyLetterDependencies } from "./agent-application-preparation";
import { readSavedJob } from "./read-saved-job";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Writes the text of a letter or written answer the person drafts from
 * Applications, with the same writer and grounding rules the apply agent uses
 * for the letter it sends. Returns null when no model is available or the
 * reply is not a usable document; the caller reports the failure and keeps
 * existing drafts.
 */
export async function writeApplicationDocumentText(
  ctx: WorkspaceServiceContext,
  input: {
    jobId: string;
    kind: "cover_letter" | "short_response";
    questionPrompt: string | null;
    priorText: string | null;
  },
): Promise<string | null> {
  const [job, profile, settings, searchPreferences] = await Promise.all([
    readSavedJob(ctx.repository, input.jobId),
    ctx.repository.getProfile(),
    ctx.repository.getSettings(),
    ctx.repository.getSearchPreferences(),
  ]);
  if (!job) {
    return null;
  }
  const letters = buildApplyLetterDependencies({
    aiClient: ctx.aiClient,
    documentManager: ctx.documentManager,
    job,
    profile,
    settings,
    searchPreferences,
  });
  if (!letters) {
    return null;
  }
  const request = buildCoverLetterRequest({
    sources: {
      profile,
      preferences: searchPreferences,
      resumeText: profile.baseResume.textContent ?? null,
      posting: {
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
      },
      reusableAnswers: [],
      documents: [],
    },
    preference: letters.preference,
  });
  const prompt =
    input.kind === "short_response"
      ? [
          `Answer this question from the ${job.title} application at ${job.company} in the first person: ${input.questionPrompt ?? "Why do you want this role?"}`,
          "Three to five sentences. Only facts from the resume and profile; the posting is context, not evidence of the person's experience. Return only the answer.",
        ].join("\n")
      : request.prompt;
  try {
    const written = await letters.writeLetter({
      prompt,
      purpose:
        input.kind === "short_response"
          ? "supporting_statement"
          : "cover_letter",
      groundedIn: request.groundedIn,
      language: request.language,
      preference: letters.preference,
      priorText: input.priorText,
    });
    const text = written?.trim() ?? "";
    if (input.kind === "cover_letter" && !looksLikeUsableLetter(text)) {
      return null;
    }
    return text.length > 0 && text.length <= 12_000 ? text : null;
  } catch (error) {
    if (error instanceof ApplicationLetterGroundingError) throw error;
    throw new Error(
      "Job Finder could not write this draft right now. Try again.",
    );
  }
}

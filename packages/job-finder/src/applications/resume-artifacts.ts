import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ApplicationResumeArtifactSchema,
  type ApplicationResumeArtifact,
  type CandidateProfile,
  type StoredResume,
  type SavedJob,
  type JobFinderSettings,
} from "@nestor/contracts";
import type {
  JobFinderDocumentManager,
  RenderedLetterArtifact,
} from "../internal/workspace-service-contracts";
import { buildResumeRenderDocument } from "../internal/resume-workspace-structure";

/** The same identity and byte check for Apply, recovery and diagnostics. */
export async function loadOriginalResumeBytes(
  resume: CandidateProfile["baseResume"],
): Promise<Uint8Array> {
  if (!resume.id || !resume.storagePath || !resume.sha256)
    throw new Error("Original resume unavailable. Import it again.");
  const bytes = await readFile(resume.storagePath);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    resume.sha256.toLowerCase()
  )
    throw new Error("Original resume changed. Import it again.");
  return bytes;
}

/** Identifies this approval of this job's PDF, never a legacy export. */
export function approvedJobResumeIdentity(resume: StoredResume): string {
  if (
    resume.state !== "ready" ||
    !resume.approvedAt ||
    !resume.pdfPath ||
    !resume.pdfSha256
  )
    throw new Error("Approved resume unavailable");
  return `job_resume:${resume.jobId}:${resume.approvedAt}:${resume.pdfSha256.toLowerCase()}`;
}

export async function loadApprovedJobResumeBytes(
  resume: StoredResume,
  identity: string,
  digest: string,
): Promise<Uint8Array> {
  if (
    approvedJobResumeIdentity(resume) !== identity ||
    resume.pdfSha256?.toLowerCase() !== digest
  )
    throw new Error("Approved resume changed");
  const bytes = await readFile(resume.pdfPath!);
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error("Attachment changed");
  return bytes;
}

/** The identity of a ready resume Apply rendered without an approval. */
const DRAFT_RESUME_PREFIX = "job_resume_draft:";

const sha256Of = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A ready resume the person has not approved, rendered for this application
 * the way approval renders it: the same words, template and PDF renderer. A
 * continuation keeps the file it already attached while the words match.
 */
export async function renderReadyJobResume(input: {
  resume: StoredResume;
  profile: CandidateProfile;
  job: SavedJob;
  settings: JobFinderSettings;
  documentManager: JobFinderDocumentManager;
  existingArtifact?: ApplicationResumeArtifact | null;
  signal?: AbortSignal;
}): Promise<ApplicationResumeArtifact> {
  const { resume } = input;
  if (resume.state !== "ready" || !resume.draft)
    throw new Error("This job's resume is still being written.");
  const renderDocument = buildResumeRenderDocument(input.profile, resume.draft);
  const templateId = resume.draft.templateId;
  const id = `resume_${resume.jobId}_draft_${sha256Of(JSON.stringify({ renderDocument, templateId }))}`;
  const existing = input.existingArtifact;
  if (existing?.id === id && existing.sha256) {
    const bytes = await readFile(existing.filePath).catch(() => null);
    if (bytes && sha256Of(bytes) === existing.sha256) return existing;
  }
  const rendered = await input.documentManager.renderResumeArtifact({
    job: input.job,
    profile: input.profile,
    renderDocument,
    templateId,
    settings: { ...input.settings, resumeFormat: "pdf" },
    purpose: "application",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (
    rendered.format !== "pdf" ||
    !rendered.storagePath ||
    !rendered.fileName ||
    !rendered.sha256
  )
    throw new Error("The resume could not be rendered as PDF.");
  return ApplicationResumeArtifactSchema.parse({
    id,
    jobId: String(resume.jobId),
    source: "tailored_export",
    sourceDocumentId: null,
    exportArtifactId: `${DRAFT_RESUME_PREFIX}${resume.jobId}:${rendered.sha256.toLowerCase()}`,
    fileName: rendered.fileName,
    filePath: rendered.storagePath,
    sha256: rendered.sha256,
    approvedAt: null,
    level: resume.level,
  });
}

/** Whether a prepared form's resume file is one Apply rendered from an unapproved draft. */
export function isReadyJobResumeIdentity(id: string): boolean {
  return id.startsWith(DRAFT_RESUME_PREFIX);
}

/** Render the resume's words once; format conversion never calls the writer. */
export async function renderApplicationResume(input: {
  artifact: ApplicationResumeArtifact;
  resume: StoredResume;
  profile: CandidateProfile;
  job: SavedJob;
  settings: JobFinderSettings;
  documentManager: JobFinderDocumentManager;
  existingArtifact?: ApplicationResumeArtifact | null;
  signal?: AbortSignal;
}): Promise<{
  artifact: ApplicationResumeArtifact;
  docx: RenderedLetterArtifact | null;
}> {
  const originalText = input.profile.baseResume.textContent?.trim();
  const renderDocument = input.resume.draft
    ? buildResumeRenderDocument(input.profile, input.resume.draft)
    : originalText
      ? {
          // Original keeps the complete imported text, including its identity.
          fullName: "",
          headline: null,
          location: null,
          contactItems: [],
          sections: [
            {
              id: "original",
              kind: "summary" as const,
              label: "",
              text: originalText,
              bullets: [],
              entries: [],
            },
          ],
        }
      : null;
  let artifact = input.artifact;
  if (!/\.pdf$/iu.test(artifact.fileName)) {
    if (!renderDocument)
      throw new Error("The resume has no readable content to render as PDF.");
    const templateId =
      input.resume.draft?.templateId ?? input.settings.resumeTemplateId;
    const identity = `${artifact.id}_pdf_${createHash("sha256").update(JSON.stringify({ renderDocument, templateId })).digest("hex")}`;
    const existing = input.existingArtifact;
    const existingBytes =
      existing?.id === identity && existing.approvedAt === artifact.approvedAt
        ? await readFile(existing.filePath).catch(() => null)
        : null;
    if (
      existing &&
      existingBytes &&
      createHash("sha256").update(existingBytes).digest("hex") ===
        existing.sha256
    ) {
      artifact = existing;
    } else {
      const rendered = await input.documentManager.renderResumeArtifact({
        job: input.job,
        profile: input.profile,
        renderDocument,
        templateId,
        settings: { ...input.settings, resumeFormat: "pdf" },
        purpose: "application",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        rendered.format !== "pdf" ||
        !rendered.storagePath ||
        !rendered.fileName ||
        !rendered.sha256
      )
        throw new Error("The resume could not be rendered as PDF.");
      artifact = {
        ...artifact,
        id: identity,
        fileName: rendered.fileName,
        filePath: rendered.storagePath,
        sha256: rendered.sha256,
      };
    }
  }
  const docx =
    renderDocument && input.documentManager.renderResumeDocxArtifact
      ? await input.documentManager.renderResumeDocxArtifact({
          renderDocument,
          profile: input.profile,
        })
      : null;
  return { artifact, docx };
}

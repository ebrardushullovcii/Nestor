import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ApplicationResumeArtifact,
  CandidateProfile,
  StoredResume,
  SavedJob,
  JobFinderSettings,
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

/** Render the approved words once; format conversion never calls the writer. */
export async function renderApplicationResume(input: {
  artifact: ApplicationResumeArtifact;
  approved: StoredResume;
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
  const renderDocument = input.approved.draft
    ? buildResumeRenderDocument(input.profile, input.approved.draft)
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
      throw new Error(
        "The approved resume has no readable content to render as PDF.",
      );
    const templateId =
      input.approved.draft?.templateId ?? input.settings.resumeTemplateId;
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
        throw new Error("The approved resume could not be rendered as PDF.");
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

/** A format copy keeps the same approved source even though its path differs. */
export async function applicationResumeSourceStillApproved(
  artifact: ApplicationResumeArtifact,
  approved: StoredResume,
  profile: CandidateProfile,
): Promise<boolean> {
  if (approved.approvedAt !== artifact.approvedAt) return false;
  if (artifact.source === "original_upload") {
    if (
      approved.pdfPath !== null ||
      profile.baseResume.id !== artifact.sourceDocumentId
    )
      return false;
    await loadOriginalResumeBytes(profile.baseResume);
    return true;
  }
  if (artifact.exportArtifactId !== approvedJobResumeIdentity(approved))
    return false;
  await loadApprovedJobResumeBytes(
    approved,
    artifact.exportArtifactId,
    approved.pdfSha256!.toLowerCase(),
  );
  return true;
}

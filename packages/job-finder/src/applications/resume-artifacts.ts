import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CandidateProfile, StoredResume } from "@nestor/contracts";

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

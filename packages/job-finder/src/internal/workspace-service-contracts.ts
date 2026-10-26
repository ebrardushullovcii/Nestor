import type {
  ApplicationDocumentRevision,
  ApplicationQuestionRecord,
  ApplicationRecord,
  CandidateAsset,
  CandidateAssetListInput,
  CandidateAssetListResult,
  CandidateProfile,
  JobFinderResumePreview,
  JobFinderSettings,
  ResumeResearchArtifact,
  ResumeTemplateDefinition,
  ResumeTemplateId,
  SavedJob,
} from "@nestor/contracts";
import type { ResumeRenderDocument } from "./resume-workspace-structure";

export interface RenderedResumeArtifact {
  fileName: string | null;
  storagePath: string | null;
  sha256?: string | null;
  format: "html" | "pdf";
  intermediateFileName?: string | null;
  intermediateStoragePath?: string | null;
  pageCount?: number | null;
  warnings?: readonly string[];
}

export interface JobFinderDocumentManager {
  /** Drops replaced managed exports after their references have committed. */
  pruneGeneratedResumeFiles?(): Promise<void>;
  /** Releases an unpersisted PDF/HTML produced only to measure a draft. */
  discardResumeArtifact?(artifact: RenderedResumeArtifact): Promise<void>;
  listResumeTemplates(): readonly ResumeTemplateDefinition[];
  renderResumePreview(
    input: {
      job: SavedJob;
      profile: CandidateProfile;
      renderDocument: ResumeRenderDocument;
      templateId: ResumeTemplateId;
      settings: JobFinderSettings;
    },
    signal?: AbortSignal,
  ): Promise<{
    html: string;
    pageCount?: JobFinderResumePreview["metadata"]["pageCount"];
    warnings?: readonly string[];
  }>;
  renderResumeArtifact(input: {
    job: SavedJob;
    profile: CandidateProfile;
    renderDocument: ResumeRenderDocument;
    templateId: ResumeTemplateId;
    settings: JobFinderSettings;
    targetPath?: string | null;
    onQueueWait?: (milliseconds: number) => void;
    signal?: AbortSignal;
  }): Promise<RenderedResumeArtifact>;
  /**
   * Renders a cover or motivation letter to a file, through the same path the
   * resume export uses, and puts it beside that resume.
   *
   * Optional: a runtime that cannot render one leaves a form asking for a
   * letter file to the person rather than sending something else.
   */
  /** Reads the latest approved letter, including an earlier approved revision. */
  getApprovedApplicationLetter?(
    jobId: string,
    applicationRecordId?: string,
  ): Promise<ApplicationDocumentRevision | null>;
  /**
   * Keeps a letter the person wrote or accepted while answering a form's
   * letter question as this application's approved letter.
   */
  saveApprovedApplicationLetter?(input: {
    profile: CandidateProfile;
    job: SavedJob;
    applicationRecord: ApplicationRecord;
    question: ApplicationQuestionRecord;
    text: string;
  }): Promise<void>;
  renderLetterArtifact?(input: {
    text: string;
    job: SavedJob;
    profile: CandidateProfile;
    settings: JobFinderSettings;
    /** A type the form insisted on. Null means the renderer may choose. */
    fileType: "pdf" | "docx" | "txt" | null;
  }): Promise<RenderedLetterArtifact>;
}

/** A letter rendered to a file, with the exact bytes that were written. */
export type RenderedLetterArtifact =
  | {
      ok: true;
      fileName: string;
      mimeType: string;
      storagePath: string;
      sha256: string;
    }
  | { ok: false; reason: string };

export interface ResumeResearchAdapterInput {
  job: SavedJob;
  profile: CandidateProfile;
}

export interface ResumeResearchAdapter {
  fetchResearchPages(
    input: ResumeResearchAdapterInput,
  ): Promise<readonly ResumeResearchArtifact[]>;
}

export interface ResolvedApplicationCandidateAsset {
  asset: CandidateAsset;
  loadVerifiedBytes: () => Promise<Uint8Array>;
}

export interface CandidateAssetResolver {
  /** Lists assets the local library may offer to an application. */
  list?(input: CandidateAssetListInput): Promise<CandidateAssetListResult>;
  resolveForApplication(
    assetId: string,
  ): Promise<ResolvedApplicationCandidateAsset>;
}

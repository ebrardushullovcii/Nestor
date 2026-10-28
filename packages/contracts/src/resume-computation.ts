import type { CandidateProfile } from "./profile";
import type { JobFinderSettings } from "./workspace";
import type { ResumeTemplateId } from "./base";
import type { ResumePreviewIdentityField } from "./resume-preview-targets";
import type { SavedJob } from "./discovery";
import type {
  ResumeDraft,
  ResumeDraftRevision,
  ResumeDraftRevisionActor,
  ResumeDraftRevisionMutationKind,
  ResumeValidationResult,
  ResumeDraftSection,
} from "./resume";

export interface ResumeRenderSectionEntry {
  id: string;
  title: string | null;
  subtitle: string | null;
  location: string | null;
  dateRange: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  heading: string | null;
  summary: string | null;
  bullets: Array<{ id: string; text: string }>;
}

export interface ResumeRenderSection {
  id: string;
  kind: ResumeDraftSection["kind"];
  label: string;
  text: string | null;
  bullets: Array<{ id: string; text: string }>;
  entries: ResumeRenderSectionEntry[];
}

export interface ResumeRenderDocument {
  fullName: string;
  headline: string | null;
  location: string | null;
  contactItems: Array<{ field: ResumePreviewIdentityField; text: string }>;
  includePreviewAnchors?: boolean;
  sections: ResumeRenderSection[];
}

export interface ResumeHtmlRenderInput {
  renderDocument: ResumeRenderDocument;
  settings: JobFinderSettings;
  templateId: ResumeTemplateId;
}

export interface ResumeHtmlRenderResult {
  previewHtml: string;
  exportHtml: string;
}

export interface ResumePdfInspection {
  pageCount: number;
  /** Text extent on the last PDF page, relative to its printable height. */
  lastPageFillRatio?: number | null;
  sha256: string;
}

export interface ResumeDraftSanitizationInput {
  draft: ResumeDraft;
  job: SavedJob;
  profile?: CandidateProfile;
  sourceSkills?: readonly string[];
}

export interface ResumeDraftValidationInput {
  draft: ResumeDraft;
  job: SavedJob;
  profile?: CandidateProfile;
  pageCount?: number | null;
  validatedAt?: string;
}

export interface ResumeDraftProcessor {
  parse(draft: unknown): Promise<ResumeDraft>;
  sanitize(input: ResumeDraftSanitizationInput): Promise<ResumeDraft>;
  validate(input: ResumeDraftValidationInput): Promise<ResumeValidationResult>;
  stateHash(draft: ResumeDraft): Promise<string>;
  revision(input: ResumeDraftRevisionInput): Promise<ResumeDraftRevision>;
  close(): Promise<void>;
  render(input: ResumeHtmlRenderInput): Promise<ResumeHtmlRenderResult>;
  inspectPdf(filePath: string): Promise<ResumePdfInspection>;
}

export interface ResumeDraftRevisionInput {
  draft: ResumeDraft;
  resultingDraft: ResumeDraft;
  createdAt: string;
  parentRevisionId?: string | null;
  actor: ResumeDraftRevisionActor;
  mutationKind: ResumeDraftRevisionMutationKind;
  restoredFromRevisionId?: string | null;
  reason?: string | null;
}

export type ResumeComputationRequest = { id: number } & (
  | { kind: "sanitize"; input: ResumeDraftSanitizationInput }
  | { kind: "validate"; input: ResumeDraftValidationInput }
  | { kind: "stateHash"; input: ResumeDraft }
  | { kind: "parse"; input: unknown }
  | { kind: "revision"; input: ResumeDraftRevisionInput }
  | { kind: "render"; input: ResumeHtmlRenderInput }
  | { kind: "inspectPdf"; input: string }
);

export type ResumeComputationResponse = { id: number } & (
  | { kind: "sanitize"; result: ResumeDraft }
  | { kind: "validate"; result: ResumeValidationResult }
  | { kind: "stateHash"; result: string }
  | { kind: "parse"; result: ResumeDraft }
  | { kind: "revision"; result: ResumeDraftRevision }
  | { kind: "render"; result: ResumeHtmlRenderResult }
  | { kind: "inspectPdf"; result: ResumePdfInspection }
  | { kind: "error"; message: string }
);

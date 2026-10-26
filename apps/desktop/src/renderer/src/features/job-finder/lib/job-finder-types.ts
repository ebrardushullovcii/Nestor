import type {
  CandidateAnswerKind,
  CandidateLinkKind,
  CandidateReusableAnswer,
  JobSourceAdapterKind,
  SourceInstructionStatus,
  WorkMode,
} from "@nestor/contracts";

export type JobFinderScreen =
  | "home"
  | "profile"
  | "discovery"
  | "review-queue"
  | "applications"
  | "actions"
  | "settings";

/**
 * Typed result of starting an employer-application batch queue. Curation is
 * consumed only on `confirmed`; every other status preserves the exact
 * staged selection so a refusal, handled backend failure, or unknown ending
 * can never silently discard the user's review work.
 */
export type JobFinderAutoApplyQueueStartOutcome =
  | { status: "confirmed" }
  | {
      status: "refused";
      reason:
        | "work_paused"
        | "empty_selection"
        | "cancelled_stayed_in_workspace";
      message: string | null;
    }
  | { status: "failed"; message: string | null }
  | { status: "unknown" };

export interface ScreenDefinition {
  id: JobFinderScreen;
  label: string;
  count: number | null;
}

export type ExperienceFormEntry = {
  id: string;
  companyName: string;
  companyUrl: string;
  title: string;
  employmentType: string;
  location: string;
  workMode: WorkMode[];
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  summary: string;
  achievements: string;
  skills: string;
  domainTags: string;
  peopleManagementScope: string;
  ownershipScope: string;
  sourceCandidateId?: string | null;
  sourceCandidateFingerprint?: string | null;
};

export type EducationFormEntry = {
  id: string;
  schoolName: string;
  degree: string;
  fieldOfStudy: string;
  location: string;
  startDate: string;
  endDate: string;
  summary: string;
  sourceCandidateId?: string | null;
  sourceCandidateFingerprint?: string | null;
};

export type CertificationFormEntry = {
  id: string;
  name: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  credentialUrl: string;
};

export type LinkFormEntry = {
  id: string;
  label: string;
  url: string;
  kind: CandidateLinkKind | "";
};

export type ProjectFormEntry = {
  id: string;
  name: string;
  projectType: string;
  summary: string;
  role: string;
  skills: string;
  outcome: string;
  projectUrl: string;
  repositoryUrl: string;
  caseStudyUrl: string;
};

export type LanguageFormEntry = {
  id: string;
  language: string;
  proficiency: string;
  interviewPreference: boolean;
  notes: string;
};

export type ProofBankEntryFormEntry = {
  id: string;
  title: string;
  claim: string;
  heroMetric: string;
  supportingContext: string;
  roleFamilies: string;
  projectIds: string;
  linkIds: string;
};

export type ReusableAnswerFormEntry = {
  needsConfirmation?: boolean;
  applicationScope?: CandidateReusableAnswer["applicationScope"];
  id: string;
  label: string;
  question: string;
  answer: string;
  kind: CandidateAnswerKind;
  roleFamilies: string;
  proofEntryIds: string;
};

export type DiscoveryTargetEditorValue = {
  id: string;
  label: string;
  startingUrl: string;
  enabled: boolean;
  adapterKind: JobSourceAdapterKind;
  customInstructions: string;
  instructionStatus: SourceInstructionStatus;
  validatedInstructionId: string | null;
  draftInstructionId: string | null;
  lastDebugRunId: string | null;
  lastVerifiedAt: string | null;
  staleReason: string | null;
};

export type BooleanSelectValue = "" | "yes" | "no";

export type BadgeTone =
  | "active"
  | "critical"
  | "muted"
  | "neutral"
  | "positive"
  /**
   * Attention that is not yet a failure: a blocked claim, a pending
   * work-history decision, a paused run awaiting the user. Before this member
   * existed those states borrowed `critical` (overstating them) or `neutral`
   * (hiding them), while `--warning-text` was used by nothing.
   */
  | "warning";

export interface ActionState {
  message: string | null;
  /**
   * What the message reports: `success` (the action finished as asked),
   * `failure` (it was refused or failed and the person may need to act), or
   * `progress` (still running). A success may become a toast; a failure and
   * a message without a tone always stay inline (ADR 0042).
   */
  tone?: "success" | "failure" | "progress" | null;
  toastTone?: "success" | "warning";
  /**
   * A file this action just wrote, when the message names its path. The
   * surface that prints the message offers "Open folder" beside it, so the
   * path is an action rather than something to retype.
   */
  savedFilePath?: string | null;
  /** Where the message's natural next step lives, offered beside it. */
  actionLink?: { label: string; route: string } | null;
  /** Puts back what a quick action took away; the toast offers Undo. */
  undo?: (() => void) | null;
  /** The Undo button's words; "Undo all" after a move of many jobs. */
  undoLabel?: string | null;
}

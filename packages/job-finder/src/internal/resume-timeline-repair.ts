import {
  CandidateExperienceSchema,
  CandidateProfileSchema,
  ResumeImportRunSchema,
  ResumeTimelineRepairProposalSchema,
  type CandidateExperience,
  type CandidateProfile,
  type ResumeImportFieldCandidate,
  type ResumeImportRun,
  type ResumeTimelineRepairAction,
  type ResumeTimelineRepairEvidence,
  type ResumeTimelineRepairIssueKind,
  type ResumeTimelineRepairProposal,
} from "@nestor/contracts";

import type { JobFinderRepository } from "@nestor/db";

import { isObject } from "./resume-import-common";
import { normalizeText, uniqueStrings } from "./shared";

type ExperienceSource = {
  candidate: ResumeImportFieldCandidate;
  record: CandidateExperience;
  evidence: ResumeTimelineRepairEvidence;
};

type ProposalDraft = Omit<
  ResumeTimelineRepairProposal,
  "id" | "runId" | "status" | "createdAt" | "resolvedAt" | "actionHistory"
>;

const ISO_DATE_PATTERN = /^(\d{4})(?:-(\d{2}))?$/u;
const NUMERIC_DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/u;

function parseIsoMonth(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(ISO_DATE_PATTERN);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    return null;
  }
  return year * 12 + month - 1;
}

function hasAmbiguousDate(record: CandidateExperience): boolean {
  return [record.startDate, record.endDate].some((value) => {
    if (!value) {
      return false;
    }
    const numeric = value.trim().match(NUMERIC_DATE_PATTERN);
    if (numeric) {
      const first = Number(numeric[1]);
      const second = Number(numeric[2]);
      return first >= 1 && first <= 12 && second >= 1 && second <= 12;
    }
    return parseIsoMonth(value) === null;
  });
}

function normalizedIdentity(record: CandidateExperience): string {
  return [
    normalizeText(record.companyName ?? ""),
    normalizeText(record.title ?? ""),
    normalizeText(record.startDate ?? ""),
    normalizeText(record.endDate ?? ""),
  ].join("\u0000");
}

function comparableRecord(record: CandidateExperience): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "id"),
    ),
  );
}

function proposalId(
  runId: string,
  issueKind: ResumeTimelineRepairIssueKind,
  experienceIds: readonly string[],
): string {
  const suffix = [...experienceIds]
    .sort()
    .join("_")
    .replace(/[^a-zA-Z0-9_-]+/gu, "_")
    .slice(0, 160);
  return `timeline_repair_${runId}_${issueKind}_${suffix}`;
}

function buildEvidence(
  candidate: ResumeImportFieldCandidate,
): ResumeTimelineRepairEvidence | null {
  const excerpt =
    candidate.evidenceText?.trim() || candidate.valuePreview?.trim() || null;
  if (!excerpt) {
    return null;
  }
  return {
    candidateId: candidate.id,
    sourceBlockIds: uniqueStrings(candidate.sourceBlockIds),
    excerpt: excerpt.slice(0, 500),
  };
}

function collectExperienceSources(
  candidates: readonly ResumeImportFieldCandidate[],
): ExperienceSource[] {
  return candidates.flatMap((candidate) => {
    if (
      candidate.target.section !== "experience" ||
      candidate.target.key !== "record" ||
      candidate.resolution === "rejected" ||
      !isObject(candidate.value)
    ) {
      return [];
    }
    const parsed = CandidateExperienceSchema.safeParse(candidate.value);
    const evidence = buildEvidence(candidate);
    if (!parsed.success || !evidence) {
      return [];
    }
    return [{ candidate, record: parsed.data, evidence }];
  });
}

function buildProposal(
  runId: string,
  createdAt: string,
  draft: ProposalDraft,
): ResumeTimelineRepairProposal {
  return ResumeTimelineRepairProposalSchema.parse({
    ...draft,
    id: proposalId(runId, draft.issueKind, draft.affectedExperienceIds),
    runId,
    status: "pending",
    createdAt,
    resolvedAt: null,
    actionHistory: [],
  });
}

function reviewOnlyProposal(input: {
  issueKind: ResumeTimelineRepairIssueKind;
  title: string;
  explanation: string;
  sources: readonly ExperienceSource[];
}): ProposalDraft {
  const records = input.sources.map((source) => source.record);
  return {
    issueKind: input.issueKind,
    certainty: "review_only",
    title: input.title,
    explanation: input.explanation,
    affectedExperienceIds: records.map((record) => record.id),
    beforeExperiences: records,
    proposedExperiences: records,
    evidence: input.sources.map((source) => source.evidence),
  };
}

function canMergeSplitRecords(
  left: CandidateExperience,
  right: CandidateExperience,
): boolean {
  if (normalizedIdentity(left) !== normalizedIdentity(right)) {
    return false;
  }
  const scalarKeys: Array<keyof CandidateExperience> = [
    "companyUrl",
    "employmentType",
    "location",
    "isCurrent",
    "isDraft",
    "summary",
    "peopleManagementScope",
    "ownershipScope",
  ];
  return scalarKeys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function mergeSplitRecords(
  left: CandidateExperience,
  right: CandidateExperience,
): CandidateExperience {
  return CandidateExperienceSchema.parse({
    ...left,
    workMode: uniqueStrings([...left.workMode, ...right.workMode]),
    achievements: uniqueStrings([...left.achievements, ...right.achievements]),
    skills: uniqueStrings([...left.skills, ...right.skills]),
    domainTags: uniqueStrings([...left.domainTags, ...right.domainTags]),
  });
}

export function deriveResumeTimelineRepairProposals(input: {
  runId: string;
  candidates: readonly ResumeImportFieldCandidate[];
  createdAt: string;
}): ResumeTimelineRepairProposal[] {
  const sources = collectExperienceSources(input.candidates);
  const drafts: ProposalDraft[] = [];

  for (const source of sources) {
    const { record } = source;
    if (!record.companyName) {
      drafts.push(
        reviewOnlyProposal({
          issueKind: "missing_employer",
          title: `Review the missing employer for ${record.title ?? "this role"}`,
          explanation:
            "The source evidence did not yield an employer. No employer is guessed; confirm or edit the record manually.",
          sources: [source],
        }),
      );
    }
    if (!record.title) {
      drafts.push(
        reviewOnlyProposal({
          issueKind: "missing_title",
          title: `Review the missing title at ${record.companyName ?? "this employer"}`,
          explanation:
            "The source evidence did not yield a job title. No title is guessed; confirm or edit the record manually.",
          sources: [source],
        }),
      );
    }
    if (hasAmbiguousDate(record)) {
      drafts.push(
        reviewOnlyProposal({
          issueKind: "ambiguous_dates",
          title: `Review ambiguous dates for ${record.title ?? record.companyName ?? "this role"}`,
          explanation:
            "At least one extracted date has more than one plausible interpretation. The proposal preserves the source value instead of choosing a date format.",
          sources: [source],
        }),
      );
    } else {
      const start = parseIsoMonth(record.startDate);
      const end = parseIsoMonth(record.endDate);
      if (start !== null && end !== null && start > end) {
        drafts.push({
          issueKind: "reversed_dates",
          certainty: "deterministic_normalization",
          title: `Review reversed dates for ${record.title ?? record.companyName ?? "this role"}`,
          explanation:
            "The extracted start date is later than the extracted end date. Swapping the two cited values is reversible and introduces no new date.",
          affectedExperienceIds: [record.id],
          beforeExperiences: [record],
          proposedExperiences: [
            CandidateExperienceSchema.parse({
              ...record,
              startDate: record.endDate,
              endDate: record.startDate,
            }),
          ],
          evidence: [source.evidence],
        });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex];
      const right = sources[rightIndex];
      if (!left || !right) {
        continue;
      }
      if (comparableRecord(left.record) === comparableRecord(right.record)) {
        drafts.push({
          issueKind: "duplicate_record",
          certainty: "deterministic_normalization",
          title: `Review duplicate ${left.record.title ?? "experience"} records`,
          explanation:
            "These two extracted records contain the same normalized fields. The proposal keeps the first cited record and removes only the duplicate.",
          affectedExperienceIds: [left.record.id, right.record.id],
          beforeExperiences: [left.record, right.record],
          proposedExperiences: [left.record],
          evidence: [left.evidence, right.evidence],
        });
        continue;
      }
      if (canMergeSplitRecords(left.record, right.record)) {
        drafts.push({
          issueKind: "split_record",
          certainty: "deterministic_normalization",
          title: `Review split ${left.record.title ?? "experience"} records`,
          explanation:
            "The records share the same cited employer, title, and dates and differ only in list evidence. The proposal merges those cited lists without adding claims.",
          affectedExperienceIds: [left.record.id, right.record.id],
          beforeExperiences: [left.record, right.record],
          proposedExperiences: [mergeSplitRecords(left.record, right.record)],
          evidence: [left.evidence, right.evidence],
        });
      }
    }
  }

  const chronological = sources
    .filter(
      (source) =>
        parseIsoMonth(source.record.startDate) !== null &&
        parseIsoMonth(source.record.endDate) !== null &&
        parseIsoMonth(source.record.startDate)! <= parseIsoMonth(source.record.endDate)!,
    )
    .sort(
      (left, right) =>
        parseIsoMonth(left.record.startDate)! - parseIsoMonth(right.record.startDate)!,
    );
  for (let index = 1; index < chronological.length; index += 1) {
    const previous = chronological[index - 1];
    const current = chronological[index];
    if (!previous || !current || normalizedIdentity(previous.record) === normalizedIdentity(current.record)) {
      continue;
    }
    const previousEnd = parseIsoMonth(previous.record.endDate)!;
    const currentStart = parseIsoMonth(current.record.startDate)!;
    if (currentStart <= previousEnd) {
      drafts.push(
        reviewOnlyProposal({
          issueKind: "overlapping_dates",
          title: `Review overlapping dates between ${previous.record.title ?? "one role"} and ${current.record.title ?? "another role"}`,
          explanation:
            "The cited date ranges overlap. Concurrent roles can be valid, so no dates are changed automatically.",
          sources: [previous, current],
        }),
      );
    } else if (currentStart > previousEnd + 1) {
      drafts.push(
        reviewOnlyProposal({
          issueKind: "timeline_gap",
          title: `Review the timeline gap before ${current.record.title ?? current.record.companyName ?? "this role"}`,
          explanation:
            "The cited ranges leave a gap longer than one month. Gaps can be intentional, so no missing role or date is invented.",
          sources: [previous, current],
        }),
      );
    }
  }

  const byId = new Map<string, ResumeTimelineRepairProposal>();
  for (const draft of drafts) {
    const proposal = buildProposal(input.runId, input.createdAt, draft);
    if (!byId.has(proposal.id)) {
      byId.set(proposal.id, proposal);
    }
  }
  return [...byId.values()];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyExperienceDelta(input: {
  experiences: readonly CandidateExperience[];
  from: readonly CandidateExperience[];
  to: readonly CandidateExperience[];
  proposalTitle: string;
}): CandidateExperience[] {
  const fromById = new Map(input.from.map((record) => [record.id, record]));
  const toById = new Map(input.to.map((record) => [record.id, record]));
  const next = [...input.experiences];

  for (const [id, fromRecord] of fromById) {
    const currentIndex = next.findIndex((record) => record.id === id);
    const toRecord = toById.get(id);
    if (!toRecord) {
      if (currentIndex === -1 || !sameValue(next[currentIndex], fromRecord)) {
        throw new Error(
          `Experience '${id}' changed after this timeline proposal was created; '${input.proposalTitle}' was not applied.`,
        );
      }
      next.splice(currentIndex, 1);
      continue;
    }
    if (currentIndex === -1) {
      throw new Error(
        `Experience '${id}' changed after this timeline proposal was created; '${input.proposalTitle}' was not applied.`,
      );
    }
    const current = next[currentIndex]!;
    const patched: Record<string, unknown> = { ...current };
    for (const key of Object.keys(fromRecord) as Array<keyof CandidateExperience>) {
      if (sameValue(fromRecord[key], toRecord[key])) {
        continue;
      }
      if (!sameValue(current[key], fromRecord[key])) {
        throw new Error(
          `Experience '${id}' changed after this timeline proposal was created; '${input.proposalTitle}' was not applied.`,
        );
      }
      patched[key] = toRecord[key];
    }
    next[currentIndex] = CandidateExperienceSchema.parse(patched);
  }

  for (const [id, toRecord] of toById) {
    if (fromById.has(id)) {
      continue;
    }
    const existing = next.find((record) => record.id === id);
    if (existing && !sameValue(existing, toRecord)) {
      throw new Error(
        `Experience '${id}' changed after this timeline proposal was created; '${input.proposalTitle}' was not applied.`,
      );
    }
    if (!existing) {
      next.push(toRecord);
    }
  }

  return CandidateExperienceSchema.array().parse(next);
}

export function applyResumeTimelineRepairAction(input: {
  profile: CandidateProfile;
  proposals: readonly ResumeTimelineRepairProposal[];
  proposalId: string;
  action: ResumeTimelineRepairAction;
  occurredAt: string;
}): {
  profile: CandidateProfile;
  proposals: ResumeTimelineRepairProposal[];
} {
  const proposal = input.proposals.find((entry) => entry.id === input.proposalId);
  if (!proposal) {
    throw new Error(`Unknown timeline repair proposal '${input.proposalId}'.`);
  }

  let nextProfile = CandidateProfileSchema.parse(input.profile);
  let nextStatus = proposal.status;
  let resolvedAt = proposal.resolvedAt;

  if (input.action === "accept") {
    if (proposal.status !== "pending") {
      throw new Error(`Timeline proposal '${proposal.title}' must be pending before it can be accepted.`);
    }
    nextProfile = CandidateProfileSchema.parse({
      ...nextProfile,
      experiences: applyExperienceDelta({
        experiences: nextProfile.experiences,
        from: proposal.beforeExperiences,
        to: proposal.proposedExperiences,
        proposalTitle: proposal.title,
      }),
    });
    nextStatus = "accepted";
    resolvedAt = input.occurredAt;
  } else if (input.action === "reject") {
    if (proposal.status !== "pending") {
      throw new Error(`Timeline proposal '${proposal.title}' must be pending before it can be rejected.`);
    }
    nextStatus = "rejected";
    resolvedAt = input.occurredAt;
  } else {
    if (proposal.status === "pending") {
      throw new Error(`Timeline proposal '${proposal.title}' has no action to undo.`);
    }
    if (proposal.status === "accepted") {
      nextProfile = CandidateProfileSchema.parse({
        ...nextProfile,
        experiences: applyExperienceDelta({
          experiences: nextProfile.experiences,
          from: proposal.proposedExperiences,
          to: proposal.beforeExperiences,
          proposalTitle: proposal.title,
        }),
      });
    }
    nextStatus = "pending";
    resolvedAt = null;
  }

  const proposals = input.proposals.map((entry) =>
    entry.id === proposal.id
      ? ResumeTimelineRepairProposalSchema.parse({
          ...entry,
          status: nextStatus,
          resolvedAt,
          actionHistory: [
            ...entry.actionHistory,
            { action: input.action, occurredAt: input.occurredAt },
          ],
        })
      : entry,
  );

  return {
    profile: nextProfile,
    proposals: ResumeTimelineRepairProposalSchema.array().parse(proposals),
  };
}
export async function persistResumeTimelineRepairAction(input: {
  repository: JobFinderRepository;
  runId: string;
  proposalId: string;
  action: ResumeTimelineRepairAction;
  occurredAt: string;
}): Promise<{
  profile: CandidateProfile;
  run: ResumeImportRun;
}> {
  const runs = await input.repository.listResumeImportRuns();
  const run = runs.find((entry) => entry.id === input.runId);
  if (!run) {
    throw new Error(`Unknown resume import run '${input.runId}'.`);
  }
  const [profile, searchPreferences, documentBundles, fieldCandidates] =
    await Promise.all([
      input.repository.getProfile(),
      input.repository.getSearchPreferences(),
      input.repository.listResumeImportDocumentBundles({ runId: run.id }),
      input.repository.listResumeImportFieldCandidates({ runId: run.id }),
    ]);
  const result = applyResumeTimelineRepairAction({
    profile,
    proposals: run.timelineRepairProposals ?? [],
    proposalId: input.proposalId,
    action: input.action,
    occurredAt: input.occurredAt,
  });
  const nextRun = ResumeImportRunSchema.parse({
    ...run,
    timelineRepairProposals: result.proposals,
  });

  await input.repository.finalizeResumeImportRun({
    profile: result.profile,
    searchPreferences,
    run: nextRun,
    documentBundles,
    fieldCandidates,
  });

  return { profile: result.profile, run: nextRun };
}
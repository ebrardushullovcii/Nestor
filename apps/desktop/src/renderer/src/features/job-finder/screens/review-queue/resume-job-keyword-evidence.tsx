import type {
  JobPosting,
  MatchAssessment,
  ResumeDraft,
} from "@nestor/contracts";
import { useId } from "react";
import { StatusBadge } from "../../components/status-badge";

export type ResumeKeywordEvidenceJob = Pick<
  JobPosting,
  | "title"
  | "keySkills"
  | "keywordSignals"
  | "minimumQualifications"
  | "benefits"
> & {
  matchAssessment?: Pick<
    MatchAssessment,
    "requirements" | "requirementsSource"
  >;
};

export type ResumeKeywordEvidenceItem = {
  evidence: string | null;
  sourceLabel: string | null;
  status: "supported" | "partial" | "not_evidenced" | "unchecked";
  draftEvidence?: string | null;
  term: string;
};

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim();
}

function uniqueTerms(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const term = value.trim();
    const normalized = normalizeForMatch(term);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(term);
  }

  return result;
}

function collectTargetedKeywords(draft: ResumeDraft): string[] {
  const values: string[] = [];

  for (const section of draft.sections) {
    if (section.kind !== "keywords") {
      continue;
    }

    if (section.text) {
      values.push(section.text);
    }
    values.push(...section.bullets.map((bullet) => bullet.text));
    for (const entry of section.entries) {
      if (entry.title) {
        values.push(entry.title);
      }
      if (entry.summary) {
        values.push(entry.summary);
      }
      values.push(...entry.bullets.map((bullet) => bullet.text));
    }
  }

  return values;
}

function collectJobTerms(
  job: ResumeKeywordEvidenceJob | null | undefined,
  draft: ResumeDraft,
): string[] {
  const terms = [
    ...(job?.keySkills ?? []),
    ...(job?.keywordSignals ?? [])
      .filter((signal) => signal.kind !== "benefit")
      .map((signal) => signal.label),
  ];

  // Qualification prose is intentionally not converted into keyword terms.
  // Explicit skills/signals and the saved targeted-keyword section are the
  // bounded request data this review aid can show without keyword stuffing.
  const employerTerms = new Set(
    [
      ...(job?.benefits ?? []),
      ...(job?.keywordSignals ?? [])
        .filter((signal) => signal.kind === "benefit")
        .map((signal) => signal.label),
    ].map(normalizeForMatch),
  );
  // Perks and culture labels describe the employer, not what the person
  // must show.
  return uniqueTerms([...terms, ...collectTargetedKeywords(draft)]).filter(
    (term) => !employerTerms.has(normalizeForMatch(term)),
  );
}

export function isResumeDraftThin(draft: ResumeDraft): boolean {
  const includedSections = draft.sections.filter((section) => section.included);
  const includedLineCount = includedSections.reduce((count, section) => {
    const sectionLines = section.text ? 1 : 0;
    const bulletLines = section.bullets.filter(
      (bullet) => bullet.included,
    ).length;
    const entryLines = section.entries
      .filter((entry) => entry.included)
      .reduce(
        (entryCount, entry) =>
          entryCount +
          (entry.title || entry.summary ? 1 : 0) +
          entry.bullets.filter((bullet) => bullet.included).length,
        0,
      );
    return count + sectionLines + bulletLines + entryLines;
  }, 0);
  const hasExperienceContent = includedSections.some(
    (section) =>
      section.kind === "experience" &&
      section.entries.some(
        (entry) =>
          entry.included &&
          Boolean(
            entry.title ||
            entry.summary ||
            entry.bullets.some((bullet) => bullet.included),
          ),
      ),
  );

  return (
    includedLineCount < 5 ||
    !hasExperienceContent ||
    includedSections.length < 2
  );
}

export function buildResumeJobKeywordEvidence(input: {
  draft: ResumeDraft;
  job?: ResumeKeywordEvidenceJob | null | undefined;
}): ResumeKeywordEvidenceItem[] {
  // These verdicts compare the listing with saved facts, never this draft's
  // generated wording. Draft edits cannot rewrite the person's evidence.
  if (input.job?.matchAssessment?.requirementsSource === "model") {
    return input.job.matchAssessment.requirements
      .filter((requirement) =>
        ["skill", "experience", "seniority", "domain"].includes(
          requirement.category,
        ),
      )
      .map((requirement) => ({
        term: requirement.label,
        status:
          requirement.status === "supported"
            ? "supported"
            : requirement.status === "partial"
              ? "partial"
              : requirement.status === "unknown"
                ? "unchecked"
                : "not_evidenced",
        evidence: [
          ...requirement.resumeEvidence.map((ref) => ref.detail),
          requirement.explanation,
        ].join(" "),
        sourceLabel: "Checked against saved facts",
      }));
  }
  const terms = collectJobTerms(input.job, input.draft);
  if (terms.length === 0) {
    return [];
  }

  return terms.map((term) => ({
    evidence: null,
    sourceLabel: null,
    status: "unchecked",

    term,
  }));
}

export function ResumeJobKeywordEvidencePanel(props: {
  draft: ResumeDraft;
  fallbackMessage?: string | null | undefined;
  job?: ResumeKeywordEvidenceJob | null | undefined;
}) {
  const headingId = useId();
  const summaryId = useId();
  const items = buildResumeJobKeywordEvidence({
    draft: props.draft,
    job: props.job,
  });

  if (items.length === 0) {
    return null;
  }

  const supportedItems = items.filter(
    (item) => item.status === "supported" || item.status === "partial",
  );
  const supportedCount = items.filter(
    (item) => item.status === "supported",
  ).length;
  const partialCount = items.filter((item) => item.status === "partial").length;
  const uncheckedCount = items.filter(
    (item) => item.status === "unchecked",
  ).length;
  const missingCount = items.filter(
    (item) => item.status === "not_evidenced",
  ).length;
  const missingItems = items.filter(
    (item) => item.status === "not_evidenced" || item.status === "unchecked",
  );
  const needsFactualReview =
    Boolean(props.fallbackMessage) ||
    props.draft.generationMethod === "deterministic" ||
    props.draft.status === "needs_review" ||
    isResumeDraftThin(props.draft);

  return (
    <section
      aria-describedby={summaryId}
      aria-labelledby={headingId}
      className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-fill-soft) p-3"
      data-resume-job-keyword-evidence
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-0.5">
            <h3 className="text-(--text-headline)" id={headingId}>
              Job keywords and evidence
            </h3>
            <p
              className="text-(length:--text-small) leading-5 text-foreground-soft"
              id={summaryId}
            >
              {props.job?.title
                ? `Terms saved from ${props.job.title}.`
                : "Terms saved from this job."}{" "}
              Checks use saved facts and imported evidence. Draft wording alone
              does not prove a requirement. A missing term is not added to the
              draft.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* A count of zero is not good news: "0 supported" in the success
                colour, beside a red "1 not evidenced", read as if something
                had passed. Each badge carries its tone only when it has
                something to report. */}
            <StatusBadge tone={supportedCount > 0 ? "positive" : "muted"}>
              {supportedCount} supported
            </StatusBadge>
            {partialCount > 0 ? (
              <StatusBadge tone="warning">{partialCount} partial</StatusBadge>
            ) : null}
            {uncheckedCount > 0 ? (
              <StatusBadge tone="muted">
                {uncheckedCount} not checked
              </StatusBadge>
            ) : null}
            <StatusBadge tone={missingCount > 0 ? "critical" : "muted"}>
              {missingCount} not evidenced
            </StatusBadge>
          </div>
        </div>
      </div>

      {needsFactualReview ? (
        <div
          className="text-(length:--text-small) leading-5 text-foreground-muted"
          data-resume-keyword-factual-review
          role="note"
        >
          This draft needs a factual review before approval. The keyword list is
          a review aid only; it does not add evidence or prove that a term is
          true.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div
          className="grid content-start gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-2.5"
          data-resume-supported-keywords
        >
          <div className="grid gap-0.5">
            <h4 className="text-(--text-headline)">
              Supported by candidate content
            </h4>
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              These requirements have saved evidence. Partial support still
              needs review.
            </p>
          </div>
          {supportedItems.length > 0 ? (
            <ul className="grid gap-1.5">
              {supportedItems.map((item) => (
                <li
                  className="grid gap-1 rounded-(--radius-field) border border-positive/20 bg-background/45 px-2.5 py-2"
                  key={`supported_${item.term}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-foreground">
                      {item.term}
                    </strong>
                    <StatusBadge
                      tone={item.status === "partial" ? "warning" : "positive"}
                    >
                      {item.status === "partial"
                        ? "Partial support"
                        : "Supported"}
                    </StatusBadge>
                  </div>
                  {item.evidence ? (
                    <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                      <span className="font-medium text-foreground">
                        {item.sourceLabel ?? "Candidate source"}:
                      </span>{" "}
                      {item.evidence}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              No requirements have been checked as supported yet.
            </p>
          )}
        </div>

        <div
          className="grid content-start gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-2.5"
          data-resume-missing-keywords
        >
          <div className="grid gap-0.5">
            <h4 className="text-(--text-headline)">
              Requested by this job, still to review
            </h4>
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              Keep these terms out unless you can add truthful support from your
              own experience.
            </p>
          </div>
          {missingItems.length > 0 ? (
            <ul className="grid gap-1.5">
              {missingItems.map((item) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-(--warning-border) bg-background/45 px-2.5 py-2"
                  key={`missing_${item.term}`}
                >
                  <strong className="text-sm text-foreground">
                    {item.term}
                  </strong>
                  <StatusBadge
                    tone={item.status === "unchecked" ? "muted" : "critical"}
                  >
                    {item.status === "unchecked"
                      ? "Not checked"
                      : "Not evidenced"}
                  </StatusBadge>
                  {item.draftEvidence ? (
                    <p className="w-full text-(length:--text-small) text-foreground-soft">
                      Draft wording: {item.draftEvidence}. Saved evidence still
                      needs confirmation.
                    </p>
                  ) : null}
                  {item.evidence ? (
                    <p className="w-full text-(length:--text-small) text-foreground-soft">
                      {item.evidence}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              Every saved job term has a matching candidate source. Review the
              wording before approval.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

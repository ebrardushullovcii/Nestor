import type { ApplicationReviewCard, ApplyRunDetails } from "@nestor/contracts";

function selectedOptions(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    )
      return [...parsed].sort();
  } catch {
    /* Older answers used separators. */
  }
  return value
    .split(/[\n,;]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
}

export function withPersonAnswerSources(
  card: ApplicationReviewCard,
  details: ApplyRunDetails,
): ApplicationReviewCard {
  return {
    ...card,
    answers: card.answers.map((answer) => {
      if (
        answer.source !== "the filled application form" &&
        answer.source !== "your answer to this question"
      )
        return answer;
      // Saved profile answers count without a question record. Application
      // answers still need the person's selected/filled record, or evidence
      // checked against that record before a fresh preparation retained it.
      if (
        (answer.sourceId?.startsWith("answerLibrary.") &&
          !answer.sourceId.startsWith("answerLibrary.application_")) ||
        answer.sourceId?.startsWith("applicationAnswer.")
      )
        return answer;
      const question = details.questionRecords.find(
        (entry) => entry.prompt === answer.question,
      );
      const recorded = details.answerRecords
        .filter(
          (entry) =>
            entry.questionId === question?.id &&
            // An answer the person gave is the question's selected answer,
            // stored as a suggestion until the form takes it; an unused
            // suggestion never counts, and anything else only once filled.
            (entry.status === "filled" ||
              (entry.sourceKind === "user" &&
                entry.id === question?.selectedAnswerId &&
                entry.status !== "rejected" &&
                entry.status !== "skipped")) &&
            (entry.text === answer.answer ||
              question?.answerControlType === "multi_choice"),
        )
        .sort(
          (a, b) =>
            b.revision - a.revision || b.createdAt.localeCompare(a.createdAt),
        )[0];
      if (!recorded)
        return answer.source === "your answer to this question"
          ? { ...answer, source: "the filled application form", written: false }
          : answer;
      const same =
        recorded.text === answer.answer ||
        (question?.answerControlType === "multi_choice" &&
          JSON.stringify(selectedOptions(recorded.text)) ===
            JSON.stringify(selectedOptions(answer.answer)));
      if (!same) return answer;
      const provenance = recorded.provenance.find(
        (entry) => entry.sourceId === recorded.sourceId,
      )?.label;
      if (recorded.sourceId?.startsWith("authority.attestation."))
        return {
          ...answer,
          source: "your Settings (on by default)",
          written: false,
        };
      if (recorded.sourceKind !== "user")
        return {
          ...answer,
          source:
            provenance ??
            (recorded.sourceKind === "profile"
              ? "your profile"
              : "an earlier application answer"),
          written:
            recorded.sourceKind === "prior_answer" && Boolean(provenance),
          groundedIn: recorded.provenance.map((entry) => entry.label),
        };
      const savedSource =
        recorded.sourceId?.startsWith("answerLibrary.") &&
        !recorded.sourceId.startsWith("answerLibrary.application_");
      const source = savedSource
        ? (recorded.provenance.find(
            (entry) => entry.sourceId === recorded.sourceId,
          )?.label ?? "your saved answer")
        : "your answer to this question";
      return same ? { ...answer, source } : answer;
    }),
  };
}

import type { SendGuards } from "@nestor/db/job-store";

/** Read the current outcome of each consumed call, preserving its full history. */
export async function currentSendOutcomes<
  T extends { id?: string; idempotencyKey?: string },
>(
  repository: Pick<SendGuards, "getSubmissionIdempotencyRecord">,
  outcomes: readonly T[],
): Promise<T[]> {
  const current = await Promise.all(
    outcomes.map(async (outcome) => {
      if (!outcome.id || !outcome.idempotencyKey) return outcome;
      const key = await repository.getSubmissionIdempotencyRecord(
        outcome.idempotencyKey,
      );
      return key?.outcomeId === outcome.id ? outcome : null;
    }),
  );
  return current.filter((outcome): outcome is T => outcome !== null);
}

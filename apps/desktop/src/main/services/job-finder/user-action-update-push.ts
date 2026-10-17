import type { JobFinderRepository } from "@nestor/db";

/**
 * Tells the renderer whenever a step in Needs you changes state.
 *
 * A step can move to checking, or close, from work the renderer did not start
 * (a file added in Profile › Files carrying a waiting upload on, a saved
 * answer reaching another job, a check finishing behind another job on the
 * same site). Without a push the card kept showing the question, PENDING,
 * until something else refreshed the workspace.
 */
export function publishOnUserActionChanges(
  repository: Pick<
    JobFinderRepository,
    "commitUserActionTransition" | "createUserActionRequest"
  >,
  publish: () => void,
  delayMs = 150,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      publish();
    }, delayMs);
  };
  const commit = repository.commitUserActionTransition.bind(repository);
  repository.commitUserActionTransition = async (input) => {
    const result = await commit(input);
    schedule();
    return result;
  };
  const create = repository.createUserActionRequest.bind(repository);
  repository.createUserActionRequest = async (input) => {
    const result = await create(input);
    schedule();
    return result;
  };
}

/**
 * Tells the renderer whenever an application's standing in a batch changes.
 *
 * A batch runs in the background after the press returns, so its writes
 * (planned to waiting for a tab, waiting to filling, a step of progress, the
 * run ending) had no push of their own: Applications kept "Waiting its turn
 * in this run." and Home named a job as filling until a navigation.
 */
export function publishOnApplyStandingChanges(
  repository: Pick<
    JobFinderRepository,
    | "upsertApplyRun"
    | "upsertApplyJobResult"
    | "compareAndSwapApplyJobResult"
    | "markApplicationPreparationStarted"
  >,
  publish: () => void,
  delayMs = 200,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      publish();
    }, delayMs);
  };
  const upsertRun = repository.upsertApplyRun.bind(repository);
  repository.upsertApplyRun = async (run) => {
    await upsertRun(run);
    schedule();
  };
  const upsertResult = repository.upsertApplyJobResult.bind(repository);
  repository.upsertApplyJobResult = async (result) => {
    await upsertResult(result);
    schedule();
  };
  const swapResult = repository.compareAndSwapApplyJobResult.bind(repository);
  repository.compareAndSwapApplyJobResult = async (input) => {
    const swapped = await swapResult(input);
    if (swapped) schedule();
    return swapped;
  };
  const markStarted =
    repository.markApplicationPreparationStarted.bind(repository);
  repository.markApplicationPreparationStarted = async (input) => {
    const outcome = await markStarted(input);
    if (outcome.didStart) schedule();
    return outcome;
  };
}

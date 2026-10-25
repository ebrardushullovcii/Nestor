import {
  getDiscoveryRunPhase,
  recoverInterruptedDiscoveryRun,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

/**
 * Records, at startup, that a search which was still running when the app
 * closed was interrupted.
 *
 * A run left in `running` has nothing driving it: no process will finish it
 * and no screen can tell it apart from a search in flight. That is what let
 * the app claim "50 new jobs saved" for a search it had dropped and then say
 * "Nothing was deleted" over the fifteen that survived. Recovery moves the
 * stranded run into history with an `interrupted` phase and a warning naming
 * what it kept, so every surface reads the run's own frozen report instead of
 * recomputing a number from whatever is left.
 *
 * Idempotent: a run already carrying a terminal phase is returned untouched,
 * so re-running this on the next start changes nothing.
 *
 * Read only each run's state and phase to decide whether recovery is needed.
 * The canonical update loads evidence only when something was left running.
 */
export async function recoverInterruptedDiscoveryRuns(
  repository: Pick<
    JobFinderRepository,
    "commitDiscoveryStateUpdate" | "readDiscoveryRunStates"
  >,
  now: string = new Date().toISOString(),
): Promise<void> {
  const states = await repository.readDiscoveryRunStates();
  const leftRunning = states.some(
    (run) => getDiscoveryRunPhase(run) === "in_progress",
  );
  if (!leftRunning) return;

  await repository.commitDiscoveryStateUpdate(
    (current): JobFinderDiscoveryState => {
      const recoveredActiveRun = current.activeRun
        ? recoverInterruptedDiscoveryRun(current.activeRun, now)
        : null;
      const recentRuns = current.recentRuns.map(
        (run) => recoverInterruptedDiscoveryRun(run, now) ?? run,
      );

      if (!recoveredActiveRun) {
        const unchanged = recentRuns.every(
          (run, index) => run === current.recentRuns[index],
        );
        return unchanged ? current : { ...current, recentRuns };
      }

      // The interrupted run is history now, so nothing keeps offering to stop
      // a search that is not running.
      const withoutDuplicate = recentRuns.filter(
        (run) => run.id !== recoveredActiveRun.id,
      );
      return {
        ...current,
        runState: "idle",
        activeRun: null,
        recentRuns: [recoveredActiveRun, ...withoutDuplicate],
      };
    },
  );
}

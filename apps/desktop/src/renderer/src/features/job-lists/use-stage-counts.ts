import type { JobStageCounts } from "@nestor/contracts";
import { useEffect, useState } from "react";

/** How many jobs sit in each stage of the job store, kept current. */
export function useStageCounts(): JobStageCounts | null {
  const [counts, setCounts] = useState<JobStageCounts | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      window.nestor.jobs
        .run("stage_counts", {})
        .then((next) => {
          if (live) setCounts(next);
        })
        .catch(() => undefined);
    void load();
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.stages.length > 0) void load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return counts;
}

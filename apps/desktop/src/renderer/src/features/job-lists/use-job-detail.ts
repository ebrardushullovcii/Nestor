import type { JobDetail } from "@nestor/contracts";
import { useEffect, useState } from "react";

/** One job in full from `get_job`, refetched when a change names it. */
export function useJobDetail(id: number | null): JobDetail | null {
  const [job, setJob] = useState<JobDetail | null>(null);
  useEffect(() => {
    if (id === null) {
      setJob(null);
      return undefined;
    }
    let live = true;
    const load = () =>
      window.nestor.jobs
        .run("get_job", { id })
        .then((next) => {
          if (live) setJob(next);
        })
        .catch(() => undefined);
    void load();
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.ids === null || change.ids.includes(id)) void load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id]);
  return job?.id === id ? job : null;
}

import type { JobDetail } from "@nestor/contracts";
import { useCallback, useEffect, useState } from "react";

import { readErrorText } from "./list-read-error";

/**
 * One job in full from `get_job`, refetched when a change names it. A failed
 * read is kept as `error` (the last job drawn stays) until `retry` or the
 * next change reads it again.
 */
export function useJobDetail(id: number | null): {
  job: JobDetail | null;
  error: string | null;
  retry: () => void;
} {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [failure, setFailure] = useState<{ id: number; error: string } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (id === null) {
      setJob(null);
      setFailure(null);
      return undefined;
    }
    let live = true;
    const load = () =>
      window.nestor.jobs
        .run("get_job", { id })
        .then((next) => {
          if (!live) return;
          setJob(next);
          setFailure(null);
        })
        .catch((error: unknown) => {
          if (live)
            setFailure({
              id,
              error:
                error instanceof Error
                  ? readErrorText(error.message)
                  : "The job could not be read.",
            });
        });
    void load();
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.ids === null || change.ids.includes(id)) void load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id, attempt]);
  return {
    job: job?.id === id ? job : null,
    error: failure?.id === id ? failure.error : null,
    retry,
  };
}

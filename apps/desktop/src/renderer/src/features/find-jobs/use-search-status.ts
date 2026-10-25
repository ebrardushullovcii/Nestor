import type { JobSearchStatus } from "@nestor/contracts";
import { useEffect, useState } from "react";

const NONE: JobSearchStatus = {
  search: null,
  sources: [],
  progress: null,
  sourceRevision: 0,
};

/**
 * The running or last search, kept current while the screen is open.
 * `loaded` turns true once the first answer arrives.
 */
export function useSearchStatus(): JobSearchStatus & { loaded: boolean } {
  const [status, setStatus] = useState<JobSearchStatus & { loaded: boolean }>({
    ...NONE,
    loaded: false,
  });
  useEffect(() => {
    let live = true;
    const unsubscribe = window.nestor.jobs.onSearchStatus((next) => {
      if (live) setStatus({ ...next, loaded: true });
    });
    void window.nestor.jobs
      .run("search_status", {})
      .then((next) => {
        if (live) setStatus({ ...next, loaded: true });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return status;
}

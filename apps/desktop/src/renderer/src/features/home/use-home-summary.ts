import type { HomeSummary } from "@nestor/contracts";
import { useEffect, useState } from "react";

/** Changes come in bursts while Apply works; read again at most this often. */
const REFRESH_GAP_MS = 500;

/** Home's numbers, read again whenever the job store changes. */
export function useHomeSummary(): {
  summary: HomeSummary | null;
  error: string | null;
} {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      timer = null;
      window.nestor.home
        .summary({ utcOffsetMinutes: -new Date().getTimezoneOffset() })
        .then((next) => {
          if (!live) return;
          setSummary(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (live)
            setError(
              reason instanceof Error ? reason.message : "Home could not load.",
            );
        });
    };
    load();
    const unsubscribe = window.nestor.jobs.onChange(() => {
      timer ??= setTimeout(load, REFRESH_GAP_MS);
    });
    return () => {
      live = false;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { summary, error };
}

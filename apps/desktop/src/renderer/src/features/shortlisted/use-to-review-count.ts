import { useEffect, useState } from "react";

/** How many shortlisted jobs wait for their resume to be read, kept current. */
export function useToReviewCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      window.nestor.jobs
        .run("stage_counts", {})
        .then((counts) => {
          if (live) setCount(counts.shortlisted);
        })
        .catch(() => undefined);
    void load();
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.stages.includes("shortlisted")) void load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return count;
}

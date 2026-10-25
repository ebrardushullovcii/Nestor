import type { JobSite } from "@nestor/contracts";
import { useEffect, useState } from "react";

export function useSiteDetail(id: number | null) {
  const [site, setSite] = useState<JobSite | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) {
      setSite(null);
      return;
    }
    let live = true;
    const load = () => {
      void window.nestor.jobs
        .run("get_site", { id })
        .then((next) => {
          if (live) {
            setSite(next);
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (live)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load this site.",
            );
        });
    };
    load();
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause === "sites") load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id]);
  return { site: site?.id === id ? site : null, error };
}

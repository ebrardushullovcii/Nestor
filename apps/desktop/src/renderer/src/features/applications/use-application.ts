import type { TrackedApplication } from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/** One application in full, kept current as it or its history changes. */
export function useApplication(jobId: number | null) {
  const [application, setApplication] = useState<TrackedApplication | null>(
    null,
  );
  const latest = useRef(jobId);
  latest.current = jobId;

  const load = useCallback(async () => {
    const id = latest.current;
    if (id === null) {
      setApplication(null);
      return;
    }
    const next = await window.nestor.tracker.run("get_application", {
      jobId: id,
    });
    if (latest.current === id) setApplication(next);
  }, []);

  useEffect(() => {
    setApplication(null);
    void load();
  }, [jobId, load]);

  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        const id = latest.current;
        if (id !== null && (change.ids === null || change.ids.includes(id)))
          void load();
      }),
    [load],
  );

  return { application, reload: load };
}

export function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.replace(
          /^Error invoking remote method '[^']+': (\w*Error: )?/u,
          "",
        )
      : "";
  // A rejected input arrives as the validator's JSON, which says nothing to a person.
  return message && !message.startsWith("[")
    ? message
    : "Something went wrong.";
}

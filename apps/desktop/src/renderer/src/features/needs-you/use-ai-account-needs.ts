import { useEffect, useMemo, useState } from "react";
import type { AiAccountNeed } from "@nestor/contracts";

/**
 * Every refused AI account, read again on every change: the person's own
 * key (a Needs you step) and Nestor's bundled one (a paused status only).
 */
export function useAiAccountRefusals(): AiAccountNeed[] {
  const [needs, setNeeds] = useState<AiAccountNeed[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const value = await window.nestor.needsYou.aiAccount.list();
        if (live) setNeeds(value);
      } catch {
        /* A later change reads it again; keep what was shown. */
      }
    };
    void load();
    let unsubscribe = () => {};
    try {
      unsubscribe = window.nestor.jobs.onChange((change) => {
        if (change.cause === "application") void load();
      });
    } catch {
      /* No change feed here: the first read stands. */
    }
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return needs;
}

/** The AI account step only the person can take: their own key's refusals. */
export function useAiAccountNeeds(): AiAccountNeed[] {
  const refusals = useAiAccountRefusals();
  return useMemo(
    () => refusals.filter((need) => need.owner === "person"),
    [refusals],
  );
}

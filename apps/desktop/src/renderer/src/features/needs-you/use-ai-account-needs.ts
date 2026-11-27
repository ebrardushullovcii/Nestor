import { useEffect, useState } from "react";
import type { AiAccountNeed } from "@nestor/contracts";

/** The AI account step only the person can take, read again on every change. */
export function useAiAccountNeeds(): AiAccountNeed[] {
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
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause === "application") void load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return needs;
}

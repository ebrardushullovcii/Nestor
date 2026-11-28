import { useEffect, useState } from "react";
import { useAiAccountNeeds } from "./use-ai-account-needs";

/**
 * The badge and Needs you count the same open store tasks, and the AI
 * account step while one is open.
 */
export function useNeedsYouCount(): number {
  const accountSteps = useAiAccountNeeds().length;
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const counts = await window.nestor.needsYou.run("needs_you_counts", {});
        if (live)
          setCount(
            counts.question +
              counts.sign_in +
              counts.captcha +
              counts.mfa +
              counts.other,
          );
      } catch {
        /* A later store event retries the read. */
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
  return count + accountSteps;
}

import { useMemo, useState } from "react";
import type { ReviewQueueItem } from "@nordri/contracts";

// Owned by the page controller, which stays mounted while routes change.
export function useResumeOperationStarts(
  queue: readonly ReviewQueueItem[],
  isPending: (jobId: string) => boolean,
): Readonly<Record<string, number>> {
  const { activeIds, key } = useMemo(() => {
    const activeIds = queue
      .filter(
        (item) =>
          isPending(item.jobId) ||
          item.assetStatus === "generating" ||
          item.assetStatus === "queued",
      )
      .map((item) => item.jobId)
      .sort();
    return { activeIds, key: JSON.stringify(activeIds) };
  }, [queue, isPending]);
  const [state, setState] = useState<{
    key: string;
    starts: Record<string, number>;
  }>({ key: "[]", starts: {} });
  if (state.key !== key) {
    const starts = Object.fromEntries(
      activeIds.map((id) => [id, state.starts[id] ?? Date.now()]),
    );
    setState({ key, starts });
    return starts;
  }
  return state.starts;
}

import { useEffect, useState, useSyncExternalStore } from "react";
import { describeFailure } from "../lib/describe-failure";
import type { TailoredAsset, TailoredAssetSummary } from "@nordri/contracts";

/** A sentence this hook wrote for the person, shown as it is. */
class DetailReadError extends Error {}

let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readGeneration = () => generation;
export function clearTailoredAssetDetailCache() {
  generation += 1;
  for (const listener of listeners) listener();
}

/** Only the selected resume's body is retained. Selection/revision fences late reads. */
export function useTailoredAssetDetail(summary: TailoredAssetSummary | null) {
  const currentGeneration = useSyncExternalStore(subscribe, readGeneration);
  const id = summary?.id ?? null;
  const key = summary
    ? JSON.stringify([
        currentGeneration,
        summary.id,
        summary.version,
        summary.updatedAt,
      ])
    : null;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    source: TailoredAssetSummary | null;
    asset: TailoredAsset | null;
    error: string | null;
    loaded: boolean;
  }>({ key: null, source: null, asset: null, error: null, loaded: false });
  useEffect(() => {
    if (!id || !key) {
      setState({
        key: null,
        source: null,
        asset: null,
        error: null,
        loaded: false,
      });
      return;
    }
    let current = true;
    setState({ key, source: summary, asset: null, error: null, loaded: false });
    void Promise.resolve()
      .then(() => window.nordri.jobFinder.getTailoredAsset(id))
      .then((asset) => {
        if (asset && asset.id !== id)
          throw new DetailReadError("This preview belongs to another resume.");
        if (
          asset &&
          (asset.version !== summary?.version ||
            asset.updatedAt !== summary?.updatedAt)
        )
          throw new DetailReadError(
            "The resume changed while its preview was loading. Refresh the workspace and try again.",
          );
        if (current)
          setState({
            key,
            source: summary,
            asset,
            error: asset ? null : "This resume is no longer available.",
            loaded: true,
          });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            key,
            source: summary,
            asset: null,
            loaded: true,
            error:
              error instanceof DetailReadError
                ? error.message
                : describeFailure(error, { action: "load the resume preview" })
                    .userMessage,
          });
      });
    return () => {
      current = false;
    };
  }, [id, key, retry, summary]);
  const matches = state.key === key && state.source === summary;
  return {
    asset: matches ? state.asset : null,
    loading: key !== null && (!matches || !state.loaded),
    error: matches ? state.error : null,
    retry: () => setRetry((value) => value + 1),
  };
}

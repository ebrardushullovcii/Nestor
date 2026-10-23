import { useEffect, useMemo, useState } from "react";
import type {
  ApplicationPageState,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";

/** The bridge reads at most this many results per call. */
const MAX_PAGE_STATE_IDS = 200;

type ApplyJobResult = Pick<
  JobFinderRendererWorkspaceSnapshot["applyJobResults"][number],
  "id" | "state" | "updatedAt"
>;

// Every reader re-reads after a form was reopened or handed over.
const changeListeners = new Set<() => void>();

/** Tells every page-state reader that a form opened, closed or came back. */
export function notifyApplicationPageStatesChanged(): void {
  for (const listener of changeListeners) listener();
}

/**
 * Results with a filled-in form waiting on the person: the newest first, as
 * many as one read covers.
 */
function pageStateResultIds(
  results: readonly ApplyJobResult[] | undefined,
): string[] {
  return (results ?? [])
    .filter((result) => result.state === "awaiting_review")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_PAGE_STATE_IDS)
    .map((result) => result.id);
}

/**
 * Whether each filled-in form is open, can be reopened from what was saved,
 * or has to be prepared again. Read for the results on screen and again when
 * any of them changes; the read never opens a page.
 */
export function useApplicationPageStates(
  results: readonly ApplyJobResult[] | undefined,
): ReadonlyMap<string, ApplicationPageState> {
  const ids = useMemo(() => pageStateResultIds(results), [results]);
  // Re-read only when the set of results or one of them changed.
  const readKey = useMemo(() => {
    const byId = new Map((results ?? []).map((result) => [result.id, result]));
    return ids.map((id) => `${id}:${byId.get(id)?.updatedAt ?? ""}`).join("|");
  }, [ids, results]);
  const [states, setStates] = useState<
    ReadonlyMap<string, ApplicationPageState>
  >(() => new Map());
  const [changeCount, setChangeCount] = useState(0);
  useEffect(() => {
    const listener = () => setChangeCount((count) => count + 1);
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const read = window.nestor?.jobFinder?.getApplicationPageStates;
    if (ids.length === 0 || !read) {
      setStates((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    let cancelled = false;
    read(ids).then(
      (next) => {
        if (!cancelled) {
          setStates(new Map(next.map((state) => [state.resultId, state])));
        }
      },
      () => {
        // Unknown is treated as before: the Open button tries the page.
      },
    );
    return () => {
      cancelled = true;
    };
    // `readKey` carries every id and its update time.
  }, [readKey, changeCount]);

  return states;
}

/**
 * A ready form that cannot be reopened from what was saved and has to be
 * prepared again. A finished application is not one of these.
 */
export function pageNeedsPreparing(
  state: ApplicationPageState | undefined,
): boolean {
  return (
    state?.state === "needs_preparing" &&
    state.reason !== "application_finished"
  );
}

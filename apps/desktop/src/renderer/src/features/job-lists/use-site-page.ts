import type { JobSiteListQuery, JobSitePage } from "@nestor/contracts";
import { useEffect, useRef, useState } from "react";

const EMPTY: JobSitePage = {
  rows: [],
  total: 0,
  selected: 0,
  enabledTotal: 0,
  nextCursor: null,
  counts: { all: 0, enabled: 0, disabled: 0, needs_attention: 0 },
};

/** A fixed-size page, shared by Profile, setup and the search picker. */
export function useSitePage(query: Omit<JobSiteListQuery, "cursor"> = {}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  const text = query.text ?? "",
    filter = query.filter ?? "all";
  const selection = JSON.stringify(query.selection);
  const selectionRef = useRef(query.selection);
  selectionRef.current = query.selection;
  const limit = query.limit ?? 25;
  const cursor = cursors[pageIndex] ?? null;
  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [text, filter]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void window.nestor.jobs
      .run("list_sites", {
        text,
        filter,
        limit,
        selection: selectionRef.current,
        cursor,
      })
      .then((next) => {
        if (live) {
          setPage(next);
          setError(null);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setLoading(false);
          setError(
            reason instanceof Error ? reason.message : "Could not load sites.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, [text, filter, selection, limit, cursor, revision]);
  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        if (change.cause === "sites") setRevision((value) => value + 1);
      }),
    [],
  );
  return {
    ...page,
    loading,
    error,
    pageIndex,
    refresh,
    previous: () => setPageIndex((index) => Math.max(0, index - 1)),
    next: () => {
      if (!page.nextCursor) return;
      setCursors((old) => [...old.slice(0, pageIndex + 1), page.nextCursor]);
      setPageIndex((index) => index + 1);
    },
  };
}

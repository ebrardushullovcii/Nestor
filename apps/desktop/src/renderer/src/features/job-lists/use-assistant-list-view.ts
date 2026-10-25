import {
  AssistantJobViewSchema,
  matchesAssistantJobView,
  type AssistantJobView,
} from "@nestor/contracts";
import { useEffect, useRef } from "react";
import type { ListSelection } from "./list-selection";

/** A navigation request updates the screen's own state; list changes keep that selection. */
export function useAssistantListView(
  raw: string | null,
  options: {
    requestId?: string;
    current: AssistantJobView;
    applyView: (view: AssistantJobView) => void;
    setSelection: (selection: ListSelection) => void;
  },
) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<AssistantJobView | null>(null);
  useEffect(() => {
    if (!raw) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = AssistantJobViewSchema.safeParse(value);
    if (!parsed.success) return;
    pending.current = parsed.data;
    latest.current.applyView(parsed.data);
  }, [raw, options.requestId]);
  const currentKey = JSON.stringify(options.current);
  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    const { selectedIds, all, ...filter } = request;
    if (!matchesAssistantJobView(latest.current.current, filter)) return;
    pending.current = null;
    if (selectedIds === undefined && all === undefined) return;
    latest.current.setSelection({
      all: all ?? false,
      ids: new Set(selectedIds ?? []),
      anchor: null,
    });
  }, [raw, options.requestId, currentKey]);
}

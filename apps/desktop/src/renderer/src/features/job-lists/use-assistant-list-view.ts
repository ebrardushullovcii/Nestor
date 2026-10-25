import {
  AssistantJobViewSchema,
  AssistantTrackerViewSchema,
  matchesAssistantListView,
  type AssistantTrackerView,
  type AssistantJobView,
} from "@nestor/contracts";
import { useEffect, useRef } from "react";
import type { ListSelection } from "./list-selection";

type Options<T> = {
  requestId?: string;
  current: T;
  applyView: (view: T) => void;
  setSelection: (selection: ListSelection) => void;
};

export function useAssistantListView(
  raw: string | null,
  options: Options<AssistantJobView>,
) {
  useAssistantView(raw, AssistantJobViewSchema, options);
}

export function useAssistantTrackerView(
  raw: string | null,
  options: Options<AssistantTrackerView>,
) {
  useAssistantView(raw, AssistantTrackerViewSchema, options);
}

/** Apply selection after the screen has applied filters and reset its old selection. */
function useAssistantView<
  T extends { selectedIds?: number[] | undefined; all?: boolean | undefined },
>(
  raw: string | null,
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: false } | { success: true; data: T };
  },
  options: Options<T>,
) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<T | null>(null);
  useEffect(() => {
    if (!raw) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return;
    pending.current = parsed.data;
    latest.current.applyView(parsed.data);
  }, [raw, options.requestId, schema]);
  const currentKey = JSON.stringify(options.current);
  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    const { selectedIds, all, ...filter } = request;
    if (!matchesAssistantListView(latest.current.current, filter)) return;
    pending.current = null;
    if (selectedIds === undefined && all === undefined) return;
    latest.current.setSelection({
      all: all ?? false,
      ids: new Set(selectedIds ?? []),
      anchor: null,
    });
  }, [raw, options.requestId, currentKey]);
}

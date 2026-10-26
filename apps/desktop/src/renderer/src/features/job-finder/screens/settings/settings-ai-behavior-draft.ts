import { useEffect, useRef, useState } from "react";
import type {
  JobFinderSettings,
  UpdateAiBehaviorInput,
} from "@nestor/contracts";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

/**
 * One slice of the AI behavior preferences, saved on its own.
 *
 * AI behavior and Applying used to share one draft because both saved
 * through `updateAiBehavior`. The save merges partial groups, so each
 * section now owns only its slice and sends only that slice: an edit in
 * one section can never overwrite the other's newer values with its
 * older copy. Choices save the moment they are picked (the saved toast
 * offers Undo); typed text saves when the person pauses or leaves the
 * field; a Save button appears only to retry a failed save.
 */

/** Typed text saves this long after the last keystroke, or on leaving the field. */
const TEXT_SAVE_DELAY_MS = 800;

export function useAiBehaviorSliceSave<Slice>(args: {
  settings: JobFinderSettings;
  /** Picks this section's slice out of the saved settings. */
  seed: (settings: JobFinderSettings) => Slice;
  /** The partial update carrying only this slice. */
  toInput: (slice: Slice) => UpdateAiBehaviorInput;
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
    options?: { undo?: () => void },
  ) => Promise<boolean | void> | void;
  anchorId: string;
  label: string;
  order: number;
  saveLabel: string;
  failedMessage: string;
  savedMessage: string;
  undoneMessage: string;
}) {
  const { onUpdateAiBehavior, seed, settings, toInput } = args;
  const saved = seed(settings);
  const savedKey = JSON.stringify(toInput(saved));
  const [draft, setDraft] = useState<Slice>(saved);
  const [seededKey, setSeededKey] = useState(savedKey);
  const { resetSectionSave, runSectionSave, saveState } =
    useSettingsSectionSave();

  // Saves run one at a time; a choice made while one is in flight is sent
  // when it ends. These refs let timers and that follow-up see the newest
  // draft and the values last sent.
  const latestDraftRef = useRef(draft);
  const sentRef = useRef({ draft: saved, key: savedKey });
  const inFlightRef = useRef(false);
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdateAiBehavior);
  onUpdateRef.current = onUpdateAiBehavior;
  const toInputRef = useRef(toInput);
  toInputRef.current = toInput;

  // Reseed only when the persisted values change from outside this section
  // (the Assistant, another window). Our own save coming back changes nothing
  // on screen, and an unrelated settings refresh never throws away a choice.
  // Done during render, so mounting does not render the section twice.
  if (seededKey !== savedKey) {
    setSeededKey(savedKey);
    if (!inFlightRef.current && savedKey !== sentRef.current.key) {
      sentRef.current = { draft: saved, key: savedKey };
      latestDraftRef.current = saved;
      setDraft(saved);
    }
  }

  const isSavePending = saveState.status === "saving";
  // Only a failed save is left outstanding; everything else is on its way.
  const hasUnsavedChanges =
    saveState.status === "failed" &&
    JSON.stringify(toInput(draft)) !== savedKey;

  const sendLatest = (options: { offerUndo: boolean }) => {
    if (textTimerRef.current) {
      clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
    }
    if (inFlightRef.current) {
      return;
    }
    const next = latestDraftRef.current;
    const input = toInput(next);
    const key = JSON.stringify(input);
    if (key === sentRef.current.key) {
      return;
    }
    const previous = sentRef.current;
    sentRef.current = { draft: next, key };
    inFlightRef.current = true;
    let committed = false;
    // Undo puts back what this save replaced, and saves that at once too.
    const undo = () => {
      latestDraftRef.current = previous.draft;
      setDraft(previous.draft);
      sendLatest({ offerUndo: false });
    };
    void runSectionSave({
      execute: async () => {
        const result = await onUpdateRef.current(
          input,
          options.offerUndo ? { undo } : undefined,
        );
        committed = result !== false;
        return result;
      },
      failedMessage: args.failedMessage,
      savedMessage: options.offerUndo ? args.savedMessage : args.undoneMessage,
    }).finally(() => {
      inFlightRef.current = false;
      if (!committed) {
        // Retry sends the newest draft again.
        sentRef.current = previous;
        return;
      }
      // A choice made while this save ran goes out now.
      sendLatest({ offerUndo: true });
    });
  };

  const edit = (
    update: (current: Slice) => Slice,
    when: "now" | "after_typing" = "now",
  ) => {
    const next = update(latestDraftRef.current);
    latestDraftRef.current = next;
    setDraft(next);
    resetSectionSave();
    if (when === "now") {
      sendLatest({ offerUndo: true });
      return;
    }
    if (textTimerRef.current) clearTimeout(textTimerRef.current);
    textTimerRef.current = setTimeout(
      () => sendLatest({ offerUndo: true }),
      TEXT_SAVE_DELAY_MS,
    );
  };
  const sendTypedText = () => sendLatest({ offerUndo: true });

  // Typed text still waiting for its pause goes out when Settings closes.
  useEffect(
    () => () => {
      if (textTimerRef.current) clearTimeout(textTimerRef.current);
      if (inFlightRef.current) return;
      const input = toInputRef.current(latestDraftRef.current);
      if (JSON.stringify(input) !== sentRef.current.key) {
        void onUpdateRef.current(input);
      }
    },
    [],
  );

  useRegisterSettingsDirtySection({
    anchorId: args.anchorId,
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: args.label,
    onSave: sendTypedText,
    order: args.order,
    saveLabel: args.saveLabel,
  });

  return {
    draft,
    edit,
    hasUnsavedChanges,
    isSavePending,
    saveState,
    sendTypedText,
  };
}

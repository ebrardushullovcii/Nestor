import { ArrowLeft } from "lucide-react";
import { useCallback, useContext, useRef, useState } from "react";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";

import { isStackedLayout } from "./list-pane";
import { DetailSheetForcedContext } from "./sheet-mode";

/**
 * The details-as-a-sheet behaviour Find jobs uses, for every list screen.
 * Stacked (below 1024px, or below 1280px beside a docked assistant), opening
 * a row lays its details over the list; "Back to the list" or Escape puts
 * them away with the open row still chosen and in view. Side by side the
 * sheet state is ignored.
 */
export function useDetailSheet(options?: {
  /** The screen reads its details in a sheet at every width right now. */
  always?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const always = useRef(options?.always ?? false);
  always.current = options?.always ?? false;
  // Escape and leaving sheet mode are the layout's (`ListDetailLayout`
  // with `sheet.onClose`), which knows its own panel.
  /** A row was opened by the person: cover the list when stacked. */
  const openIfStacked = useCallback(() => {
    if (always.current || isStackedLayout()) setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, setOpen, openIfStacked, close };
}

/** The one way back from a details sheet; shown only while stacked. */
export function DetailSheetBack(props: { onBack: () => void }) {
  const always = useContext(DetailSheetForcedContext);
  return (
    <div
      className={cn(
        "shrink-0 border-b border-(--surface-panel-border) px-3 py-1.5",
        always ? "block" : "hidden stacked:block",
      )}
      data-detail-sheet-back
    >
      <Button
        onClick={props.onBack}
        size="toolbar"
        title="Back to the list · Esc"
        type="button"
        variant="ghost"
      >
        <ArrowLeft aria-hidden="true" />
        Back to the list
      </Button>
    </div>
  );
}

import { Pause, Play } from "lucide-react";
import { Button } from "@renderer/components/ui/button";

export interface JobFinderActivityControlState {
  activeApplicationCount: number;
  activeBrowserCount: number;
  paused: boolean;
  pausedAt: string | null;
  pending: boolean;
}

export function JobFinderActivityControl(props: {
  onPause: () => void;
  onResume: () => void;
  state: JobFinderActivityControlState;
}) {
  const activeCount =
    props.state.activeApplicationCount + props.state.activeBrowserCount;
  const detailId = "job-finder-activity-control-detail";

  return (
    // The explanation sits under the control in small type, end-aligned with
    // it, rather than running beside it at heading level like a stray caption.
    <div className="grid justify-items-start gap-1 lg:justify-items-end">
      <Button
        aria-describedby={detailId}
        onClick={props.state.paused ? props.onResume : props.onPause}
        pending={props.state.pending}
        size="sm"
        type="button"
        variant={props.state.paused ? "primary" : "outline"}
      >
        {props.state.paused ? (
          <Play aria-hidden="true" className="size-4" />
        ) : (
          <Pause aria-hidden="true" className="size-4" />
        )}
        {props.state.paused ? "Continue" : "Pause"}
      </Button>
      <span
        className="max-w-[44ch] text-(length:--text-tiny) leading-4 text-foreground-muted lg:text-right"
        id={detailId}
      >
        {props.state.paused
          ? "New browser and application work is paused. Review and local edits still work."
          : activeCount > 0
            ? `${activeCount} background ${activeCount === 1 ? "operation" : "operations"} running`
            : "No browser or application work is running"}
      </span>
    </div>
  );
}

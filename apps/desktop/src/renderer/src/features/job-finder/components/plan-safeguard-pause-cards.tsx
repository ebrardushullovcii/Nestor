import type { PlanSafeguardPause } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

export function PlanSafeguardPauseCards(props: {
  pauses: readonly PlanSafeguardPause[];
  onNavigate: (path: string) => void;
}) {
  return props.pauses.map((pause) => (
    <section
      key={pause.id}
      role="status"
      className="surface-panel-shell grid gap-2 rounded-(--radius-panel) border border-(--warning-border) bg-(--warning-surface) p-5"
    >
      <h2 className="font-semibold">{pause.title}</h2>
      <p>
        {pause.planName}: {pause.explanation}
      </p>
      <Button variant="secondary" onClick={() => props.onNavigate(pause.route)}>
        Open Safeguards
      </Button>
    </section>
  ));
}

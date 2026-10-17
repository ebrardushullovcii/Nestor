import { useState } from "react";
import type { JobSearchCampaign } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";

export function SearchPlanScope(props: {
  campaigns: readonly JobSearchCampaign[];
  activeCampaignId: string;
  collection: "Shortlisted" | "Applications";
  countsByCampaignId?: Readonly<Record<string, number>>;
  onSelect: (campaignId: string) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const plans = props.campaigns.filter((plan) => plan.status !== "archived");
  const count = (plan: JobSearchCampaign) =>
    props.countsByCampaignId?.[plan.id] ?? 0;
  const current = plans.find((plan) => plan.id === props.activeCampaignId);
  const otherPopulated = plans.filter(
    (plan) => plan.id !== props.activeCampaignId && count(plan) > 0,
  );
  const select = (campaignId: string) => {
    setPending(true);
    setFailed(false);
    void props
      .onSelect(campaignId)
      .then((selected) => setFailed(!selected))
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-soft">
      <span>Showing this plan only</span>
      <Select
        disabled={pending}
        value={props.activeCampaignId}
        onValueChange={select}
      >
        <SelectTrigger
          aria-label={`${props.collection} search plan`}
          size="sm"
          className="w-auto"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {plans.map((plan) => (
            <SelectItem key={plan.id} value={plan.id}>
              {plan.name} ({count(plan)})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending ? <span role="status">Switching view…</span> : null}
      {failed ? (
        <span role="alert">This view could not be switched. Try again.</span>
      ) : null}
      {current && count(current) === 0 && otherPopulated.length > 0 ? (
        <span className="flex flex-wrap items-center gap-2">
          {props.collection === "Shortlisted"
            ? "Shortlisted jobs"
            : "Applications"}{" "}
          in other plans:
          {otherPopulated.map((plan) => (
            <Button
              key={plan.id}
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => select(plan.id)}
            >
              {plan.name} ({count(plan)})
            </Button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

import type { ReactNode } from "react";

import { Button } from "@renderer/components/ui/button";

/**
 * An empty list says why it is empty and offers the one next step, as a
 * button: never only a sentence that sends the person somewhere else.
 */
export function ListEmpty(props: {
  title: string;
  detail?: string | null;
  action?: { label: string; onClick: () => void } | null;
  children?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-3 text-center text-(length:--text-description) text-foreground-soft">
      <p className="font-medium text-foreground">{props.title}</p>
      {props.detail ? <p>{props.detail}</p> : null}
      {props.action ? (
        <Button
          onClick={props.action.onClick}
          size="sm"
          type="button"
          variant="outline"
        >
          {props.action.label}
        </Button>
      ) : null}
      {props.children}
    </div>
  );
}

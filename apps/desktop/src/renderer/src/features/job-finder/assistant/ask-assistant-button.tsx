import { Sparkles } from "lucide-react";
import type { AssistantEntityRef } from "@nestor/contracts";

import { Button } from "@renderer/components/ui/button";
import { useAssistant } from "./assistant-provider";

/**
 * Where an old chat used to open, this opens the one assistant with the
 * right record attached and an optional question ready to send.
 */
export function AskAssistantButton(props: {
  label?: string | undefined;
  prompt?: string | undefined;
  mention?: AssistantEntityRef | undefined;
  className?: string | undefined;
}) {
  const assistant = useAssistant();
  if (!assistant) return null;
  return (
    <Button
      className={props.className}
      size="sm"
      variant="outline"
      data-ask-assistant
      onClick={() =>
        assistant.openWith({
          ...(props.prompt ? { text: props.prompt } : {}),
          ...(props.mention ? { mention: props.mention } : {}),
        })
      }
      type="button"
    >
      <Sparkles aria-hidden="true" className="size-4" />
      {props.label ?? "Ask the assistant"}
    </Button>
  );
}

import { useState } from "react";
import type { AiAccountNeed } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

const TITLE: Record<AiAccountNeed["reason"], string> = {
  funding: "Top up your AI account",
  authentication: "Fix the API key for your AI account",
  permission: "Give your API key access to the model",
};

const OPEN_LABEL: Record<AiAccountNeed["reason"], string> = {
  funding: "Open the top-up page",
  authentication: "Open the key page",
  permission: "Open the account page",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/**
 * The AI account behind Nestor refuses its calls: a step only the person
 * can take. It closes by itself once a call goes through again, and the
 * work that waited on it carries on without another press.
 */
export function AiAccountNeedItem({ need }: { need: AiAccountNeed }) {
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <section
      aria-label={TITLE[need.reason]}
      className="grid gap-2 rounded-(--radius-panel) border border-(--surface-panel-border) px-3 py-3"
      data-needs-ai-account={need.reason}
    >
      <h2 className="font-medium">{TITLE[need.reason]}</h2>
      <p className="text-sm text-foreground-soft">
        The AI service at {hostOf(need.provider)} is refusing Nestor&apos;s
        requests, and only you can fix that. Resumes, fit scores and
        applications that need the AI wait, then carry on by themselves once it
        answers again.
      </p>
      {need.providerMessage ? (
        <blockquote
          className="m-0 border-l-2 border-(--surface-panel-border) pl-3 text-sm break-words"
          data-needs-ai-account-words
        >
          {need.providerMessage}
        </blockquote>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {need.actionUrl ? (
          <Button
            size="sm"
            title={need.actionUrl}
            onClick={() => {
              setMessage(null);
              void window.nestor.needsYou.aiAccount
                .open(need.id)
                .then((opened) => {
                  if (!opened)
                    setMessage("This page link is no longer available.");
                })
                .catch(() => setMessage("Could not open the page."));
            }}
          >
            {OPEN_LABEL[need.reason]}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={checking}
          onClick={() => {
            setMessage(null);
            setChecking(true);
            void window.nestor.needsYou.aiAccount
              .check()
              .then((started) =>
                setMessage(
                  started
                    ? "Checking with the AI service. This closes once it answers."
                    : "Nothing is waiting on the AI right now. Nestor checks again the next time it uses it.",
                ),
              )
              .catch(() => setMessage("Could not check again just now."))
              .finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking…" : "I've done it, check now"}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-foreground-soft">
          {message}
        </p>
      ) : null}
    </section>
  );
}

import { useState } from "react";
import type { NeedsYouTask } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

/** Source tickets never acquire an application or answer form. */
export function SourceNeedPane({
  source,
}: {
  source: NonNullable<NeedsYouTask["source"]>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const failed = (error: unknown) =>
    setMessage(
      error instanceof Error ? error.message : "Could not retry this site.",
    );
  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      await window.nestor.jobs.run("retry_source", { id: source.id });
      setMessage(
        "Trying this site again. This item closes when the site is readable.",
      );
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4">
      <h2 className="font-medium">Sign in to {source.label}</h2>
      <p className="break-all text-sm text-foreground-soft">{source.url}</p>
      <Button
        disabled={busy}
        onClick={() => {
          void window.nestor.browser
            .command({ type: "open", url: source.url })
            .catch(failed);
        }}
      >
        Open to sign in
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => void retry()}>
        {busy ? "Retrying…" : "Retry"}
      </Button>
      {message ? (
        <p role="status" className="text-sm text-foreground-soft">
          {message}
        </p>
      ) : null}
    </div>
  );
}

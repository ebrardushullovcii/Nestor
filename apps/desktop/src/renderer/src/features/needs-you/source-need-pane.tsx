import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { workThrough, type SiteCheck, type WorkItem } from "./work-through";

/**
 * A job site search could not read until the person signs in. Several
 * sources on one host share one sign-in, so they share this pane.
 */
export function SourceNeedPane({
  site,
  host,
  check,
}: {
  site: WorkItem;
  host: string;
  check: SiteCheck | undefined;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <h2 className="font-medium">Sign in to {site.label}</h2>
      <p className="text-sm text-foreground-soft">
        Search couldn&apos;t read {host}
        {site.sources.length > 1 ? ` (${site.sources.length} sites)` : ""}. Sign
        in once, then check it. This item closes when the site is readable.
      </p>
      <Button
        disabled={check === "checking"}
        onClick={() => {
          setMessage(null);
          void window.nestor.needsYou
            .run("open_need", { id: site.taskIds[0] ?? site.id })
            .catch((error: unknown) =>
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Could not open this site.",
              ),
            );
        }}
      >
        Open to sign in
      </Button>
      <Button
        variant="outline"
        disabled={check === "checking"}
        onClick={() => {
          setMessage(null);
          workThrough.check(site);
        }}
      >
        {check === "checking" ? "Checking…" : "I've signed in, check it"}
      </Button>
      {message || check === "still" ? (
        <p role="status" className="text-sm text-foreground-soft">
          {message ??
            "Still can't read it. Open it, finish signing in, then check again."}
        </p>
      ) : null}
    </div>
  );
}

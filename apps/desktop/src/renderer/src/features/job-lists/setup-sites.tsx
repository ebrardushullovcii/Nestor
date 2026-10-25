import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { AddSites } from "./add-sites";
import { useSitePage } from "./use-site-page";

export function SetupSites(props: {
  registerFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = useSitePage({ text, limit: 25 });
  return (
    <section
      aria-labelledby="profile-setup-job-sources-heading"
      className="grid gap-4 rounded-(--radius-field) border border-border/35 p-4"
    >
      <h3
        id="profile-setup-job-sources-heading"
        className="text-sm font-semibold"
      >
        Job sources
      </h3>
      <p className="text-sm text-foreground-soft">
        Add the careers pages and job boards you use. Each is turned on for
        search straight away.
      </p>
      <AddSites
        alwaysOpen
        {...(props.registerFlush ? { registerFlush: props.registerFlush } : {})}
      />
      {list.enabledTotal === 0 && list.counts.all > 0 ? (
        <p role="status" className="text-sm text-(--warning-text)">
          Your sources are off. Turn on at least one to search.
        </p>
      ) : null}
      {list.counts.all > 0 ? (
        <>
          <Input
            aria-label="Find a source"
            placeholder="Find a source"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-sm text-foreground-muted">
            {list.enabledTotal} sources turned on
          </p>
          <ul className="grid list-none gap-2 p-0">
            {list.rows.map((site) => (
              <li
                key={site.id}
                className="flex min-w-0 items-center gap-3 rounded border p-3"
              >
                <label className="flex min-w-0 flex-1 items-center gap-3">
                  <Checkbox
                    aria-label={`Include ${site.label} in searches`}
                    checked={site.enabled}
                    onCheckedChange={(enabled) => {
                      void window.nestor.jobs
                        .run("update_site", {
                          id: site.id,
                          enabled: enabled === true,
                        })
                        .catch((reason: unknown) =>
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Could not update site.",
                          ),
                        );
                    }}
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-sm">
                      {site.label}
                    </strong>
                    <span className="block truncate text-xs text-foreground-muted">
                      {site.url}
                    </span>
                  </span>
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${site.label}`}
                  onClick={() => {
                    void window.nestor.jobs
                      .run("remove_site", { id: site.id })
                      .catch((reason: unknown) =>
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : "Could not remove site.",
                        ),
                      );
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {list.total > 25 ? (
            <nav
              aria-label="Source pages"
              className="flex items-center justify-between gap-3"
            >
              <Button
                size="sm"
                variant="outline"
                disabled={list.pageIndex === 0 || list.loading}
                onClick={list.previous}
              >
                Previous sources
              </Button>
              <span className="text-sm">
                {list.pageIndex * 25 + 1}–
                {list.pageIndex * 25 + list.rows.length} of {list.total}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!list.nextCursor || list.loading}
                onClick={list.next}
              >
                Next sources
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
      {(error ?? list.error) ? <p role="alert">{error ?? list.error}</p> : null}
    </section>
  );
}

import { useState } from "react";
import type { RevealSavedFileResult } from "@nestor/contracts";
import { TextLink } from "@renderer/components/ui/text-link";
import { cn } from "@renderer/lib/cn";

/**
 * A web address the app prints is something the person expects to open, and
 * a file the app wrote is something they expect to find. These two controls
 * make both true everywhere instead of leaving URLs and paths as inert text.
 *
 * Links open in the Job Finder browser (ADR 0017): the same window a search
 * or an application used, so a sign-in it holds carries over. Files are
 * revealed in the operating system's file manager; nothing is executed.
 */

export function openUrlInJobFinderBrowser(url: string): void {
  void window.nestor.browser.command({ type: "open", url });
}

export function ExternalUrlLink(props: {
  className?: string;
  /** Visible text; defaults to the URL itself. */
  label?: string;
  url: string;
}) {
  return (
    <TextLink
      className={cn("break-all text-left", props.className)}
      data-open-outside-url={props.url}
      onClick={() => openUrlInJobFinderBrowser(props.url)}
      title={props.label ? props.url : "Opens in the Job Finder browser"}
    >
      {props.label ?? props.url}
    </TextLink>
  );
}

const REVEAL_OUTCOME_COPY: Record<
  Exclude<RevealSavedFileResult["outcome"], "revealed">,
  string
> = {
  not_found: "That file is no longer at this location.",
  unsupported: "Showing files is not supported on this device.",
};

export function SavedFileLink(props: {
  className?: string;
  /** Visible text; defaults to the path itself. */
  label?: string;
  path: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <span className={cn("inline", props.className)}>
      <TextLink
        className="break-all text-left"
        data-open-outside-path={props.path}
        onClick={() => {
          setNotice(null);
          void window.nestor.jobFinder
            .revealSavedFile(props.path)
            .then((result) => {
              if (result.outcome !== "revealed") {
                setNotice(REVEAL_OUTCOME_COPY[result.outcome]);
              }
            })
            .catch(() => {
              setNotice("The file could not be shown. Try again.");
            });
        }}
        title={props.label ? props.path : "Show in your file manager"}
      >
        {props.label ?? props.path}
      </TextLink>
      {notice ? (
        <span className="ml-1 text-(--warning-text)" role="status">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

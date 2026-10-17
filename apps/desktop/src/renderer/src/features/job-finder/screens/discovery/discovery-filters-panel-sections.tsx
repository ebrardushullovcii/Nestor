import type { SourceAccessPrompt } from "@nordri/contracts";
import { History, Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@renderer/components/ui/button";
import {
  OPEN_JOB_FINDER_BROWSER_ACTION,
  REOPEN_JOB_FINDER_BROWSER_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import {
  DISCOVERY_OFFLINE_CATALOG_NOTICE,
  DISCOVERY_OFFLINE_SEARCH_REASON,
  DISCOVERY_OFFLINE_SETUP_NOTICE,
  DISCOVERY_PAUSED_SEARCH_REASON,
} from "./discovery-search-readiness";

/**
 * Plain-language purpose of the optional browser action. The browser is not
 * a prerequisite for Search: the run opens it on its own.
 */
export const DISCOVERY_OPEN_BROWSER_DESCRIPTION = `${OPEN_JOB_FINDER_BROWSER_ACTION}. Useful if a job site needs you to sign in.`;

type SectionValue =
  | string
  | {
      key: string;
      label: string;
    };

type SectionEditAction = {
  href: string;
  label: string;
  /** Overrides the derived "Edit <label>" wording on a filled row. */
  filledLabel?: string;
  variant?: "primary" | "secondary";
};

export function DiscoverySessionSummary(props: {
  hasRecommendedSourceAccessPrompt: boolean;
  isBlocked: boolean;
  isBrowserSessionVisible: boolean;
  isOfflineRuntime: boolean;
  isSearchSetupReady?: boolean;
  isReady: boolean;
  isTargetPending: (targetId: string) => boolean;
  needsLogin: boolean;
  onConfirmSignedInForTarget?: (targetId: string) => void;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  primarySourceAccessPrompt: SourceAccessPrompt | null;
  sectionDetail: string;
  isBrowserSessionPendingForTarget: (targetId: string) => boolean;
}) {
  const {
    hasRecommendedSourceAccessPrompt,
    isBlocked,
    isBrowserSessionVisible,
    isBrowserSessionPendingForTarget,
    isReady,
    isOfflineRuntime,
    isSearchSetupReady = false,
    isTargetPending,
    needsLogin,
    onConfirmSignedInForTarget,
    onOpenBrowserSessionForTarget,
    primarySourceAccessPrompt,
    sectionDetail,
  } = props;

  return (
    <>
      {sectionDetail ? (
        <p className="max-w-full break-words text-(length:--text-small) leading-5 text-foreground-soft">
          {sectionDetail}
        </p>
      ) : null}

      {isBrowserSessionVisible ? (
        <div className="grid gap-2">
          {!isOfflineRuntime && primarySourceAccessPrompt ? (
            <div
              aria-live="polite"
              className={
                // Only a required sign-in is a tinted box; a recommended one
                // is an optional improvement, so it reads as plain text with
                // its button (ADR 0042).
                primarySourceAccessPrompt.state === "prompt_login_required"
                  ? "rounded-(--radius-small) border border-(--warning-border) bg-(--warning-surface) px-3 py-3 text-(length:--text-description) leading-6 text-(--warning-text)"
                  : "text-(length:--text-description) leading-6 text-foreground-soft"
              }
              role="status"
            >
              <p className="font-medium">{primarySourceAccessPrompt.summary}</p>
              {primarySourceAccessPrompt.detail ? (
                <p className="mt-1 opacity-90">
                  {primarySourceAccessPrompt.detail}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    onOpenBrowserSessionForTarget(
                      primarySourceAccessPrompt.targetId,
                    )
                  }
                  pending={isBrowserSessionPendingForTarget(
                    primarySourceAccessPrompt.targetId,
                  )}
                  size="sm"
                  type="button"
                  variant={
                    primarySourceAccessPrompt.state === "prompt_login_required"
                      ? "primary"
                      : "secondary"
                  }
                >
                  {primarySourceAccessPrompt.actionLabel}
                </Button>
                {primarySourceAccessPrompt.state === "prompt_login_required" &&
                onConfirmSignedInForTarget ? (
                  <Button
                    onClick={() =>
                      onConfirmSignedInForTarget(
                        primarySourceAccessPrompt.targetId,
                      )
                    }
                    pending={isTargetPending(
                      primarySourceAccessPrompt.targetId,
                    )}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {`I'm signed in — retry ${primarySourceAccessPrompt.targetLabel}`}
                  </Button>
                ) : null}
              </div>
              {primarySourceAccessPrompt.state === "prompt_login_required" ? (
                <p className="mt-2 text-(length:--text-small) opacity-80">
                  Job Finder waits here and never handles your credentials.
                  Finish sign-in in the browser, return here, then confirm to
                  retry only this source.
                </p>
              ) : primarySourceAccessPrompt.rerunLabel ? (
                <p className="mt-2 text-(length:--text-small) opacity-80">
                  {`Then ${primarySourceAccessPrompt.rerunLabel}.`}
                </p>
              ) : null}
            </div>
          ) : null}
          {!isOfflineRuntime &&
          (needsLogin || isBlocked) &&
          !primarySourceAccessPrompt ? (
            <p
              role="status"
              className="text-(length:--text-description) leading-6 text-foreground-soft"
            >
              Some sources may need sign-in before the next search can finish.
            </p>
          ) : null}
          {!isOfflineRuntime && isReady && !primarySourceAccessPrompt ? (
            <p
              role="status"
              className="text-(length:--text-description) leading-6 text-foreground-soft"
            >
              If you signed in to a job site in the browser, that sign-in is
              reused.
            </p>
          ) : null}
          {!isOfflineRuntime &&
          hasRecommendedSourceAccessPrompt &&
          !primarySourceAccessPrompt &&
          !needsLogin &&
          !isBlocked ? (
            <p
              role="status"
              className="text-(length:--text-description) leading-6 text-foreground-soft"
            >
              The browser can improve coverage for sources that support sign-in.
            </p>
          ) : null}
          {isOfflineRuntime ? (
            <p
              role="status"
              className="text-(length:--text-description) leading-6 text-foreground-soft"
            >
              {isSearchSetupReady
                ? DISCOVERY_OFFLINE_SETUP_NOTICE
                : DISCOVERY_OFFLINE_CATALOG_NOTICE}
            </p>
          ) : !sectionDetail &&
            !needsLogin &&
            !isBlocked &&
            !isReady &&
            !hasRecommendedSourceAccessPrompt ? (
            <p className="text-(length:--text-description) leading-5 text-foreground-soft">
              {DISCOVERY_OPEN_BROWSER_DESCRIPTION}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Navigation register, not a command: a normal-width link keeps
          Search jobs as the panel's single primary action. */}
      <Button
        asChild
        className="h-auto w-fit justify-start px-0 py-0.5 text-xs normal-case tracking-normal"
        size="sm"
        type="button"
        variant="link"
      >
        <Link to={JOB_FINDER_ROUTE_PATHS.profileSources}>
          Edit sources and preferences
        </Link>
      </Button>
    </>
  );
}
export function DiscoverySearchSections(props: {
  sectionHeadingPrefix: string;
  sections: ReadonlyArray<{
    label: string;
    values: SectionValue[];
    empty: string;
    editAction?: SectionEditAction;
  }>;
}) {
  const { sectionHeadingPrefix, sections } = props;
  const navigate = useNavigate();

  return (
    <>
      {sections.map((section, index) => {
        const sectionHeadingId = `${sectionHeadingPrefix}-${section.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}`;
        const isEmpty = section.values.length === 0;
        // Every saved value row now carries its own labelled control. Before,
        // only an EMPTY row offered a route to editing, so a configured search
        // was a read-only summary whose single edit route was a body-copy link
        // at the bottom of the panel.
        const editAction = section.editAction ?? null;
        // A heading that is already a sentence ("Full-time or part-time")
        // makes "Edit full-time or part-time" read like an instruction, so a
        // row may name its own verb phrase instead.
        const editLabel = isEmpty
          ? editAction?.label
          : (editAction?.filledLabel ?? `Edit ${section.label.toLowerCase()}`);

        return (
          <section
            aria-labelledby={sectionHeadingId}
            key={section.label}
            className={
              (index === 0
                ? "min-w-0 px-4 "
                : "min-w-0 border-t border-(--surface-panel-border) px-4 ") +
              (isEmpty && editAction ? "py-2.5" : "py-4")
            }
          >
            <div className="grid min-w-0 gap-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h3
                  className="shrink-0 text-(length:--text-field-label) font-medium uppercase tracking-(--tracking-badge) text-foreground-muted"
                  id={sectionHeadingId}
                >
                  {section.label}
                </h3>
                {editAction && editLabel ? (
                  // A real button, not a link dressed as one. As an anchor,
                  // "Add roles" took focus but neither Enter nor Space opened
                  // the role editor, so the only repair route for an empty
                  // search plan was unreachable from the keyboard.
                  <Button
                    className="h-8 shrink-0 whitespace-nowrap px-3 normal-case tracking-normal"
                    onClick={() => {
                      void navigate(editAction.href);
                    }}
                    size="sm"
                    type="button"
                    variant={
                      isEmpty ? (editAction.variant ?? "secondary") : "outline"
                    }
                  >
                    {editLabel}
                  </Button>
                ) : null}
              </div>
              {isEmpty ? (
                <p className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft">
                  {section.empty}
                </p>
              ) : (
                // Saved criteria are read-only facts, not controls: flat
                // inert text with strong contrast, no border, fill, hover,
                // or tooltip chrome that could read as a disabled button.
                <p className="min-w-0 text-(length:--text-small) leading-5 text-foreground [overflow-wrap:anywhere]">
                  {section.values
                    .map((value) =>
                      typeof value === "string" ? value : value.label,
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

export function DiscoveryRunOneSourceSection(props: {
  enabledSourceAccessPrompts: readonly SourceAccessPrompt[];
  enabledTargets: ReadonlyArray<{ id: string; label: string }>;
  isAnyDiscoveryRunActive?: boolean;
  isOfflineRuntime?: boolean;
  isSearchUnavailable?: boolean;
  isBrowserSessionPendingForTarget: (targetId: string) => boolean;
  isTargetPending: (targetId: string) => boolean;
  activeTargetId: string | null;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onConfirmSignedInForTarget: (targetId: string) => void;
  onRunDiscoveryForTarget: (targetId: string) => void;
  primarySourceAccessPrompt: SourceAccessPrompt | null;
  runOneSourceHeadingId: string;
}) {
  const {
    activeTargetId,
    enabledSourceAccessPrompts,
    enabledTargets,
    isAnyDiscoveryRunActive = false,
    isOfflineRuntime = false,
    isSearchUnavailable = false,
    isBrowserSessionPendingForTarget,
    isTargetPending,
    onOpenBrowserSessionForTarget,
    onConfirmSignedInForTarget,
    onRunDiscoveryForTarget,
    primarySourceAccessPrompt,
    runOneSourceHeadingId,
  } = props;

  return (
    <section
      aria-labelledby={runOneSourceHeadingId}
      className="min-w-0 border-t border-(--surface-panel-border) px-4 py-4"
    >
      <div className="grid min-w-0 gap-3">
        <h3
          className="text-(length:--text-field-label) font-medium uppercase tracking-(--tracking-badge) text-foreground-muted"
          id={runOneSourceHeadingId}
        >
          Run one source
        </h3>
        <div className="grid gap-2">
          {enabledTargets.map((target) => {
            const isActiveSingleTarget = activeTargetId === target.id;
            const targetPrompt =
              enabledSourceAccessPrompts.find(
                (prompt) => prompt.targetId === target.id,
              ) ?? null;

            return (
              <div className="grid gap-2" key={target.id}>
                {/* The action is a real button, not label-shaped text beside
                    the source name. */}
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span
                    className="min-w-0 flex-1 truncate text-(length:--text-small) font-medium text-foreground"
                    title={target.label}
                  >
                    {target.label}
                  </span>
                  <Button
                    aria-label={`Run discovery for ${target.label}`}
                    className="shrink-0"
                    disabled={
                      isTargetPending(target.id) ||
                      isSearchUnavailable ||
                      (isAnyDiscoveryRunActive && !isActiveSingleTarget)
                    }
                    pending={isTargetPending(target.id)}
                    onClick={() => onRunDiscoveryForTarget(target.id)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {isActiveSingleTarget
                      ? "Running now"
                      : "Search only this source"}
                  </Button>
                </div>
                {targetPrompt &&
                targetPrompt.targetId !==
                  primarySourceAccessPrompt?.targetId ? (
                  <div
                    // A row status, not a box per source row: the colour
                    // of the line says whether sign-in is required.
                    className={
                      targetPrompt.state === "prompt_login_required"
                        ? "text-(length:--text-small) leading-6 text-(--warning-text)"
                        : "text-(length:--text-small) leading-6 text-foreground-muted"
                    }
                    role="status"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{targetPrompt.summary}</span>
                      {!isOfflineRuntime ? (
                        <Button
                          onClick={() =>
                            onOpenBrowserSessionForTarget(target.id)
                          }
                          pending={isBrowserSessionPendingForTarget(target.id)}
                          size="sm"
                          type="button"
                          variant={
                            targetPrompt.state === "prompt_login_required"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {targetPrompt.actionLabel}
                        </Button>
                      ) : null}
                      {!isOfflineRuntime &&
                      targetPrompt.state === "prompt_login_required" ? (
                        <Button
                          onClick={() => onConfirmSignedInForTarget(target.id)}
                          pending={isTargetPending(target.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          I'm signed in — retry
                        </Button>
                      ) : null}
                      {isOfflineRuntime ? (
                        <span className="text-(length:--text-small) opacity-80">
                          {DISCOVERY_OFFLINE_SEARCH_REASON}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function DiscoveryFiltersFooter(props: {
  canRunDiscovery: boolean;
  isOfflineRuntime?: boolean;
  isBrowserSessionPending: boolean;
  isBrowserSessionPendingForTarget: (targetId: string) => boolean;
  isDiscoveryAllPending: boolean;
  isReady: boolean;
  onOpenBrowserSession: () => void;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onRunAgentDiscovery: (() => void) | undefined;
  onViewProgress: () => void;
  primarySourceAccessPrompt: SourceAccessPrompt | null;
  searchDisabledReason: string | null;
  searchSetupActionLabel: string;
  searchSetupHref: string;
}) {
  const {
    canRunDiscovery,
    isOfflineRuntime = false,
    isBrowserSessionPending,
    isBrowserSessionPendingForTarget,
    isDiscoveryAllPending,
    isReady,
    onOpenBrowserSession,
    onOpenBrowserSessionForTarget,
    onRunAgentDiscovery,
    onViewProgress,
    primarySourceAccessPrompt,
    searchDisabledReason,
    searchSetupActionLabel,
    searchSetupHref,
  } = props;
  const showSourcesSetupAction =
    Boolean(searchDisabledReason) &&
    searchDisabledReason !== DISCOVERY_PAUSED_SEARCH_REASON &&
    !isOfflineRuntime;

  // Both secondary controls share the primary's row so the setup strip stays
  // one line: the browser control (or the offline note that replaces it) and
  // Search history, which is navigation rather than a third command.
  const secondaryActions = (
    <>
      {isOfflineRuntime ? (
        <span
          className="text-(length:--text-small) leading-5 text-foreground-muted"
          role="status"
        >
          {DISCOVERY_OFFLINE_SEARCH_REASON}
        </span>
      ) : (
        <Button
          className="h-9 w-auto min-w-0 justify-center whitespace-nowrap px-3 text-xs normal-case tracking-normal"
          pending={
            primarySourceAccessPrompt
              ? isBrowserSessionPendingForTarget(
                  primarySourceAccessPrompt.targetId,
                )
              : isBrowserSessionPending
          }
          onClick={() => {
            if (primarySourceAccessPrompt) {
              onOpenBrowserSessionForTarget(primarySourceAccessPrompt.targetId);
              return;
            }

            onOpenBrowserSession();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Search className="size-3.5 shrink-0" />
          {primarySourceAccessPrompt
            ? primarySourceAccessPrompt.actionLabel
            : isReady
              ? REOPEN_JOB_FINDER_BROWSER_ACTION
              : OPEN_JOB_FINDER_BROWSER_ACTION}
        </Button>
      )}
      <Button
        className="h-9 w-auto min-w-0 justify-center gap-1.5 whitespace-nowrap px-3 text-xs normal-case tracking-normal"
        onClick={onViewProgress}
        size="sm"
        type="button"
        variant="outline"
      >
        <History className="size-3.5 shrink-0" />
        Search history
      </Button>
    </>
  );

  return (
    // One left-aligned action row instead of a two-column grid: the primary
    // sat at the far left while the two secondary actions stacked at the far
    // right, leaving ~800px of empty band between them and using two rows
    // where one does.
    <div className="grid min-w-0 gap-2 border-b border-(--surface-panel-border) px-3 py-2.5">
      {onRunAgentDiscovery ? (
        <div className="grid min-w-0 gap-2">
          {showSourcesSetupAction ? (
            <div className="grid gap-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-3">
              <p
                className="text-(length:--text-description) leading-6 text-(--warning-text)"
                id="discovery-search-disabled-reason"
                role="status"
              >
                {searchDisabledReason}
              </p>
              <Button
                asChild
                className="h-9 w-fit whitespace-nowrap px-3 text-center text-xs normal-case tracking-normal"
                size="sm"
                variant="primary"
              >
                <Link to={searchSetupHref}>{searchSetupActionLabel}</Link>
              </Button>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              aria-describedby={
                searchDisabledReason
                  ? "discovery-search-disabled-reason"
                  : undefined
              }
              // A page-wide bar is not a button: the primary search command
              // keeps its natural width beside the browser action.
              className="h-9 w-fit whitespace-nowrap px-3.5 text-center text-xs normal-case tracking-normal"
              disabled={!canRunDiscovery}
              pending={isDiscoveryAllPending}
              onClick={() => onRunAgentDiscovery()}
              size="sm"
              type="button"
              variant={canRunDiscovery ? "primary" : "secondary"}
            >
              Search jobs
            </Button>
            {secondaryActions}
          </div>
          {searchDisabledReason && !showSourcesSetupAction ? (
            <p
              className="text-(length:--text-description) leading-6 text-(--warning-text)"
              id="discovery-search-disabled-reason"
              role="status"
            >
              {searchDisabledReason}
            </p>
          ) : null}
        </div>
      ) : null}

      {onRunAgentDiscovery ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {secondaryActions}
        </div>
      )}
    </div>
  );
}

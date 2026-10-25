import { useEffect, useState } from "react";
import type { SourceInstructionArtifact } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useToast } from "@renderer/components/ui/toast";
import {
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  countSelected,
  selectAll,
  toggleSelection,
  type ListSelection,
} from "@renderer/features/job-lists";
import { useSitePage } from "@renderer/features/job-lists/use-site-page";
import { useSiteDetail } from "@renderer/features/job-lists/use-site-detail";
import { AddSites } from "@renderer/features/job-lists/add-sites";
import {
  ProfileDiscoveryTargetRow,
  type SiteDebugActions,
} from "./profile-discovery-target-row";

export function ProfileJobSourcesTab(
  props: SiteDebugActions & {
    requestedFilter?: string | null;
    sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
  },
) {
  const { showToast } = useToast();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<
    "all" | "enabled" | "disabled" | "needs_attention"
  >(props.requestedFilter === "needs_attention" ? "needs_attention" : "all");
  const list = useSitePage({ text, filter, limit: 25 });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const { site, error: detailError } = useSiteDetail(activeId);
  useEffect(() => {
    setSelection(NO_SELECTION);
    setActiveId(null);
  }, [text, filter]);
  useEffect(() => {
    if (activeId === null && !list.loading)
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, list.loading, list.rows]);
  const selectedCount = countSelected(selection, list.total);
  const setEnabled = async (enabled: boolean) => {
    try {
      const result = await window.nestor.jobs.run("set_sites_enabled", {
        text,
        filter,
        enabled,
        selection: selection.all
          ? { all: true, except: [...selection.ids] }
          : { ids: [...selection.ids] },
      });
      setSelection(NO_SELECTION);
      showToast({
        title: `Turned ${enabled ? "on" : "off"} ${result.changed} site${result.changed === 1 ? "" : "s"}`,
      });
    } catch (reason) {
      showToast({
        title:
          reason instanceof Error ? reason.message : "Could not update sites.",
        tone: "warning",
      });
    }
  };
  return (
    <section className="grid gap-4" aria-label="Job sources">
      <AddSites
        onAdded={(id) => {
          setActiveId(id);
        }}
      />
      {(list.error ?? detailError) ? (
        <p role="alert">{list.error ?? detailError}</p>
      ) : null}
      <div className="h-[min(680px,72vh)] min-h-96">
        <ListDetailLayout
          list={
            <ListPane
              label="Job sources"
              noun="site"
              rows={list.rows}
              total={list.total}
              totalCapped={false}
              loading={list.loading}
              hasMore={false}
              onLoadMore={() => {}}
              activeId={activeId}
              selection={selection}
              selectedCount={selectedCount}
              onSelectAll={() => setSelection(selectAll())}
              onClearSelection={() => setSelection(NO_SELECTION)}
              toolbar={
                <>
                  <Input
                    aria-label="Find a source"
                    placeholder="Find a source"
                    size="toolbar"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <select
                    aria-label="Source filter"
                    className="h-8 rounded border bg-transparent px-2 text-xs"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as typeof filter)
                    }
                  >
                    <option value="all">All</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                    <option value="needs_attention">Needs attention</option>
                  </select>
                </>
              }
              bulkActions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void setEnabled(true);
                    }}
                  >
                    Turn on
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void setEnabled(false);
                    }}
                  >
                    Turn off
                  </Button>
                </>
              }
              renderRow={(row, state) => (
                <ListRowFrame
                  {...state}
                  id={row.id}
                  title={row.label}
                  meta={row.url}
                  status={
                    row.health === "unknown"
                      ? "Not searched yet"
                      : row.health.replaceAll("_", " ")
                  }
                  badge={
                    <span className="text-xs">
                      {row.enabled ? "On" : "Off"}
                    </span>
                  }
                  onActivate={setActiveId}
                  onToggle={(id, shift) =>
                    setSelection((current) =>
                      toggleSelection(current, id, shift, list.rows),
                    )
                  }
                />
              )}
              empty={
                <p>
                  {text
                    ? "No sources match that search."
                    : "Add the job sites you use, and searches look at them."}
                </p>
              }
            />
          }
          detail={
            site ? (
              <ProfileDiscoveryTargetRow
                key={site.id}
                {...props}
                target={site}
                instructionArtifact={
                  props.sourceInstructionArtifacts.find(
                    (artifact) =>
                      artifact.id ===
                      (site.validatedInstructionId ?? site.draftInstructionId),
                  ) ?? null
                }
                onRemoved={() =>
                  setActiveId(
                    list.rows.find((row) => row.id !== site.id)?.id ?? null,
                  )
                }
              />
            ) : (
              <section
                aria-label="Site details"
                className="surface-panel-shell grid place-items-center rounded-(--radius-panel) border p-6 text-sm text-foreground-muted"
              >
                Pick a site to see it here.
              </section>
            )
          }
        />
      </div>
      {list.total > 25 ? (
        <nav
          aria-label="Source pages"
          className="flex items-center justify-between gap-3"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={list.pageIndex === 0 || list.loading}
            onClick={() => {
              setActiveId(null);
              list.previous();
            }}
          >
            Previous sources
          </Button>
          <span className="text-sm">
            {list.pageIndex * 25 + 1}–{list.pageIndex * 25 + list.rows.length}{" "}
            of {list.total}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!list.nextCursor || list.loading}
            onClick={() => {
              setActiveId(null);
              list.next();
            }}
          >
            Next sources
          </Button>
        </nav>
      ) : null}
    </section>
  );
}

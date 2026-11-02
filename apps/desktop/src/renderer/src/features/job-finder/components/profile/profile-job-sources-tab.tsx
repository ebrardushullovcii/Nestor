import { useEffect, useState } from "react";
import type { SourceInstructionArtifact } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useToast } from "@renderer/components/ui/toast";
import {
  EmptyPane,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  clearSelected,
  countSelected,
  stepSelectAll,
  toggleSelection,
  useListKeys,
  type ListSelection,
} from "@renderer/features/job-lists";
import { useSitePage } from "@renderer/features/job-lists/use-site-page";
import { useSiteDetail } from "@renderer/features/job-lists/use-site-detail";
import { AddSites } from "@renderer/features/job-lists/add-sites";
import { ListEmpty } from "@renderer/features/job-lists/list-empty";

/** A source's health in a sentence-case word or two. */
function describeHealth(health: string): string {
  if (health === "unknown") return "Not searched yet";
  const words = health.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
import {
  ProfileDiscoveryTargetRow,
  type SiteDebugActions,
} from "./profile-discovery-target-row";
import { SiteIcon } from "../site-icon";

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
    setSelection(clearSelected);
    setActiveId(null);
  }, [text, filter]);
  useEffect(() => {
    if (activeId === null && !list.loading)
      setActiveId(list.rows[0]?.id ?? null);
  }, [activeId, list.loading, list.rows]);
  const selectedCount = countSelected(selection, list.total);
  const [changing, setChanging] = useState<boolean | null>(null);
  useListKeys({
    rows: list.rows,
    activeId,
    setActiveId,
    toggle: (id, shift) =>
      setSelection((current) => toggleSelection(current, id, shift, list.rows)),
    selectAll: () =>
      setSelection((current) =>
        stepSelectAll(
          current,
          list.rows,
          list.nextCursor === null && list.rows.length >= list.total,
        ),
      ),
    clearSelection: () => setSelection(NO_SELECTION),
  });
  const setEnabled = async (enabled: boolean) => {
    setChanging(enabled);
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
        title: `Turned ${enabled ? "on" : "off"} ${result.changed.toLocaleString()} site${result.changed === 1 ? "" : "s"}`,
        tone: "success",
      });
    } catch (reason) {
      showToast({
        title:
          reason instanceof Error ? reason.message : "Could not update sites.",
        tone: "warning",
      });
    } finally {
      setChanging(null);
    }
  };
  return (
    <section
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      aria-label="Job sites"
    >
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
              label="Job sites"
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
              onSelectionChange={setSelection}
              toolbar={
                <>
                  <Input
                    aria-label="Find a site"
                    className="min-w-0 flex-1"
                    placeholder="Find a site"
                    size="toolbar"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <select
                    aria-label="Site filter"
                    className="h-8 rounded-(--radius-button) border border-(--control-border) bg-transparent px-2 text-(length:--text-small)"
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
                    aria-label={`Turn on ${selectedCount.toLocaleString()} selected`}
                    disabled={changing !== null}
                    pending={changing === true}
                    size="toolbar"
                    onClick={() => {
                      void setEnabled(true);
                    }}
                  >
                    Turn on
                  </Button>
                  <Button
                    aria-label={`Turn off ${selectedCount.toLocaleString()} selected`}
                    disabled={changing !== null}
                    pending={changing === false}
                    size="toolbar"
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
                  titleLead={<SiteIcon url={row.url} />}
                  meta={row.url}
                  status={describeHealth(row.health)}
                  nameParts={{ badge: row.enabled ? "On" : "Off" }}
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
                text ? (
                  <ListEmpty
                    action={{
                      label: "Clear filter",
                      onClick: () => setText(""),
                    }}
                    title={`No site matches “${text.trim()}”`}
                  />
                ) : filter !== "all" ? (
                  <ListEmpty
                    action={{
                      label: "Show all sites",
                      onClick: () => setFilter("all"),
                    }}
                    title="No site fits this filter"
                  />
                ) : (
                  <ListEmpty
                    detail="Searches look at the job sites you add above."
                    title="No job sites yet"
                  />
                )
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
              <EmptyPane label="Site details">
                Pick a site to see it here.
              </EmptyPane>
            )
          }
        />
      </div>
      {list.total > 25 ? (
        <nav
          aria-label="Site pages"
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
            Previous sites
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
            Next sites
          </Button>
        </nav>
      ) : null}
    </section>
  );
}

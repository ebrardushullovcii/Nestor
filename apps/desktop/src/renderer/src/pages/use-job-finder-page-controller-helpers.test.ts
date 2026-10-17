// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import { describe, expect, it } from "vitest";

import {
  getLatestApplicationAttempt,
  useApplicationSelection,
  useRetainedSelection,
} from "./use-job-finder-page-controller-helpers";

describe("getLatestApplicationAttempt", () => {
  it("selects the latest attempt for the exact application record, not a job sibling", () => {
    const workspace = {
      applicationRecords: [
        { id: "application_a", jobId: "job_1" },
        { id: "application_b", jobId: "job_1" },
      ],
      applicationAttempts: [
        {
          id: "attempt_b_newer",
          applicationRecordId: "application_b",
          jobId: "job_1",
          updatedAt: "2026-08-23T12:00:00.000Z",
        },
        {
          id: "attempt_a_latest",
          applicationRecordId: "application_a",
          jobId: "job_1",
          updatedAt: "2026-08-23T11:00:00.000Z",
        },
        {
          id: "attempt_a_older",
          applicationRecordId: "application_a",
          jobId: "job_1",
          updatedAt: "2026-08-23T10:00:00.000Z",
        },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot;

    const result = getLatestApplicationAttempt(workspace, "application_a");

    expect(result.selectedApplicationRecord?.id).toBe("application_a");
    expect(result.selectedApplicationAttempt?.id).toBe("attempt_a_latest");
  });

  it("does not guess from array order when an explicit record is unavailable", () => {
    const workspace = {
      applicationRecords: [{ id: "application_a", jobId: "job_1" }],
      applicationAttempts: [
        {
          id: "attempt_a",
          applicationRecordId: "application_a",
          jobId: "job_1",
          updatedAt: "2026-08-23T11:00:00.000Z",
        },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot;

    expect(
      getLatestApplicationAttempt(workspace, "application_missing"),
    ).toEqual({
      selectedApplicationAttempt: null,
      selectedApplicationRecord: null,
    });
  });
});

type RetainedSelectionInput = Parameters<typeof useRetainedSelection>[0];

describe("useRetainedSelection", () => {
  const campaignSelection: RetainedSelectionInput = {
    snapshotValue: "job_a",
    validIds: ["job_a", "job_b", "job_c"],
    activeCampaignId: "campaign_1",
  };

  function renderRetainedSelection(initialInput: RetainedSelectionInput) {
    return renderHook(
      (input: RetainedSelectionInput) => useRetainedSelection(input),
      { initialProps: initialInput },
    );
  }

  it("keeps a valid local selection when a refresh reorders results", () => {
    const { result, rerender } = renderRetainedSelection(campaignSelection);

    act(() => {
      result.current[1]("job_c");
    });
    expect(result.current[0]).toBe("job_c");

    // Background refresh reorders the collection and its first-row default
    // moves back to job_a; the inspected job must not be stolen.
    rerender({
      snapshotValue: "job_a",
      validIds: ["job_c", "job_a", "job_b"],
      activeCampaignId: "campaign_1",
    });

    expect(result.current[0]).toBe("job_c");
  });

  it("adopts the snapshot default when the selected job is removed", () => {
    const { result, rerender } = renderRetainedSelection(campaignSelection);

    act(() => {
      result.current[1]("job_c");
    });

    rerender({
      snapshotValue: "job_a",
      validIds: ["job_a", "job_b"],
      activeCampaignId: "campaign_1",
    });

    expect(result.current[0]).toBe("job_a");
  });

  it("does not retain a job outside scope across an active campaign change", () => {
    const { result, rerender } = renderRetainedSelection(campaignSelection);

    act(() => {
      result.current[1]("job_b");
    });
    expect(result.current[0]).toBe("job_b");

    // job_b still exists in the workspace-wide collection after the switch,
    // but the new campaign's own default must win over the stale pick.
    rerender({
      snapshotValue: "job_d",
      validIds: ["job_b", "job_d"],
      activeCampaignId: "campaign_2",
    });

    expect(result.current[0]).toBe("job_d");
  });

  it("honors an explicitly requested selection and keeps it across refreshes", () => {
    const { result, rerender } = renderRetainedSelection(campaignSelection);

    // Hydration-style default lands before any explicit navigation.
    expect(result.current[0]).toBe("job_a");

    act(() => {
      result.current[1]("job_b");
    });

    rerender(campaignSelection);

    expect(result.current[0]).toBe("job_b");
  });

  it("adopts the collection default while no selection is held locally", () => {
    const { result, rerender } = renderRetainedSelection({
      snapshotValue: null,
      validIds: [],
      activeCampaignId: "campaign_1",
    });

    expect(result.current[0]).toBeNull();

    // Bootstrap hands over to a hydrated snapshot that carries a default.
    rerender({
      snapshotValue: "job_a",
      validIds: ["job_a", "job_b"],
      activeCampaignId: "campaign_1",
    });

    expect(result.current[0]).toBe("job_a");
  });
});

const INSPECTED_SELECTION_STORAGE_KEY =
  "nordri.job-finder.inspected-job-selections";

type InspectedSelectionSurfaceForTest = "discovery" | "review";

class InspectedSelectionStorageStub {
  private readonly backing = new Map<string, string>();
  setItemCalls = 0;

  getItem(key: string): string | null {
    return this.backing.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setItemCalls += 1;
    this.backing.set(key, value);
  }

  removeItem(key: string): void {
    this.backing.delete(key);
  }

  seedDocument(raw: string): void {
    this.backing.set(INSPECTED_SELECTION_STORAGE_KEY, raw);
  }

  rawDocument(): string | null {
    return this.backing.get(INSPECTED_SELECTION_STORAGE_KEY) ?? null;
  }

  inspectedEntry(
    surface: InspectedSelectionSurfaceForTest,
    campaignId: string,
  ): string | null {
    const raw = this.rawDocument();
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      entries?: Record<string, string | undefined>;
    };
    return parsed.entries?.[`${surface}:${campaignId}`] ?? null;
  }
}

function seededDocument(entries: Record<string, string>, version = 1): string {
  return JSON.stringify({ version, entries });
}

describe("useRetainedSelection persistence", () => {
  function persistedInput(input: {
    storage: InspectedSelectionStorageStub;
    surface?: InspectedSelectionSurfaceForTest;
    collectionReady?: boolean;
    snapshotValue: string | null;
    validIds: readonly string[];
    activeCampaignId: string | null;
  }) {
    const {
      storage,
      surface = "discovery",
      collectionReady = true,
      ...selection
    } = input;
    return {
      ...selection,
      persistedSelection: { storage, surface, collectionReady },
    };
  }

  type PersistedHookProps = Parameters<typeof useRetainedSelection>[0];

  function renderPersistedSelection(initialProps: PersistedHookProps) {
    return renderHook(
      (props: PersistedHookProps) => useRetainedSelection(props),
      { initialProps },
    );
  }

  it("restores the persisted pick once the hydrated collection can validate it", () => {
    const storage = new InspectedSelectionStorageStub();
    storage.seedDocument(seededDocument({ "discovery:campaign_1": "job_b" }));

    // Restart starts at bootstrap: collections are deferred, so restoration
    // waits instead of judging against an empty collection.
    const { result, rerender } = renderPersistedSelection(
      persistedInput({
        storage,
        collectionReady: false,
        snapshotValue: null,
        validIds: [],
        activeCampaignId: "campaign_1",
      }),
    );
    expect(result.current[0]).toBeNull();

    rerender(
      persistedInput({
        storage,
        collectionReady: true,
        snapshotValue: "job_a",
        validIds: ["job_a", "job_b", "job_c"],
        activeCampaignId: "campaign_1",
      }),
    );
    expect(result.current[0]).toBe("job_b");

    // Keeping a restored pick writes nothing: storage already agrees.
    expect(storage.setItemCalls).toBe(0);

    // A true remount (fresh hook over the same storage) restores again.
    const remounted = renderPersistedSelection(
      persistedInput({
        storage,
        snapshotValue: "job_c",
        validIds: ["job_a", "job_b", "job_c"],
        activeCampaignId: "campaign_1",
      }),
    );
    expect(remounted.result.current[0]).toBe("job_b");
    remounted.unmount();
  });

  it("loads each campaign's own persisted pick without cross-scope flash", () => {
    const storage = new InspectedSelectionStorageStub();
    storage.seedDocument(
      seededDocument({
        "discovery:campaign_1": "job_b",
        "discovery:campaign_2": "job_d",
      }),
    );

    const base = {
      storage,
      snapshotValue: "job_a",
      validIds: ["job_a", "job_b", "job_d"],
    };
    const { result, rerender } = renderPersistedSelection(
      persistedInput({ ...base, activeCampaignId: "campaign_1" }),
    );
    expect(result.current[0]).toBe("job_b");

    // Switching campaigns resolves the new scope's own pick directly; the
    // previous campaign's job never appears under the new scope.
    rerender(persistedInput({ ...base, activeCampaignId: "campaign_2" }));
    expect(result.current[0]).toBe("job_d");

    rerender(persistedInput({ ...base, activeCampaignId: "campaign_1" }));
    expect(result.current[0]).toBe("job_b");

    // Both scopes stay intact and no redundant writes happened.
    expect(storage.inspectedEntry("discovery", "campaign_1")).toBe("job_b");
    expect(storage.inspectedEntry("discovery", "campaign_2")).toBe("job_d");
    expect(storage.setItemCalls).toBe(0);
  });

  it("falls back safely and self-heals stale, corrupt, and malformed documents", () => {
    const scenarios = [
      { name: "corrupt json", document: "{not-json" },
      {
        name: "unsupported version",
        document: seededDocument({ "discovery:campaign_1": "job_b" }, 99),
      },
      {
        name: "oversized id",
        document: seededDocument({
          "discovery:campaign_1": "job_x".repeat(100),
        }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const storage = new InspectedSelectionStorageStub();
      storage.seedDocument(scenario.document);

      const { result } = renderPersistedSelection(
        persistedInput({
          storage,
          snapshotValue: "job_a",
          validIds: ["job_a", "job_b"],
          activeCampaignId: "campaign_1",
        }),
      );

      expect(result.current[0]).toBe("job_a");

      // An explicit pick rewrites a clean document over the damaged one.
      act(() => {
        result.current[1]("job_b");
      });
      expect(storage.inspectedEntry("discovery", "campaign_1")).toBe("job_b");
      const rewritten: unknown = JSON.parse(storage.rawDocument() ?? "{}");
      expect(
        typeof rewritten === "object" &&
          rewritten !== null &&
          (rewritten as Record<string, unknown>).version,
      ).toBe(1);
    }
  });

  it("persists an explicitly requested selection immediately and skips redundant writes", () => {
    const storage = new InspectedSelectionStorageStub();
    const props = {
      storage,
      snapshotValue: "job_a",
      validIds: ["job_a", "job_b", "job_c"],
      activeCampaignId: "campaign_1",
    };

    const { result, rerender } = renderPersistedSelection(
      persistedInput(props),
    );
    expect(result.current[0]).toBe("job_a");
    expect(storage.rawDocument()).toBeNull();

    act(() => {
      result.current[1]("job_c");
    });
    expect(result.current[0]).toBe("job_c");
    expect(storage.inspectedEntry("discovery", "campaign_1")).toBe("job_c");
    expect(storage.setItemCalls).toBe(1);

    // Background refreshes that keep the pick cause zero extra writes.
    rerender(
      persistedInput({
        ...props,
        snapshotValue: "job_a",
        validIds: ["job_c", "job_a", "job_b"],
      }),
    );
    expect(result.current[0]).toBe("job_c");
    expect(storage.setItemCalls).toBe(1);
  });

  it("prunes the persisted pick when the selected item leaves the collection", () => {
    const storage = new InspectedSelectionStorageStub();
    const props = {
      storage,
      snapshotValue: "job_a",
      validIds: ["job_a", "job_b"],
      activeCampaignId: "campaign_1",
    };

    const { result, rerender } = renderPersistedSelection(
      persistedInput(props),
    );
    act(() => {
      result.current[1]("job_b");
    });
    expect(storage.inspectedEntry("discovery", "campaign_1")).toBe("job_b");

    rerender(
      persistedInput({
        ...props,
        validIds: ["job_a", "job_c"],
        snapshotValue: "job_a",
      }),
    );

    expect(result.current[0]).toBe("job_a");
    expect(storage.inspectedEntry("discovery", "campaign_1")).toBeNull();
  });

  it("fails safely for a null campaign scope without touching storage", () => {
    const storage = new InspectedSelectionStorageStub();
    const { result } = renderPersistedSelection(
      persistedInput({
        storage,
        snapshotValue: null,
        validIds: [],
        activeCampaignId: null,
      }),
    );

    act(() => {
      result.current[1]("job_x");
    });

    // The pick stays in memory only; nothing is written without a scope.
    expect(storage.rawDocument()).toBeNull();
  });
});

describe("application selection", () => {
  it("restores once after hydration and keeps the user's choice during background updates", () => {
    const { result, rerender } = renderHook(
      ({ stored }: { stored: string | null }) =>
        useApplicationSelection(stored),
      { initialProps: { stored: null as string | null } },
    );
    rerender({ stored: "application_a" });
    expect(result.current[0]).toBe("application_a");
    act(() => result.current[1]("application_reviewed"));
    rerender({ stored: "application_waiting" });
    expect(result.current[0]).toBe("application_reviewed");
    rerender({ stored: null });
    expect(result.current[0]).toBe("application_reviewed");
  });
});

import {
  getDefaultCampaignConfiguration,
  JobSearchCampaignSchema,
  type JobSearchCampaignCollection,
} from "@nestor/contracts";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { createTempRepository } from "../file-repository.test-support";
import { createSeed } from "../test-fixtures";
import {
  decodePreferenceSingleton,
  encodePreferenceSingleton,
  ensurePreferenceStorageTables,
} from "./preference-storage";

function plans(ids: string[]): JobSearchCampaignCollection {
  const campaign = JobSearchCampaignSchema.parse({
    ...getDefaultCampaignConfiguration("precision"),
    id: "plan",
    name: "Synthetic plan",
    mode: "precision",
    status: "active",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    searchPreferences: createSeed().searchPreferences,
    jobIds: ids,
    sourceTargetIds: ["source_a", "source_b"],
    progress: { lastUpdatedAt: "2026-10-24T00:00:00.000Z" },
  });
  return {
    activeCampaignId: campaign.id,
    campaigns: [
      campaign,
      { ...campaign, id: "other", jobIds: ["independent"] },
    ],
    notifications: [],
  };
}

test("unchanged campaign saves bind no plans, preferences or memberships and keep the revision", async () => {
  const temp = await createTempRepository("nestor-unchanged-plan-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    const state = plans(["a", "b"]);
    await repo.saveCampaignState(state);
    const revision = () =>
      db
        .prepare(
          "SELECT revision FROM singleton_state WHERE key='campaign_state'",
        )
        .get()!.revision;
    const before = revision();
    const run = vi.spyOn(StatementSync.prototype, "run");
    try {
      await repo.saveCampaignState(structuredClone(state));
      expect(run).not.toHaveBeenCalled();
      expect(revision()).toBe(before);
    } finally {
      run.mockRestore();
    }
    await repo.saveCampaignState({
      ...state,
      campaigns: state.campaigns.map((plan) => ({
        ...plan,
        name: "Changed name",
      })),
    });
    expect(revision()).toBe(Number(before) + 1);
  } finally {
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("retention keeps exact plan order while writing only moved, added and removed memberships", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePreferenceStorageTables(db);
    const ids = Array.from({ length: 3 }, (_, index) => `job_${index}`);
    let state = plans([...ids, "newly_kept"]);
    let encoded = encodePreferenceSingleton(db, "campaign_state", state);
    const read = () => decodePreferenceSingleton(db, "campaign_state", encoded);
    const save = (next: JobSearchCampaignCollection) => {
      encoded = encodePreferenceSingleton(db, "campaign_state", next);
      state = next;
    };
    db.exec(`CREATE TABLE membership_writes(operation TEXT, id TEXT);
      CREATE TRIGGER audit_membership_insert AFTER INSERT ON plan_job_memberships BEGIN INSERT INTO membership_writes VALUES ('insert',NEW.item_id); END;
      CREATE TRIGGER audit_membership_update AFTER UPDATE ON plan_job_memberships BEGIN INSERT INTO membership_writes VALUES ('update',NEW.item_id); END;
      CREATE TRIGGER audit_membership_delete AFTER DELETE ON plan_job_memberships BEGIN INSERT INTO membership_writes VALUES ('delete',OLD.item_id); END;`);
    save({
      ...state,
      campaigns: [
        { ...state.campaigns[0]!, jobIds: ["newly_kept", ...ids] },
        state.campaigns[1]!,
      ],
    });
    expect(read()).toEqual(state);
    expect(db.prepare("SELECT * FROM membership_writes").all()).toEqual([
      { operation: "update", id: "newly_kept" },
    ]);
    save(state);
    expect(
      db.prepare("SELECT count(*) AS n FROM membership_writes").get()!.n,
    ).toBe(1);

    db.exec("DELETE FROM membership_writes");
    const nextIds = [
      "newly_kept",
      ...ids.slice(0, 1),
      "inserted",
      ...ids.slice(2),
    ];
    save({
      ...state,
      campaigns: [
        {
          ...state.campaigns[0]!,
          jobIds: nextIds,
          sourceTargetIds: ["source_b", "source_a"],
        },
        state.campaigns[1]!,
      ],
    });
    expect(read()).toEqual(state);
    expect(
      db.prepare("SELECT * FROM membership_writes ORDER BY operation").all(),
    ).toEqual([
      { operation: "delete", id: "job_1" },
      { operation: "insert", id: "inserted" },
    ]);

    db.exec(`DELETE FROM membership_writes;
      CREATE TRIGGER fail_late_membership BEFORE INSERT ON plan_job_memberships
      WHEN NEW.item_id = 'late_failure' BEGIN SELECT RAISE(ABORT,'membership failure'); END;`);
    const before = read();
    expect(() =>
      save({
        ...state,
        campaigns: [
          {
            ...state.campaigns[0]!,
            name: "Must roll back",
            jobIds: [nextIds.at(-1)!, ...nextIds.slice(0, -1), "late_failure"],
          },
          state.campaigns[1]!,
        ],
      }),
    ).toThrow("membership failure");
    expect(read()).toEqual(before);
    expect(db.prepare("SELECT * FROM membership_writes").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("dense insertions, external rank changes and reopen preserve the complete plan", async () => {
  const temp = await createTempRepository("nestor-plan-order-");
  let repo = await temp.createRepository();
  try {
    let state = plans(["a", "b", "c"]);
    await repo.saveCampaignState(state);
    for (let index = 0; index < 65; index++) {
      const ids = state.campaigns[0]!.jobIds;
      state = {
        ...state,
        campaigns: [
          {
            ...state.campaigns[0]!,
            jobIds: [...ids.slice(0, 2), `insert_${index}`, ...ids.slice(2)],
          },
          state.campaigns[1]!,
        ],
      };
      await repo.saveCampaignState(state);
    }
    expect(await repo.getCampaignState()).toEqual(state);
    const raw = new DatabaseSync(temp.filePath);
    try {
      const ranks = raw
        .prepare(
          "SELECT position FROM plan_job_memberships WHERE plan_id = 'plan' ORDER BY position",
        )
        .all()
        .map((row) => Number(row.position));
      expect(new Set(ranks).size).toBe(state.campaigns[0]!.jobIds.length);
      raw
        .prepare(
          "UPDATE plan_job_memberships SET position = -100 WHERE plan_id = 'plan' AND item_id = 'c'",
        )
        .run();
    } finally {
      raw.close();
    }
    await repo.saveCampaignState(state);
    expect(await repo.getCampaignState()).toEqual(state);
    await repo.close();
    repo = await temp.createRepository();
    expect(await repo.getCampaignState()).toEqual(state);
  } finally {
    await repo.close();
    await temp.cleanup();
  }
});

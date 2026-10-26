import { afterEach, expect, test } from "vitest";
import { CandidateExperienceSchema } from "@nestor/contracts";
import {
  openJobStore,
  createProfileStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "./job-commands";
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = openJobStore(":memory:");
  stores.push(store);
  return { store, run: createJobCommandRunner({ store }) };
}

test("a Profile save commits edited fields and one record together; an invalid goals edit rolls everything back", async () => {
  const { store, run } = setup();
  await run("commit_profile_edits", {
    profile: { fields: { headline: "Analyst" } },
    upsert: [
      {
        collection: "experiences",
        record: CandidateExperienceSchema.parse({
          id: "work",
          title: "Analyst",
          companyName: "Synthetic Lab",
          workMode: [],
        }),
      },
    ],
  });
  expect((await run("get_profile", {})).counts.experiences).toBe(1);
  await run("patch_profile_goals", {
    fields: { "compensation.minimum": 20, "compensation.maximum": 30 },
  });
  await expect(
    run("commit_profile_edits", {
      profile: { fields: { headline: "Should not save" } },
      goals: { fields: { "compensation.maximum": 10 } },
      remove: [{ collection: "experiences", id: "work" }],
    }),
  ).rejects.toThrow();
  expect((await run("get_profile", {})).fields.headline).toBe("Analyst");
  expect(
    createProfileStore(store).records.get("experiences", "work"),
  ).not.toBeNull();
});

test("the four resume levels persist together with the correct writing mode", async () => {
  const { run } = setup();
  for (const approach of [
    "original_resume",
    "conservative",
    "balanced",
    "aggressive",
  ] as const) {
    await run("set_resume_approach", { approach });
    const settings = await run("get_settings", {}),
      goals = await run("get_profile_goals", {});
    expect(settings.resumeApplicationMode).toBe(
      approach === "original_resume" ? "original_resume" : "tailored_per_job",
    );
    if (approach !== "original_resume")
      expect(goals.tailoringMode).toBe(approach);
  }
});

test("a delayed autosave cannot overwrite an Assistant record edit or remove its new record", async () => {
  const { run } = setup();
  const original = {
    collection: "experiences" as const,
    record: CandidateExperienceSchema.parse({
      id: "work",
      title: "Analyst",
      companyName: "Synthetic Lab",
    }),
  };
  await run("upsert_profile_record", original);
  await run("upsert_profile_record", {
    ...original,
    record: { ...original.record, title: "Assistant edit" },
  });
  await expect(
    run("commit_profile_edits", {
      profile: { fields: { headline: "Must roll back" } },
      upsert: [
        { ...original, record: { ...original.record, title: "Delayed form" } },
      ],
      expectedRecords: [
        { collection: "experiences", id: "work", value: original },
      ],
    }),
  ).rejects.toThrow(/changed while you were editing/);
  expect((await run("get_profile", {})).fields.headline).toBeNull();
  expect(
    (await run("get_profile_record", { collection: "experiences", id: "work" }))
      ?.record,
  ).toMatchObject({ title: "Assistant edit" });
  await expect(
    run("commit_profile_edits", {
      remove: [{ collection: "experiences", id: "work" }],
      expectedRecords: [{ collection: "experiences", id: "work", value: null }],
    }),
  ).rejects.toThrow(/changed while/);
});

test("list and goal conflicts reject the whole edit rather than dropping another writer's choices", async () => {
  const { run } = setup();
  await run("patch_profile", { lists: { skills: ["SQL"] } });
  await run("patch_profile_goals", {
    fields: { shiftPreference: "day" },
    lists: { locations: ["Berlin"] },
  });
  const changes = [
    {
      profile: { lists: { skills: ["Excel"] }, expectedLists: { skills: [] } },
    },
    {
      goals: {
        lists: { locations: ["London"] },
        expectedLists: { locations: [] },
      },
    },
    {
      goals: {
        fields: { shiftPreference: "night" as const },
        expected: { shiftPreference: "any" as const },
      },
    },
  ];
  for (const change of changes) {
    await expect(
      run("commit_profile_edits", {
        ...change,
        upsert: [
          {
            collection: "experiences",
            record: CandidateExperienceSchema.parse({
              id: "must-not-save",
              title: "Ignored",
            }),
          },
        ],
      }),
    ).rejects.toThrow(/changed while/);
    expect((await run("get_profile", {})).counts.experiences).toBe(0);
  }
  expect((await run("get_profile", {})).lists.skills).toEqual(["SQL"]);
  expect((await run("get_profile_goals", {})).locations).toEqual(["Berlin"]);
});

test("kept edits remain separate from facts and a completed older save cannot delete newer typing", async () => {
  const { run } = setup();
  await run("put_profile_draft", {
    id: "old",
    edits: { profile: { fields: { headline: "Earlier typing" } } },
  });
  await run("put_profile_draft", {
    id: "new",
    edits: { profile: { fields: { headline: "Kept during conflict" } } },
  });
  expect((await run("get_profile", {})).fields.headline).toBeNull();
  await run("commit_profile_edits", {
    profile: { fields: { headline: "Earlier typing" } },
    draftId: "old",
  });
  expect(
    (await run("get_profile_draft", {}))?.edits.profile?.fields.headline,
  ).toBe("Kept during conflict");
  await run("commit_profile_edits", {
    profile: { fields: { headline: "Kept during conflict" } },
    draftId: "new",
  });
  expect(await run("get_profile_draft", {})).toBeNull();
});

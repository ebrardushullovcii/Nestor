import { expect, test } from "vitest";
import { PreparedApplicationFormSchema } from "./prepared-application-form";

const safe = {
  id: "result",
  label: "Synthetic",
  savedAt: "2026-10-23T10:00:00Z",
  reason: null,
  attachments: [],
  snapshot: {
    url: "https://jobs.example/apply",
    structure: "a".repeat(64),
    fields: [
      {
        type: "text",
        value: "Synthetic answer",
        checked: false,
        selected: [],
        files: [],
        disabled: false,
        readOnly: false,
      },
    ],
  },
};

test("recovery carries answers and opaque structure hashes, with no credential or authority slots", () => {
  expect(PreparedApplicationFormSchema.safeParse(safe).success).toBe(true);
  for (const extra of [
    { cookies: [] },
    { submitAuthorized: true },
    { password: "secret" },
  ])
    expect(
      PreparedApplicationFormSchema.safeParse({ ...safe, ...extra }).success,
    ).toBe(false);
  expect(
    PreparedApplicationFormSchema.safeParse({
      ...safe,
      snapshot: { ...safe.snapshot, structure: "hidden_token=secret" },
    }).success,
  ).toBe(false);
  expect(
    PreparedApplicationFormSchema.safeParse({
      ...safe,
      snapshot: {
        ...safe.snapshot,
        fields: [{ ...safe.snapshot.fields[0], type: "password" }],
      },
    }).success,
  ).toBe(false);
  for (const url of [
    "https://jobs.example/apply?token=secret",
    "https://jobs.example/apply#secret",
    "https://user:password@jobs.example/apply",
  ])
    expect(
      PreparedApplicationFormSchema.safeParse({
        ...safe,
        snapshot: { ...safe.snapshot, url },
      }).success,
    ).toBe(false);
});

import { expect, test } from "vitest";
import type { PreparedFormSnapshot } from "@nestor/contracts";
import {
  describePreparedFormAttachments,
} from "./prepared-form-recovery";

test("saved files resolve to exactly one resume or asset record by name and bytes", () => {
  const sha = "a".repeat(64);
  const snapshot = {
    url: "https://jobs.example/apply",
    structure: "b".repeat(64),
    fields: [
      {
        type: "file",
        value: "",
        checked: false,
        selected: [],
        files: [{ name: "resume.pdf", type: "application/pdf", size: 3, sha256: sha }],
        disabled: false,
        readOnly: false,
      },
    ],
  } as PreparedFormSnapshot;
  const resume = { kind: "resume_export" as const, id: "export", name: "resume.pdf", sha256: sha };
  expect(describePreparedFormAttachments(snapshot, [resume])).toEqual([resume]);
  expect(describePreparedFormAttachments(snapshot, [])).toBeNull();
  expect(
    describePreparedFormAttachments(snapshot, [{ ...resume, sha256: "c".repeat(64) }]),
  ).toBeNull();
  expect(
    describePreparedFormAttachments(snapshot, [resume, { ...resume, kind: "candidate_asset", id: "asset" }]),
  ).toBeNull();
});

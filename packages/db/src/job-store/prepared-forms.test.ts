import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openJobStore, resetJobStore } from "./job-store";
import { createPreparedFormsStore } from "./prepared-forms";

const form = {
  id: "apply_result_1",
  label: "Synthetic Engineer at Example Co",
  savedAt: "2026-10-26T10:00:00.000Z",
  snapshot: null,
  attachments: [],
  reason: null,
};

test("a form Apply filled is still there after a restart, until it is done with", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-prepared-forms-"));
  try {
    const file = path.join(dir, "job-finder.sqlite");
    const first = openJobStore(file);
    createPreparedFormsStore(first).save(form);
    first.close();

    const reopened = openJobStore(file);
    const forms = createPreparedFormsStore(reopened);
    expect(forms.get(form.id)).toEqual(form);
    forms.save({ ...form, reason: "form_changed" });
    expect(forms.get(form.id)?.reason).toBe("form_changed");
    forms.delete(form.id);
    expect(forms.get(form.id)).toBeNull();
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Reset everything clears saved forms", () => {
  const store = openJobStore(":memory:");
  createPreparedFormsStore(store).save(form);
  resetJobStore(store);
  expect(createPreparedFormsStore(store).get(form.id)).toBeNull();
  store.close();
});

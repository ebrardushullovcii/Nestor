import { expect, test } from "vitest";
import { buildApplyFormObservation } from "./page-hands";
import { createApplyProgressGuard } from "./apply-progress";
import recorded from "./synthetic-page.snapshot.json";
import type { RawApplyPage } from "@nestor/contracts";
const page = () =>
  buildApplyFormObservation(recorded as RawApplyPage, "2026-11-06T00:00:00Z");
test("hundreds of changed pages never exhaust a total step budget", () => {
  const guard = createApplyProgressGuard(3);
  for (let n = 0; n < 500; n++) {
    const before = page();
    before.url = `https://example.test/${n}`;
    const after = structuredClone(before);
    after.url = `https://example.test/${n + 1}`;
    expect(
      guard.start(
        "navigate",
        JSON.stringify({ url: after.url }),
        before,
      )(after),
    ).toBe(true);
    expect(guard.stuck).toBe(false);
  }
});
test("the same action on an unchanged page stops, including repeated new invented handles", () => {
  const guard = createApplyProgressGuard(3);
  const current = page();
  for (let n = 0; n < 3; n++)
    guard.start(
      "click",
      JSON.stringify({ ref: `invented-${n}` }),
      current,
    )(current);
  expect(guard.stuck).toBe(true);
});
test("changing another field resets earlier failures and timestamp noise is not progress", () => {
  const guard = createApplyProgressGuard(3);
  const current = page();
  const ref = current.controls[0].ref;
  for (let n = 0; n < 2; n++)
    guard.start(
      "type",
      JSON.stringify({ ref, text: "same" }),
      current,
    )({ ...current, observedAt: new Date(n).toISOString() });
  const after = structuredClone(current);
  after.controls[0].value = "A changed answer";
  expect(
    guard.start(
      "type",
      JSON.stringify({ ref, text: after.controls[0].value }),
      current,
    )(after),
  ).toBe(true);
  expect(guard.stuck).toBe(false);
  guard.start("type", JSON.stringify({ ref, text: "same" }), after)(after);
  expect(guard.stuck).toBe(false);
});

test("waits and reads do not consume repeated-action attempts, and real progress clears a stall", () => {
  const guard = createApplyProgressGuard(3);
  const current = page();
  for (let n = 0; n < 500; n++) {
    guard.start("wait", "{}", current)(current);
    guard.start("observe", "{}", current)(current);
  }
  expect(guard.stuck).toBe(false);
  for (let n = 0; n < 3; n++) guard.start("click", "{}", current)(current);
  expect(guard.stuck).toBe(true);
  const after = structuredClone(current);
  after.controls[0].value = "changed";
  guard.start("observe", "{}", current)(after);
  expect(guard.stuck).toBe(false);
});

test("distinct supported options do not count as repetitions", () => {
  const guard = createApplyProgressGuard(3);
  const current = page();
  for (let n = 0; n < 500; n++)
    guard.start(
      "select",
      JSON.stringify({ ref: current.controls[0].ref, option: `Option ${n}` }),
      current,
    )(current);
  expect(guard.stuck).toBe(false);
});

import { expect, test, vi } from "vitest";
import type { RawApplyPage } from "@nestor/contracts";
import { createKeyboardTools } from "./keyboard-tools";
import { buildApplyFormObservation } from "./apply/page-hands";
import recordedPage from "./apply/synthetic-page.snapshot.json";

test("keyboard schemas return malformed calls without acting, and preserve text and named keys", async () => {
  const typeKeys = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "Prishtina" }),
  );
  const pressKey = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "ArrowDown" }),
  );
  const observe = () =>
    Promise.resolve(
      buildApplyFormObservation(
        recordedPage as RawApplyPage,
        "2026-11-07T00:00:00.000Z",
      ),
    );
  const tools = createKeyboardTools({ typeKeys, pressKey }, observe);
  const run = (name: string, args: unknown) =>
    tools
      .find((tool) => tool.definition.function.name === name)!
      .execute(JSON.stringify(args), { step: 1 });
  for (const [name, args] of [
    ["type_keys", { ref: "c0", text: 3 }],
    ["type_keys", { text: "Prishtina" }],
    ["type_keys", { ref: "c0", text: "Prishtina", cap: 5 }],
    ["press_key", { key: 3 }],
    ["press_key", { ref: null, key: "Enter" }],
  ] as const)
    expect(await run(name, args)).toMatchObject({
      kind: "ok",
      status: "failed",
    });
  expect(typeKeys).not.toHaveBeenCalled();
  expect(pressKey).not.toHaveBeenCalled();
  expect(
    await run("type_keys", { ref: "c0", text: " Prishtina " }),
  ).toMatchObject({ status: "done" });
  expect(typeKeys).toHaveBeenCalledWith("c0", " Prishtina ");
  await run("press_key", { key: "ArrowDown" });
  expect(pressKey).toHaveBeenCalledWith(undefined, "ArrowDown");
});

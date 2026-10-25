import { expect, test } from "vitest";
import { yieldToEventLoop } from "./event-loop-turn";

test("concurrent CPU continuations leave a timer turn between each other", async () => {
  let turn = 0;
  let observing = true;
  const observe = () => {
    turn += 1;
    if (observing) setTimeout(observe, 0);
  };
  setTimeout(observe, 0);
  const turns = await Promise.all(
    Array.from({ length: 8 }, async () => {
      await yieldToEventLoop();
      return turn;
    }),
  );
  observing = false;
  expect(new Set(turns).size).toBe(8);
});

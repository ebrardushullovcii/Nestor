import { expect, test } from "vitest";
import { createHostQueue } from "./host-queue";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("per-host limits leave room for other hosts and queued work resumes after a slot is released", async () => {
  const queue = createHostQueue({ limit: 3, perHost: 1 }),
    a = gate(),
    b = gate(),
    c = gate();
  const signal = new AbortController().signal,
    started: string[] = [];
  const tasks = [
    queue.run("a", signal, async () => {
      started.push("a1");
      await a.promise;
    }),
    queue.run("a", signal, () => {
      started.push("a2");
      return Promise.resolve();
    }),
    queue.run("b", signal, async () => {
      started.push("b");
      await b.promise;
    }),
    queue.run("c", signal, async () => {
      started.push("c");
      await c.promise;
    }),
  ];
  await Promise.resolve();
  expect(started).toEqual(["a1", "b", "c"]);
  expect(queue.active).toBe(3);
  a.release();
  await tasks[0];
  await Promise.resolve();
  expect(started).toContain("a2");
  b.release();
  c.release();
  await Promise.all(tasks);
  await queue.idle();
  expect(queue.active).toBe(0);
});

test("cancelling queued or unresponsive active work releases its slot and consumes late completion", async () => {
  const queue = createHostQueue({ limit: 1, perHost: 1 }),
    hanging = gate(),
    cancel = new AbortController();
  const first = queue
    .run("a", cancel.signal, () => hanging.promise)
    .catch((error: unknown) => error);
  const next = queue.run("b", new AbortController().signal, () =>
    Promise.resolve("readable"),
  );
  cancel.abort();
  expect(await next).toBe("readable");
  await first;
  await queue.idle();
  expect(queue.active).toBe(0);
  hanging.release();
});

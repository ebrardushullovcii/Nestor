import { AsyncLocalStorage } from "node:async_hooks";
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

test("a limit read from a setting applies to the next start", async () => {
  let limit = 1;
  const queue = createHostQueue({ limit: () => limit, perHost: 1 }),
    a = gate(),
    b = gate();
  const signal = new AbortController().signal,
    started: string[] = [];
  const tasks = [
    queue.run("a", signal, async () => {
      started.push("a");
      await a.promise;
    }),
    queue.run("b", signal, async () => {
      started.push("b");
      await b.promise;
    }),
    queue.run("c", signal, () => {
      started.push("c");
      return Promise.resolve();
    }),
  ];
  await Promise.resolve();
  expect(started).toEqual(["a"]);
  limit = 3;
  a.release();
  await tasks[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Both waiting hosts start once the limit allows; their order is fair, not fixed.
  expect([...started].sort()).toEqual(["a", "b", "c"]);
  b.release();
  await Promise.all(tasks);
});

test("queued work runs in the context of the caller that queued it, not the run that released its slot", async () => {
  const queue = createHostQueue({ limit: 4, perHost: 1 });
  const scope = new AsyncLocalStorage<string>();
  const signal = new AbortController().signal;
  const first = gate();
  const seen: (string | undefined)[] = [];
  const read = (listing: string, wait?: Promise<void>) =>
    scope.run(listing, () =>
      queue.run("jobs.example", signal, async () => {
        seen.push(scope.getStore());
        await wait;
        seen.push(scope.getStore());
      }),
    );
  const tasks = [
    read("listing-1", first.promise),
    read("listing-2"),
    read("listing-3"),
  ];
  await Promise.resolve();
  first.release();
  await Promise.all(tasks);
  // Each listing's fetch is recorded under that listing, also when another
  // listing's finished fetch is what let it start.
  expect(seen).toEqual([
    "listing-1",
    "listing-1",
    "listing-2",
    "listing-2",
    "listing-3",
    "listing-3",
  ]);
});

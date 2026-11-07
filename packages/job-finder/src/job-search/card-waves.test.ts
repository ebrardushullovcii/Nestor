import { expect, test, vi } from "vitest";
import type { ListingCard } from "@nestor/contracts";
import { createCardWaves } from "./card-waves";
import { createSearchSourcesStore, openJobStore } from "@nestor/db/job-store";
import { JobSearchSettingsSchema } from "@nestor/contracts";

const card = {
  sourceId: "synthetic",
  url: "https://example.com/job",
  title: "Nurse",
  text: "Nurse",
  sourceLabel: "Synthetic",
  cardFingerprint: "one",
} satisfies ListingCard;

test("a durable backlog acknowledges browser cards immediately while a slow source is screening", async () => {
  const store = openJobStore(":memory:");
  const search = store.searches.start(JobSearchSettingsSchema.parse({}), 2);
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read: string[] = [];
  const queue = createSearchSourcesStore(store).cardQueue(search.id);
  const waves = createCardWaves(
    controller.signal,
    async (cards) => {
      if (cards[0]!.sourceId === "slow") await gate;
      read.push(...cards.map((card) => card.url));
    },
    2,
    queue,
  );
  const cards = Array.from({ length: 3201 }, (_, i) => ({
    ...card,
    sourceId: "slow",
    url: `https://slow.example/${i}`,
  }));
  try {
    await waves.push(cards); // Does not await screening or consume 180 seconds of tool idle.
    expect(
      createSearchSourcesStore(store).cardUrls(search.id, "slow"),
    ).toHaveLength(3201);
    await waves.push([
      { ...card, sourceId: "healthy", url: "https://healthy.example/one" },
    ]);
    await waves.checkpoint("healthy");
    expect(read).toEqual(["https://healthy.example/one"]);
    release();
    await waves.drain();
    expect(read).toHaveLength(3202);
  } finally {
    release();
    controller.abort();
    store.close();
  }
});

test("a checkpoint flushes a small page, then restores pooling for later pages", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  try {
    const consume = vi.fn(() => Promise.resolve());
    const waves = createCardWaves(controller.signal, consume);
    await waves.push([card]);
    expect(consume).not.toHaveBeenCalled();
    await waves.checkpoint();
    expect(consume).toHaveBeenCalledTimes(1);
    await waves.push([card]);
    expect(consume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(consume).toHaveBeenCalledTimes(2);
    await waves.drain();
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});

test("Stop releases a checkpoint waiting on processing", async () => {
  const controller = new AbortController();
  const waves = createCardWaves(controller.signal, () => new Promise(() => {}));
  await waves.push([card]);
  const check = expect(waves.checkpoint()).rejects.toThrow("Stopped");
  controller.abort(new Error("Stopped"));
  await check;
});

test("a processing error reaches its checkpoint", async () => {
  const controller = new AbortController();
  try {
    const waves = createCardWaves(controller.signal, () =>
      Promise.reject(new Error("Screen failed")),
    );
    await waves.push([card]);
    await expect(waves.checkpoint()).rejects.toThrow("Screen failed");
  } finally {
    controller.abort();
  }
});

test("a blocked source does not hold current or later healthy waves or its checkpoint", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const consumed: string[][] = [];
  const waves = createCardWaves(
    controller.signal,
    async (cards) => {
      if (cards[0]!.sourceId === "slow") await blocked;
      consumed.push(cards.map((row) => row.url));
    },
    2,
  );
  try {
    await waves.push([
      { ...card, sourceId: "slow", url: "slow" },
      { ...card, sourceId: "healthy", url: "first" },
    ]);
    await waves.checkpoint("healthy");
    expect(consumed).toEqual([["first"]]);
    await waves.push([{ ...card, sourceId: "healthy", url: "later" }]);
    await waves.checkpoint("healthy");
    expect(consumed).toEqual([["first"], ["later"]]);
    let allDone = false;
    const all = waves.checkpoint().then(() => {
      allDone = true;
    });
    await Promise.resolve();
    expect(allDone).toBe(false);
    release();
    await all;
    await waves.drain();
    expect(consumed).toEqual([["first"], ["later"], ["slow"]]);
  } finally {
    release();
    controller.abort();
  }
});

test("source waves are serial and total active work stays bounded", async () => {
  const controller = new AbortController();
  const releases: (() => void)[] = [];
  const active = new Set<string>();
  const starts: string[] = [];
  const waves = createCardWaves(
    controller.signal,
    async (cards) => {
      const source = cards[0]!.sourceId;
      expect(active.has(source)).toBe(false);
      active.add(source);
      starts.push(source);
      expect(active.size).toBeLessThanOrEqual(2);
      await new Promise<void>((resolve) => releases.push(resolve));
      active.delete(source);
    },
    2,
  );
  await waves.push(
    Array.from({ length: 401 }, (_, i) => ({
      ...card,
      sourceId: "one",
      url: String(i),
    })),
  );
  await waves.push([
    { ...card, sourceId: "two" },
    { ...card, sourceId: "three" },
  ]);
  const drained = waves.drain();
  await vi.waitFor(() => expect(starts).toEqual(["one", "two"]));
  releases.shift()!();
  await vi.waitFor(() => expect(starts).toHaveLength(3));
  releases.shift()!();
  await vi.waitFor(() => expect(starts).toHaveLength(4));
  for (const release of releases.splice(0)) release();
  await drained;
  controller.abort();
});

test("backpressure accepts and drains every card beyond 2000 without dropping work", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const waves = createCardWaves(controller.signal, async (cards) => {
    await gate;
    received.push(...cards.map((card) => card.url));
  });
  const cards = Array.from({ length: 3201 }, (_, i) => ({
    ...card,
    url: `https://example.test/job/${i}`,
  }));
  try {
    let accepted = false;
    const pushing = waves.push(cards).then(() => {
      accepted = true;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(received).toEqual([]);
    release();
    await pushing;
    await waves.drain();
    expect(received).toEqual(cards.map((card) => card.url));
  } finally {
    release();
    controller.abort();
  }
});

import { afterEach, describe, expect, test } from "vitest";
import { createDiscoveryCpuPool } from "./discovery-cpu-pool";
import {
  DISCOVERY_READER_LOST_ERROR,
  type DiscoveryFeedTask,
} from "@nestor/contracts";

const entry = new URL(
  `data:text/javascript,${encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', async ({id, task:wire}) => {
    const task = wire.input;
    const text = typeof task.payload === 'string' ? task.payload : new TextDecoder().decode(task.payload);
    if (text === 'crash') process.exit(2);
    if (text === 'wait') await new Promise(r => setTimeout(r, 10000));
    parentPort.postMessage(text === 'error' ? {id,error:'Unreadable feed'} : {id,result:{kind:'feed',result:{jobs:[],preparations:[],skippedMalformedCount:Number(text) || 0}}});
  });
`)}`,
);
const task = (payload: string | Uint8Array) =>
  ({ payload }) as DiscoveryFeedTask;
const pools: ReturnType<typeof createDiscoveryCpuPool>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});
const pool = () => {
  const value = createDiscoveryCpuPool(entry, 1);
  pools.push(value);
  return value;
};

describe("discovery CPU reader pool", () => {
  test("transfers owned feed bytes without retaining a second main-process payload", async () => {
    const p = pool();
    const bytes = new TextEncoder().encode("10");
    const result = await p.run(task(bytes));
    expect(result.skippedMalformedCount).toBe(10);
    expect(bytes.byteLength).toBe(0);
  });
  test("routes queued responses to the right request and reuses the reader", async () => {
    const p = pool();
    const results = await Promise.all([
      p.run(task("1")),
      p.run(task("2")),
      p.run(task("3")),
    ]);
    expect(results.map((result) => result.skippedMalformedCount)).toEqual([
      1, 2, 3,
    ]);
  });
  test("a malformed feed rejects only that request", async () => {
    const p = pool();
    await expect(p.run(task("error"))).rejects.toThrow("Unreadable feed");
    expect((await p.run(task("4"))).skippedMalformedCount).toBe(4);
  });
  test("cancels queued and active work without retaining a feed or wedging the pool", async () => {
    const p = pool();
    const active = new AbortController();
    const queued = new AbortController();
    const first = expect(
      p.run(task("wait"), active.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const second = expect(
      p.run(task("5"), queued.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    queued.abort();
    active.abort();
    await Promise.all([first, second]);
    expect((await p.run(task("6"))).skippedMalformedCount).toBe(6);
  });
  test("replaces a crashed reader and rejects all outstanding work at shutdown", async () => {
    const p = pool();
    await expect(p.run(task("crash"))).rejects.toMatchObject({
      name: DISCOVERY_READER_LOST_ERROR,
      message: "Feed reader exited (2).",
    });
    await expect(p.run(task("error"))).rejects.not.toMatchObject({
      name: DISCOVERY_READER_LOST_ERROR,
    });
    expect((await p.run(task("7"))).skippedMalformedCount).toBe(7);
    const pending = expect(p.run(task("wait"))).rejects.toMatchObject({
      name: "AbortError",
    });
    await p.close();
    await pending;
    await expect(p.run(task("8"))).rejects.toThrow("closed");
  });
});

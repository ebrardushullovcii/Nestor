// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import { readEveryMatchingTask } from "./needs-you-screen";

function task(id: number, url?: string) {
  return {
    id,
    kind: url ? "sign_in" : "question",
    prompt: `Item ${id}`,
    source: url ? { id: id * 10, url, label: url } : null,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, "nestor");
});

it("reads every matching item past the loaded pages, sites merged as the list shows them", async () => {
  const pages: Record<string, ReturnType<typeof task>[][]> = {
    applications: [
      Array.from({ length: 200 }, (_, index) => task(index + 1)),
      [task(201), task(202)],
    ],
    sites: [
      [
        task(300, "https://a.example.test/jobs"),
        task(301, "https://a.example.test/careers"),
        task(302, "https://b.example.test/"),
      ],
    ],
  };
  const run = vi.fn(
    (_name: string, input: { group: string; after: number }) => {
      const group = pages[input.group]!;
      const index = input.after === 0 ? 0 : 1;
      return Promise.resolve({
        rows: group[index] ?? [],
        nextCursor: index + 1 < group.length ? 200 : null,
        total: 0,
        totalCapped: false,
      });
    },
  );
  Object.assign(window, { nestor: { needsYou: { run } } });
  const rows = await readEveryMatchingTask({ text: "", kind: null });
  // 202 questions over two pages, and two sites (a.example.test's two
  // sign-ins are one row).
  expect(rows).toHaveLength(204);
  expect(run).toHaveBeenCalledWith(
    "list_needs_you",
    expect.objectContaining({ group: "applications", after: 200 }),
  );
});

it("fails as a whole when a page cannot be read, so no part is started", async () => {
  Object.assign(window, {
    nestor: {
      needsYou: {
        run: () => Promise.reject(new Error("The store could not be read")),
      },
    },
  });
  await expect(readEveryMatchingTask({ text: "", kind: null })).rejects.toThrow(
    "could not be read",
  );
});

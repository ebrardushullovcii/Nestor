import { describe, expect, it } from "vitest";
import {
  searchJobFinderEntries,
  type JobFinderGlobalSearchEntry,
} from "./job-finder-global-search";

const entries: readonly JobFinderGlobalSearchEntry[] = [
  {
    href: "/job-finder/discovery?job=1",
    id: "job:1",
    kind: "job",
    metadata: ["TypeScript", "remote"],
    subtitle: "Acme · Remote",
    title: "Platform Engineer",
  },
  {
    href: "/job-finder/applications?jobId=2",
    id: "job:2",
    kind: "application",
    metadata: ["applied"],
    subtitle: "Example · Applied",
    title: "Frontend Engineer",
  },
];

describe("searchJobFinderEntries", () => {
  it("searches metadata and groups results", () => {
    expect(searchJobFinderEntries(entries, "typescript")).toEqual([
      { entries: [entries[0]], kind: "job" },
    ]);
  });

  it("keeps what another search found without matching it again", () => {
    const screen: JobFinderGlobalSearchEntry = {
      href: "/job-finder/settings",
      id: "screen:settings",
      kind: "screen",
      metadata: [],
      subtitle: "Applying, AI, appearance",
      title: "Settings",
    };
    expect(
      searchJobFinderEntries([screen], "frontend", { found: [entries[1]!] }),
    ).toEqual([{ entries: [entries[1]], kind: "application" }]);
  });

  it("keeps the first match when the result limit is one", () => {
    expect(searchJobFinderEntries(entries, "engineer", { limit: 1 })).toEqual([
      { entries: [entries[0]], kind: "job" },
    ]);
  });

  it("keeps screen and application results reachable when many jobs match", () => {
    const manyJobs = Array.from({ length: 50 }, (_, index) => ({
      ...entries[0]!,
      id: `job-${index}`,
    }));
    const application = { ...entries[1]!, title: "Platform application" };
    const screen: JobFinderGlobalSearchEntry = {
      href: "/job-finder/discovery",
      id: "screen:discovery",
      kind: "screen",
      metadata: ["platform"],
      subtitle: "Search and triage",
      title: "Find jobs",
    };

    const groups = searchJobFinderEntries(
      [...manyJobs, application, screen],
      "platform",
      { limit: 5 },
    );

    expect(groups.flatMap((group) => group.entries)).toHaveLength(5);
    expect(groups.map((group) => group.kind)).toEqual([
      "screen",
      "job",
      "application",
    ]);
  });
});

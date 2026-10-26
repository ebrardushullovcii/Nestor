import type {
  DesktopJobsBridge,
  JobSite,
  JobSitePage,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

type AppWindow = { nestor: { jobs: DesktopJobsBridge } };
const readSites = (page: Page) =>
  page.evaluate(async () => {
    const jobs = (window as unknown as AppWindow).nestor.jobs;
    const rows: JobSite[] = [];
    let cursor: string | null = null;
    do {
      const result: JobSitePage = await jobs.run("list_sites", {
        cursor,
        limit: 100,
      });
      rows.push(...result.rows);
      cursor = result.nextCursor;
    } while (cursor);
    return rows;
  });

/** Every write is requested in chat; direct reads only judge the stored result. */
export function siteOutcomeCases(replicaOrigin: string): BuiltAppBatch[] {
  const origin = new URL(replicaOrigin).origin;
  const urlA = `${origin}/outcome-source-a/`;
  const urlB = `${origin}/outcome-source-b/`;
  const changedUrl = `${origin}/outcome-source-a-edited/`;
  let untouched: JobSite[] = [];
  let removed: JobSite | undefined;
  const otherRows = async (page: Page) =>
    (await readSites(page)).filter((row) =>
      untouched.some((before) => before.id === row.id),
    );
  const preserve = async (page: Page) =>
    equalOutcome(
      "unchanged",
      "Unrelated sources preserved",
      "jobs.list_sites: pre-existing rows",
      await otherRows(page),
      untouched,
    );
  const a = async (page: Page) =>
    (await readSites(page)).find(
      (row) => row.url === changedUrl || row.url === urlA,
    );
  const b = async (page: Page) =>
    (await readSites(page)).find((row) => row.url === urlB);
  return [
    {
      id: "sites-add",
      prepare: async (page) => {
        untouched = await readSites(page);
        if (untouched.some((row) => [urlA, urlB, changedUrl].includes(row.url)))
          throw Error("Source outcome fixtures must start absent");
      },
      request: `Add both these synthetic job sources and turn them on: ${urlA}\n${urlB}. Preserve my existing sources.`,
      actions: [
        {
          actionId: "sites.add",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Both sources saved and enabled",
              "jobs.list_sites",
              (await readSites(page))
                .filter((row) => [urlA, urlB].includes(row.url))
                .map((row) => ({ url: row.url, enabled: row.enabled }))
                .sort((left, right) => left.url.localeCompare(right.url)),
              [
                { url: urlA, enabled: true },
                { url: urlB, enabled: true },
              ],
            ),
            await preserve(page),
          ],
        },
      ],
    },
    {
      id: "sites-edit",
      requires: ["sites-add"],
      request: `For source ${urlA}, change its label to "Outcome source A", its URL to ${changedUrl}, and its custom instructions to "Synthetic source guidance: inspect the listing text." Leave the second source and every other source alone.`,
      actions: [
        ["rename", "label", "Outcome source A"],
        ["url", "url", changedUrl],
        [
          "instructions",
          "customInstructions",
          "Synthetic source guidance: inspect the listing text.",
        ],
      ].map(([actionId, field, expected]) => ({
        actionId: `sites.${actionId}`,
        observe: async (page) => [
          equalOutcome(
            "data",
            `Saved ${field}`,
            `jobs.get_site.${field}`,
            (await a(page))?.[field as keyof JobSite],
            expected,
          ),
          equalOutcome(
            "data",
            "Second source retained",
            "jobs.list_sites",
            Boolean(await b(page)),
            true,
          ),
          await preserve(page),
        ],
      })),
    },
    ...([false, true] as const).map(
      (enabled): BuiltAppBatch => ({
        id: `sites-${enabled ? "enable" : "disable"}`,
        requires: [enabled ? "sites-disable" : "sites-edit"],
        request: `${enabled ? "Enable" : "Disable"} only the source ${changedUrl}.`,
        actions: [
          {
            actionId: `sites.${enabled ? "enable" : "disable"}`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Source enabled setting",
                "jobs.get_site.enabled",
                (await a(page))?.enabled,
                enabled,
              ),
              equalOutcome(
                "data",
                "Second source still enabled",
                "jobs.get_site.enabled",
                (await b(page))?.enabled,
                true,
              ),
              await preserve(page),
            ],
          },
        ],
      }),
    ),
    {
      id: "sites-disable-all",
      requires: ["sites-enable"],
      request: `Disable all job sources whose URL contains "outcome-source". Keep every other source enabled as before.`,
      actions: [
        {
          actionId: "sites.disable_all",
          observe: async (page) => [
            equalOutcome(
              "data",
              "All matching sources disabled",
              "jobs.list_sites",
              [(await a(page))?.enabled, (await b(page))?.enabled],
              [false, false],
            ),
            await preserve(page),
          ],
        },
      ],
    },
    {
      id: "sites-enable-selected",
      requires: ["sites-disable-all"],
      request: `Enable these two sources only: ${changedUrl} and ${urlB}.`,
      actions: [
        {
          actionId: "sites.enable_selected",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Both selected sources enabled",
              "jobs.list_sites",
              [(await a(page))?.enabled, (await b(page))?.enabled],
              [true, true],
            ),
            await preserve(page),
          ],
        },
      ],
    },
    {
      id: "sites-remove",
      requires: ["sites-enable-selected"],
      prepare: async (page) => {
        removed = await a(page);
        if (!removed) throw Error("The source to remove must exist");
      },
      request: `Remove only source ${changedUrl}. Preserve all saved jobs and other sources.`,
      actions: [
        {
          actionId: "sites.remove",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Removed source absent",
              "jobs.list_sites",
              (await a(page)) ?? null,
              null,
            ),
            equalOutcome(
              "data",
              "Second source retained",
              "jobs.list_sites",
              Boolean(await b(page)),
              true,
            ),
            await preserve(page),
          ],
        },
      ],
    },
    {
      id: "sites-undo",
      requires: ["sites-remove"],
      request:
        "Undo only the source removal from the previous message. Restore that source exactly.",
      actions: [
        {
          actionId: "sites.undo",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Removed source restored exactly",
              "jobs.list_sites",
              await a(page),
              removed,
            ),
            await preserve(page),
          ],
        },
      ],
    },
    {
      id: "sites-remove-selected",
      requires: ["sites-undo"],
      request: `Remove these two sources: ${changedUrl} and ${urlB}. Preserve all other sources and every saved job.`,
      actions: [
        {
          actionId: "sites.remove_selected",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Both selected sources absent",
              "jobs.list_sites",
              [(await a(page)) ?? null, (await b(page)) ?? null],
              [null, null],
            ),
            await preserve(page),
          ],
        },
      ],
    },
  ];
}

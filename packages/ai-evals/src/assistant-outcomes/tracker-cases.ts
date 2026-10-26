import type {
  TrackerCommandInput,
  TrackerCommandName,
  TrackerCommandOutput,
  TrackerEvent,
  TrackerRow,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

interface TrackerBridge {
  run<K extends TrackerCommandName>(
    name: K,
    input: TrackerCommandInput<K>,
  ): Promise<TrackerCommandOutput<K>>;
}
type AppWindow = { nestor: { tracker: TrackerBridge } };
const rows = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (window as unknown as AppWindow).nestor.tracker.run(
          "list_applications",
          { limit: 200 },
        )
      ).rows,
  );
const application = async (page: Page) => {
  const row = (await rows(page)).find(
    (item) => item.title === "Application demo 1",
  );
  if (!row) throw Error("Synthetic tracked application is missing");
  return page.evaluate(
    (jobId) =>
      (window as unknown as AppWindow).nestor.tracker.run("get_application", {
        jobId,
      }),
    row.id,
  );
};
const events = async (page: Page) => (await application(page))?.events ?? [];
const eventValue = (event: TrackerEvent | undefined) =>
  event
    ? {
        kind: event.kind,
        title: event.title,
        body: event.body,
        dueAt: event.dueAt ? new Date(event.dueAt).toISOString() : null,
        place: event.place,
      }
    : null;

export function trackerOutcomeCases(): BuiltAppBatch[] {
  let beforeBulk: { id: number; status: TrackerRow["status"] }[] = [];
  const eventFixtures = [
    {
      kind: "reply",
      title: "Outcome reply",
      body: "Synthetic employer reply.",
      dueAt: null,
      place: null,
    },
    {
      kind: "note",
      title: "Outcome note",
      body: "Synthetic tracking note.",
      dueAt: null,
      place: null,
    },
    {
      kind: "interview",
      title: "Outcome interview",
      body: "Synthetic panel interview.",
      dueAt: "2027-02-03T10:00:00.000Z",
      place: "https://example.test/meeting",
    },
    {
      kind: "reminder",
      title: "Outcome reminder",
      body: "Synthetic follow-up reminder.",
      dueAt: "2027-02-04T14:00:00.000Z",
      place: "Synthetic office",
    },
  ] as const;
  return [
    {
      id: "tracker-status",
      prepare: async (page) => {
        const current = (await rows(page)).filter((row) =>
          row.title.startsWith("Application demo"),
        );
        if (
          current.length !== 2 ||
          current.some((row) => row.status !== "applied")
        )
          throw Error(
            "Tracker outcomes require two initially Applied synthetic rows",
          );
      },
      request:
        "Mark Application demo 1 at Replica 1 as Heard back. Leave Application demo 2 unchanged.",
      actions: [
        {
          actionId: "tracker.status",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Requested status",
              "tracker.list_applications",
              (await rows(page)).find(
                (row) => row.title === "Application demo 1",
              )?.status,
              "replied",
            ),
            equalOutcome(
              "unchanged",
              "Other application status",
              "tracker.list_applications",
              (await rows(page)).find(
                (row) => row.title === "Application demo 2",
              )?.status,
              "applied",
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-bulk-status",
      requires: ["tracker-status"],
      prepare: async (page) => {
        beforeBulk = (await rows(page))
          .map(({ id, status }) => ({ id, status }))
          .sort((a, b) => a.id - b.id);
      },
      request:
        "Set both Application demo 1 and Application demo 2 to Assessment.",
      actions: [
        {
          actionId: "tracker.bulk_status",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Both selected statuses",
              "tracker.list_applications",
              (await rows(page))
                .filter((row) => row.title.startsWith("Application demo"))
                .map((row) => row.status),
              ["assessment", "assessment"],
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-undo-status",
      requires: ["tracker-bulk-status"],
      request:
        "Undo only the previous bulk Assessment status change. Restore each application to its own previous status.",
      actions: [
        {
          actionId: "tracker.undo",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Individual prior statuses restored",
              "tracker.list_applications",
              (await rows(page))
                .map(({ id, status }) => ({ id, status }))
                .sort((a, b) => a.id - b.id),
              beforeBulk,
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-events",
      request: `On Application demo 1 at Replica 1, add these four separate synthetic history items. Use the supplied timestamps exactly; do not contact anyone: ${JSON.stringify(eventFixtures)}`,
      actions: eventFixtures.map((expected) => ({
        actionId: `tracker.${expected.kind}`,
        observe: async (page) => [
          equalOutcome(
            "data",
            `Saved ${expected.kind} fields`,
            "tracker.get_application.events",
            eventValue(
              (await events(page)).find(
                (event) => event.title === expected.title,
              ),
            ),
            expected,
          ),
        ],
      })),
    },
    {
      id: "tracker-edit-event",
      requires: ["tracker-events"],
      request:
        "Change Outcome reminder on Application demo 1 to title Outcome reminder revised, body Synthetic revised follow-up, due 2027-02-05T15:00:00Z, place Synthetic remote call. Keep the other history items.",
      actions: [
        {
          actionId: "tracker.edit_event",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Edited reminder fields",
              "tracker.get_application.events",
              eventValue(
                (await events(page)).find(
                  (event) => event.title === "Outcome reminder revised",
                ),
              ),
              {
                kind: "reminder",
                title: "Outcome reminder revised",
                body: "Synthetic revised follow-up",
                dueAt: "2027-02-05T15:00:00.000Z",
                place: "Synthetic remote call",
              },
            ),
            equalOutcome(
              "unchanged",
              "Other events retained",
              "tracker.get_application.events",
              (await events(page)).filter((event) =>
                ["Outcome reply", "Outcome note", "Outcome interview"].includes(
                  event.title,
                ),
              ).length,
              3,
            ),
          ],
        },
      ],
    },
    ...([true, false] as const).map(
      (done): BuiltAppBatch => ({
        id: `tracker-event-${done ? "done" : "open"}`,
        requires: [done ? "tracker-edit-event" : "tracker-event-done"],
        request: `${done ? "Mark" : "Reopen"} Outcome reminder revised on Application demo 1${done ? " as done" : " so it is pending again"}.`,
        actions: [
          {
            actionId: `tracker.event_${done ? "done" : "open"}`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Reminder completion state",
                "tracker.get_application.events.doneAt",
                Boolean(
                  (await events(page)).find(
                    (event) => event.title === "Outcome reminder revised",
                  )?.doneAt,
                ),
                done,
              ),
              equalOutcome(
                "data",
                "Reminder still exists",
                "tracker.get_application.events",
                (await events(page)).filter(
                  (event) => event.title === "Outcome reminder revised",
                ).length,
                1,
              ),
            ],
          },
        ],
      }),
    ),
    {
      id: "tracker-delete-event",
      requires: ["tracker-event-open"],
      request:
        "Delete only Outcome reminder revised from Application demo 1. Preserve the reply, note and interview.",
      actions: [
        {
          actionId: "tracker.delete_event",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Deleted reminder absent",
              "tracker.get_application.events",
              (await events(page)).filter(
                (event) => event.title === "Outcome reminder revised",
              ).length,
              0,
            ),
            equalOutcome(
              "unchanged",
              "Other events retained",
              "tracker.get_application.events",
              (await events(page)).filter((event) =>
                ["Outcome reply", "Outcome note", "Outcome interview"].includes(
                  event.title,
                ),
              ).length,
              3,
            ),
          ],
        },
      ],
    },
    ...([true, false] as const).map(
      (add): BuiltAppBatch => ({
        id: `tracker-tag-${add ? "add" : "remove"}`,
        ...(add ? {} : { requires: ["tracker-tag-add"] }),
        request: `${add ? "Add" : "Remove"} the tag outcome-eval ${add ? "to" : "from"} Application demo 1 only.`,
        actions: [
          {
            actionId: `tracker.${add ? "add" : "remove"}_tag`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Requested tag membership",
                "tracker.list_applications.tags",
                (await rows(page))
                  .find((row) => row.title === "Application demo 1")
                  ?.tags.includes("outcome-eval"),
                add,
              ),
              equalOutcome(
                "unchanged",
                "Other application not tagged",
                "tracker.list_applications.tags",
                (await rows(page))
                  .find((row) => row.title === "Application demo 2")
                  ?.tags.includes("outcome-eval"),
                false,
              ),
            ],
          },
        ],
      }),
    ),
  ];
}

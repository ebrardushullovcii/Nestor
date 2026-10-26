import type {
  ActivityFeed,
  AssistantConversationView,
  HomeSummary,
  HomeSummaryInput,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

interface AppWindow {
  nestor: {
    home: { summary(input: HomeSummaryInput): Promise<HomeSummary> };
    activity: { feed(): Promise<ActivityFeed> };
  };
}

/** Judge the answer the person can read, not an internal tool invocation. */
export async function answerObject(
  page: Page,
  reply: AssistantConversationView,
): Promise<Record<string, unknown>> {
  const message = [...reply.messages]
    .reverse()
    .find(
      (item) =>
        item.role === "assistant" &&
        item.parts.some((part) => part.type === "text" && part.text.trim()),
    );
  if (!message) throw Error("The Assistant did not give a readable answer");
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  const json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(text)?.[1] ?? text;
  const rendered = await page
    .locator(`[data-assistant-message="${message.id}"]`)
    .innerText();
  if (!rendered.includes(json))
    throw Error("The stored answer is not rendered in the chat");
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("The answer must be a JSON object");
  return value as Record<string, unknown>;
}
const home = (page: Page, utcOffsetMinutes: number) =>
  page.evaluate(
    (offset) =>
      (window as unknown as AppWindow).nestor.home.summary({
        utcOffsetMinutes: offset,
      }),
    utcOffsetMinutes,
  );

export function readOutcomeCases(): BuiltAppBatch[] {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  let beforeHome: HomeSummary;
  let beforeActivity: ActivityFeed;
  const totals = (summary: HomeSummary) =>
    Object.fromEntries(
      Object.entries(summary).filter(
        ([key]) => !["days", "recent", "upcoming"].includes(key),
      ),
    );
  return [
    {
      id: "home-read",
      prepare: async (page) => {
        await page
          .getByRole("button", { name: "Home", exact: true })
          .first()
          .click();
        beforeHome = await home(page, utcOffsetMinutes);
      },
      request: `Read the actual Home dashboard for utcOffsetMinutes=${utcOffsetMinutes}. Return only one JSON object with these exact keys: totals (jobs, tracker, resumes, readyToApply, applyWorking, needsYou, interviewsThisWeek, followUpsDue, foundToday), days (the entire dated sent/replies chart, oldest first), weekly (week and lastWeek sent totals), response (sentRecently, heardBack, responseRate as a number or null). Use saved data, not estimates, and do not change anything.`,
      actions: [
        {
          actionId: "home.summary",
          observe: async (page, reply) => [
            equalOutcome(
              "data",
              "Actual Home totals in the visible answer",
              "Rendered Assistant answer versus home.summary",
              (await answerObject(page, reply)).totals,
              totals(beforeHome),
            ),
            equalOutcome(
              "unchanged",
              "Reading Home preserves its data",
              "home.summary before and after chat",
              await home(page, utcOffsetMinutes),
              beforeHome,
            ),
          ],
        },
        {
          actionId: "home.chart",
          observe: async (page, reply) => [
            equalOutcome(
              "data",
              "Full dated chart returned",
              "Rendered Assistant answer versus home.summary.days",
              (await answerObject(page, reply)).days,
              beforeHome.days,
            ),
          ],
        },
        {
          actionId: "home.weekly_changes",
          observe: async (page, reply) => [
            equalOutcome(
              "data",
              "This week and previous week",
              "Rendered Assistant answer versus dated Home rows",
              (await answerObject(page, reply)).weekly,
              {
                week: beforeHome.days
                  .slice(-7)
                  .reduce((sum, day) => sum + day.sent, 0),
                lastWeek: beforeHome.days
                  .slice(-14, -7)
                  .reduce((sum, day) => sum + day.sent, 0),
              },
            ),
          ],
        },
        {
          actionId: "home.response_rate",
          observe: async (page, reply) => {
            const sentRecently = Object.entries(beforeHome.recent)
              .filter(([status]) => status !== "applying")
              .reduce((sum, [, count]) => sum + count, 0);
            const heardBack =
              sentRecently -
              beforeHome.recent.applied -
              beforeHome.recent.no_reply -
              beforeHome.recent.withdrawn;
            return [
              equalOutcome(
                "data",
                "Response numerator, denominator and rate",
                "Rendered Assistant answer versus Home recent statuses",
                (await answerObject(page, reply)).response,
                {
                  sentRecently,
                  heardBack,
                  responseRate: sentRecently
                    ? Math.round((100 * heardBack) / sentRecently)
                    : null,
                },
              ),
            ];
          },
        },
      ],
    },
    {
      id: "activity-read",
      prepare: async (page) => {
        beforeActivity = await page.evaluate(() =>
          (window as unknown as AppWindow).nestor.activity.feed(),
        );
        if (
          !beforeActivity.resumes.length &&
          !beforeActivity.moves.length &&
          !beforeActivity.searches.length &&
          !beforeActivity.applications.length
        )
          throw Error(
            "Activity proof requires recent nonempty synthetic entries",
          );
      },
      request:
        "Read the complete current Activity feed, including recent finished entries. Return only a JSON object with searches, resumes, applications, moves and running. Preserve the IDs, timestamps, states and errors exactly; do not change anything.",
      actions: [
        {
          actionId: "activity.read",
          observe: async (page, reply) => [
            equalOutcome(
              "data",
              "Full Activity feed in the visible answer",
              "Rendered Assistant answer versus activity.feed",
              await answerObject(page, reply),
              beforeActivity,
            ),
            equalOutcome(
              "unchanged",
              "Reading preserves Activity",
              "activity.feed before and after chat",
              await page.evaluate(() =>
                (window as unknown as AppWindow).nestor.activity.feed(),
              ),
              beforeActivity,
            ),
          ],
        },
      ],
    },
  ];
}

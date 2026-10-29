import {
  ProfileRecordSchema,
  ProfileRecordSchemas,
  type DesktopJobsBridge,
  type ProfileRecord,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

type AppWindow = { nestor: { jobs: DesktopJobsBridge } };
const definitions = [
  ["experiences", "Work history", "experience", "experience", "companyName"],
  ["education", "Education", "background", "education", "schoolName"],
  ["certifications", "Certifications", "background", "certification", "name"],
  ["links", "Links", "background", "link", "label"],
  ["projects", "Projects", "background", "project", "name"],
  ["spokenLanguages", "Languages", "background", "language", "language"],
  ["proofBank", "Proof", "background", "proof", "title"],
] as const;

/** More records than one page holds, so focus reaches an unloaded record. */
export function profileViewOutcomeCases(): BuiltAppBatch[] {
  return definitions.flatMap(
    ([collection, label, section, elementPrefix, labelField]) => {
      const query = `Outcome paging ${collection}`;
      const fixtures = Array.from({ length: 51 }, (_, index) => {
        const n = String(index + 1).padStart(3, "0");
        const record = ProfileRecordSchemas[collection].parse({
          id: `paging-${collection}-${n}`,
          [labelField]: `${query} ${n}`,
          claim: "Synthetic paging proof",
          isDraft: true,
        });
        return ProfileRecordSchema.parse({ collection, record });
      });
      let seeded = false;
      const filter = (page: Page) =>
        page.getByRole("textbox", {
          name: `Filter ${label.toLowerCase()}`,
          exact: true,
        });
      const cardId = (record: ProfileRecord) =>
        `${elementPrefix}-record-${record.record.id}`;
      const firstCard = (page: Page) =>
        page.locator(`#${cardId(fixtures[0]!)}`);
      const currentIds = (page: Page) =>
        page
          .locator(`details[id^="${elementPrefix}-record-"]`)
          .evaluateAll((elements) =>
            elements
              .filter((element) => element.getBoundingClientRect().height > 0)
              .map((element) => element.id),
          );
      const stored = (page: Page) =>
        page.evaluate(
          async ({ collection, text }) =>
            (
              await (window as unknown as AppWindow).nestor.jobs.run(
                "list_profile_records",
                { collection, text, limit: 100 },
              )
            ).rows,
          { collection, text: query },
        );
      const preserve = async (page: Page) =>
        equalOutcome(
          "unchanged",
          "Navigation preserves all record values",
          "jobs.list_profile_records for the paging fixtures",
          await stored(page),
          fixtures,
        );
      async function seed(page: Page) {
        if (seeded) return;
        if ((await stored(page)).length)
          throw Error("Paging fixtures must initially be absent");
        await page.evaluate(
          (upsert) =>
            (window as unknown as AppWindow).nestor.jobs.run(
              "commit_profile_edits",
              { upsert },
            ),
          fixtures,
        );
        seeded = true;
      }
      async function open(page: Page, text: string) {
        await seed(page);
        await page
          .getByRole("button", { name: "Profile", exact: true })
          .first()
          .click();
        await page.locator(`#${section}-tab`).click();
        // A changed query resets the real pager, even when the preceding
        // case left this same filter on a later page.
        await filter(page).fill(
          text ? "" : "No synthetic records match this reset",
        );
        await filter(page).fill(text);
        await firstCard(page).waitFor();
      }
      return [
        {
          id: `profile-filter-${collection}`,
          prepare: (page) => open(page, ""),
          request: `Show Profile ${label} records filtered to the text "${query}". Do not edit any records.`,
          actions: [
            {
              actionId: `profile.record.${collection}.filter`,
              observe: async (page) => [
                equalOutcome(
                  "visible_state",
                  "Actual record filter",
                  `Filter ${label.toLowerCase()} input`,
                  await filter(page).inputValue(),
                  query,
                ),
                equalOutcome(
                  "visible_state",
                  "Only matching first-page cards",
                  `${label} rendered card IDs`,
                  await currentIds(page),
                  fixtures.slice(0, 25).map(cardId),
                ),
                await preserve(page),
              ],
            },
          ],
        },
        {
          id: `profile-focus-${collection}`,
          prepare: async (page) => {
            await open(page, query);
            if (await page.locator(`#${cardId(fixtures[39]!)}`).count())
              throw Error("Focus fixture must start outside the loaded page");
          },
          request: `Show and focus Profile ${label} record ${fixtures[39]!.record.id}, labelled "${query} 040". Open its editor, without changing its values.`,
          actions: [
            {
              actionId: `profile.record.${collection}.focus`,
              observe: async (page) => [
                equalOutcome(
                  "visible_state",
                  "Target editor is expanded",
                  "Actual target details.open",
                  await page
                    .locator(`#${cardId(fixtures[39]!)}`)
                    .evaluate(
                      (element) =>
                        element instanceof HTMLDetailsElement && element.open,
                    ),
                  true,
                ),
                equalOutcome(
                  "visible_state",
                  "Target editor receives keyboard focus",
                  "Target record contains document.activeElement",
                  await page
                    .locator(`#${cardId(fixtures[39]!)}`)
                    .evaluate((element) =>
                      element.contains(document.activeElement),
                    ),
                  true,
                ),
                equalOutcome(
                  "visible_state",
                  "Target's actual editor value",
                  "Target record's first visible text field",
                  await page
                    .locator(`#${cardId(fixtures[39]!)}`)
                    .locator("input:visible")
                    .first()
                    .inputValue(),
                  `${query} 040`,
                ),
                await preserve(page),
              ],
            },
          ],
        },
      ];
    },
  );
}

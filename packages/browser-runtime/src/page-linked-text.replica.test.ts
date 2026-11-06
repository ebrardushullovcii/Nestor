import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createApplyPageHands } from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import { readPageLinkedText } from "./page-linked-text";

test("button-only result cards expose each identifier and a working click handle without inventing URLs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main><ul>
      <li data-entity-urn="urn:example:posting:101"><button data-job-id="101" onclick="document.querySelector('#detail').textContent='Posting 101';">Interface Engineer at First Employer</button></li>
      <li data-entity-urn="urn:example:posting:202"><button data-job-id="202" data-target-url="https://board.example.test/jobs/202" onclick="document.querySelector('#detail').textContent='Posting 202';">Interface Engineer at Second Employer</button></li>
    </ul><section id="detail"></section></main>`);
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    await hands.observe();
    const text = await readPageLinkedText(page);
    expect(text).toContain('"data-job-id":"101"');
    expect(text).toContain('"data-job-id":"202"');
    expect(text).toContain('"data-entity-urn":"urn:example:posting:101"');
    expect(text).toContain(
      '"data-target-url":"https://board.example.test/jobs/202"',
    );
    const targets = [...text.matchAll(/\[Page target (.+)\]/gu)].map(
      (match) => JSON.parse(match[1]!) as Record<string, string>,
    );
    for (const id of ["101", "202"]) {
      const target = targets.find((row) => row["data-job-id"] === id)!;
      expect(target.clickRef).toBeTruthy();
      expect((await hands.clickElement(target.clickRef!)).ok).toBe(true);
      await expect(page.locator("#detail").textContent()).resolves.toBe(
        `Posting ${id}`,
      );
    }
    expect(await page.locator("a[href]").count()).toBe(0);
  } finally {
    await browser.close();
  }
});

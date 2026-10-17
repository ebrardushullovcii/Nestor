// The public landing page from this checkout: hero, early-access signup and the
// tour, at desktop and phone widths. The signup posts to the helper's own
// loopback server (never Netlify); the posted fields land in website-posts.jsonl.
// Run: .claude/skills/verify-nestor/bin/website run .claude/skills/verify-nestor/journeys/website.mjs
import assert from "node:assert/strict";

export default async function journey({ page, shot, url, posts, note }) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: "A calmer way to look for work." })
    .waitFor();
  await shot("home-desktop");
  await shot("home-desktop-full", { full: true });

  const hero = page.locator("form[data-signup]").first();
  await hero.getByLabel("Email address").fill("verify-signup@example.test");
  await shot("signup-filled");
  await hero.getByRole("button", { name: "Get early access" }).click();
  await assert.doesNotReject(() =>
    page.waitForFunction(() =>
      document
        .querySelector("form[data-signup] [role=status]")
        ?.textContent?.trim(),
    ),
  );
  const status = (await hero.getByRole("status").textContent()).trim();
  await shot("signup-sent");
  assert.equal(posts.length, 1, "the signup posted once, to the local server");
  assert.equal(posts[0].body.email, "verify-signup@example.test");
  assert.equal(posts[0].body["form-name"], "early-access");
  note("signup status", status);

  await page.locator("[data-tour]").first().click();
  await page.waitForTimeout(800);
  await shot("tour-open");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  await shot("home-phone");
  assert.ok(
    overflow <= 1,
    `no sideways scroll on a phone (overflow ${overflow}px)`,
  );
  return {
    signupStatus: status,
    posted: posts[0].body,
    phoneOverflowPx: overflow,
  };
}

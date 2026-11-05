import assert from "node:assert/strict";
import path from "node:path";
import type { App } from "./app.ts";

export const SOURCES = [
  "board/",
  "greenhouse/",
  "lever/",
  "workday/",
  "gatekeeper/",
  "atlas/",
  "ripple/",
];

export async function setup(app: App) {
  const { ctx } = app;
  const p = await ctx.page;
  await ctx.waitFor("Guided setup", 30, { role: "heading" });
  const chooser = p.getByRole("button", { name: /Choose my resume file/ });
  if (await chooser.count()) {
    app.log("import synthetic Jamie resume");
    ctx.pick(
      path.join(
        ctx.desktopDir,
        "test-fixtures/job-finder/resume-import-sample.txt",
      ),
    );
    await chooser.click();
  }
  await ctx.waitFor("/Basics.*Ready to review/", 360, { role: "button" });
  await ctx.click("/Basics.*Ready to review/", { role: "button" });
  await ctx.click("Save and continue to Work history");
  await ctx.click("Save and continue to Job targets");
  app.log("set seven replica sources and target");
  await ctx.fill(
    "Job site URLs",
    SOURCES.map((s) => new URL(s, ctx.sites.url).href).join("\n"),
  );
  await ctx.click("Add and turn on");
  await ctx.waitFor("/^Added and turned on 7/", 20);
  await ctx.fill("Target roles", "Frontend Engineer");
  await ctx.press("Enter");
  await ctx.fill("Preferred job locations", "Remote");
  await ctx.press("Enter");
  for (const country of ["European Union", "Germany"]) {
    await ctx.fill("Countries where you can work", country);
    await ctx.press("Enter");
  }
  await ctx.click("No", {
    within: "Would you need employer visa sponsorship?",
  });
  await p.getByRole("checkbox", { name: "Remote", exact: true }).check();
  await p.getByRole("checkbox", { name: "Hybrid", exact: true }).check();
  await ctx.click("Finish setup and find jobs");
  // Guided setup starts search automatically. Stop it before establishing the
  // measured search's starting set. Its rows are retained and recorded.
  const stop = p.getByRole("button", { name: "Stop search", exact: true });
  await app.until(
    async () => {
      const search = app.read<{ state: string }>(
        "SELECT state FROM searches ORDER BY started_at DESC LIMIT 1",
      )[0];
      if (search && search.state !== "running") return true;
      if (!(await stop.isVisible())) return false;
      await stop.click();
      return true;
    },
    15,
    "stop setup search, or accept that it already finished",
  );
  await app.until(
    () =>
      !app
        .read<{
          state: string;
        }>("SELECT state FROM searches ORDER BY started_at DESC LIMIT 1")
        .some((s) => s.state === "running"),
    30,
    "setup search stops",
  );
  await app.go("Profile");
  await p.getByRole("tab", { name: /^Preferences/ }).click();
  app.log(
    "set EU authorization, notice period and remote eligibility through Profile",
  );
  await p.getByLabel("Notice period (days)", { exact: true }).fill("30");
  const remote = p.getByRole("combobox", {
    name: "Can you legally work remotely?",
    exact: true,
  });
  await remote.click();
  await p.getByRole("option", { name: "Yes", exact: true }).click();
  await p.getByRole("heading", { name: "Availability", exact: true }).click();
  await p.getByRole("radio", { name: /^Original / }).check();
  await app.until(
    async () =>
      /Profile saved|Changes save automatically/.test(
        await p.locator("[data-profile-save-status]").innerText(),
      ),
    20,
    "profile save finishes",
  );
  await app.go("Settings");
  const pay = p.getByRole("switch", {
    name: "Let Job Finder answer expected and current pay questions",
    exact: true,
  });
  app.log("set pay to Pause for me");
  await pay.uncheck();
  assert.equal(await pay.isChecked(), false);
  // Original is used for every fixture; resume generation is outside v1's scope.
  await app.mode("Fill in for me");
  const enabled = app.read<{ url: string }>(
    "SELECT url FROM job_sites WHERE enabled=1",
  );
  assert.equal(enabled.length, 7);
  const saved = app.read<{
    notice: number;
    sponsorship: number;
    remote: number;
  }>(
    "SELECT work_eligibility_notice_period_days AS notice,work_eligibility_requires_visa_sponsorship AS sponsorship,work_eligibility_remote_eligible AS remote FROM profile WHERE id=1",
  )[0];
  assert.equal(saved.notice, 30);
  assert.equal(saved.sponsorship, 0);
  assert.equal(saved.remote, 1);
  const savedPay = app.read<{ pay: string }>(
    "SELECT salary_disclosure AS pay FROM profile_settings WHERE id=1",
  )[0];
  assert.equal(savedPay.pay, "pause_for_user");
  app.log("persona ready", {
    sources: enabled.map((s) => s.url),
    noticePeriodDays: 30,
    salaryDisclosure: "pause_for_user",
  });
}

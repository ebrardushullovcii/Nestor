import assert from "node:assert/strict";

// A small check of the launcher, not an app acceptance suite.
export default async function smoke(qa) {
  await qa.page
    .getByRole("heading", { name: "Guided setup", exact: true })
    .waitFor();
  await qa.capture("01-loaded-setup");
  await qa.page.getByRole("button", { name: "Home", exact: true }).click();
  await qa.page
    .getByRole("button", { name: /^(Start|Continue) setup$/ })
    .waitFor();
  await qa.capture("02-home");
  assert.equal((await fetch(qa.sites.url)).status, 200);
  // Deliberate backend setup; UI-flow tests should press the actual Save button.
  await qa.page.evaluate(async () => {
    const state = await window.nestor.jobFinder.getWorkspace();
    await window.nestor.jobFinder.saveProfile({
      ...state.profile,
      fullName: "Harness Synthetic Tester",
    });
  });
  await qa.restart();
  const state = await qa.page.evaluate(() =>
    window.nestor.jobFinder.getWorkspace(),
  );
  assert.equal(state.profile.fullName, "Harness Synthetic Tester");
  await qa.page.getByRole("button", { name: "Home", exact: true }).click();
  await qa.page
    .getByRole("button", { name: /^(Start|Continue) setup$/ })
    .waitFor();
  await qa.capture("03-after-restart");
  console.log(
    `Launcher smoke passed: UI navigation, backend read/write, persistence across restart. Artifacts: ${qa.runDir}`,
  );
}

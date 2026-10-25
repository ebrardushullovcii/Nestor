import { describe, expect, it } from "vitest";
import {
  hasAnyPendingAction,
  hasPendingAction,
  jobFinderPendingActions,
  listPendingActionScopes,
} from "./job-finder-pending-actions";

describe("jobFinderPendingActions helpers", () => {
  it("reports whether a scope is currently pending", () => {
    const state = {
      [jobFinderPendingActions.discoveryAll()]: 1,
      [jobFinderPendingActions.resumeJob("job_1")]: 2,
    };

    expect(
      hasPendingAction(state, jobFinderPendingActions.discoveryAll()),
    ).toBe(true);
    expect(
      hasPendingAction(state, jobFinderPendingActions.resumeJob("job_1")),
    ).toBe(true);
    expect(
      hasPendingAction(state, jobFinderPendingActions.resumeJob("job_2")),
    ).toBe(false);
  });

  it("reports whether any scope in a group is pending", () => {
    const state = {
      [jobFinderPendingActions.applyRun("run_1")]: 1,
    };

    expect(
      hasAnyPendingAction(state, [
        jobFinderPendingActions.apply(),
        jobFinderPendingActions.applyRun("run_1"),
      ]),
    ).toBe(true);

    expect(
      hasAnyPendingAction(state, [
        jobFinderPendingActions.profileMutation(),
        jobFinderPendingActions.settingsSave(),
      ]),
    ).toBe(false);
  });

  it("lists active pending scopes", () => {
    const state = {
      [jobFinderPendingActions.browserSession()]: 1,
      [jobFinderPendingActions.sourceDebug("target_1")]: 1,
      [jobFinderPendingActions.discoveryAll()]: 0,
    };

    expect(listPendingActionScopes(state)).toEqual([
      jobFinderPendingActions.browserSession(),
      jobFinderPendingActions.sourceDebug("target_1"),
    ]);
  });
});

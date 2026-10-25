import { describe, expect, it } from 'vitest'
import {
  hasAnyPendingAction,
  hasPendingAction,
  jobFinderPendingActions,
  listPendingActionScopes,
} from './job-finder-pending-actions'

describe('jobFinderPendingActions helpers', () => {
  it('reports whether a scope is currently pending', () => {
    const state = {
      [jobFinderPendingActions.discoveryAll()]: 1,
      [jobFinderPendingActions.resumeJob('job_1')]: 2,
    }

    expect(hasPendingAction(state, jobFinderPendingActions.discoveryAll())).toBe(true)
    expect(hasPendingAction(state, jobFinderPendingActions.resumeJob('job_1'))).toBe(true)
    expect(hasPendingAction(state, jobFinderPendingActions.resumeJob('job_2'))).toBe(false)
  })

  it('reports whether any scope in a group is pending', () => {
    const state = {
      [jobFinderPendingActions.applyRun('run_1')]: 1,
    }

    expect(
      hasAnyPendingAction(state, [
        jobFinderPendingActions.apply(),
        jobFinderPendingActions.applyRun('run_1'),
      ]),
    ).toBe(true)

    expect(
      hasAnyPendingAction(state, [
        jobFinderPendingActions.profileMutation(),
        jobFinderPendingActions.settingsSave(),
      ]),
    ).toBe(false)
  })

  it("lists active pending scopes", () => {
    const state = {
      [jobFinderPendingActions.browserSession()]: 1,
      [jobFinderPendingActions.sourceDebug('target_1')]: 1,
      [jobFinderPendingActions.discoveryAll()]: 0,
    }

    expect(listPendingActionScopes(state)).toEqual([
      jobFinderPendingActions.browserSession(),
      jobFinderPendingActions.sourceDebug('target_1'),
    ])
  })

  it('tracks campaign run and notification scopes', () => {
    expect(jobFinderPendingActions.campaignRun('campaign_1')).toBe(
      'campaign-run:campaign_1',
    )
    expect(jobFinderPendingActions.campaignNotification('n_1')).toBe(
      'campaign-notification:n_1',
    )
    expect(jobFinderPendingActions.campaignNotificationAll()).toBe(
      'campaign-notification:all',
    )

    const state = {
      [jobFinderPendingActions.campaignRun('campaign_1')]: 1,
      [jobFinderPendingActions.campaignNotification('n_1')]: 1,
    }

    expect(hasPendingAction(state, jobFinderPendingActions.campaignRun('campaign_1'))).toBe(true)
    expect(hasPendingAction(state, jobFinderPendingActions.campaignRun('campaign_2'))).toBe(false)
    expect(
      hasAnyPendingAction(state, [
        jobFinderPendingActions.campaignNotificationAll(),
        jobFinderPendingActions.campaignNotification('n_1'),
      ]),
    ).toBe(true)
  })

  it('tracks outcome recording and suggestion control scopes', () => {
    expect(jobFinderPendingActions.recordOutcome('job_1')).toBe(
      'outcome:record:job_1',
    )
    expect(jobFinderPendingActions.outcomeSuggestion('source', 'example')).toBe(
      'outcome:suggestion:source:example',
    )

    const state = {
      [jobFinderPendingActions.recordOutcome('job_1')]: 1,
      [jobFinderPendingActions.outcomeSuggestion('campaign', 'campaign_1')]: 1,
    }

    expect(hasPendingAction(state, jobFinderPendingActions.recordOutcome('job_1'))).toBe(true)
    expect(hasPendingAction(state, jobFinderPendingActions.recordOutcome('job_2'))).toBe(false)
    expect(
      hasPendingAction(
        state,
        jobFinderPendingActions.outcomeSuggestion('source', 'example'),
      ),
    ).toBe(false)
    expect(
      hasPendingAction(
        state,
        jobFinderPendingActions.outcomeSuggestion('campaign', 'campaign_1'),
      ),
    ).toBe(true)
  })
})

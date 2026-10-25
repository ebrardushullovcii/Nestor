export const jobFinderPendingActions = {
  apply: (): "apply" => "apply",
  applyRequest: (requestId: string): `apply:request:${string}` =>
    `apply:request:${requestId}`,
  applyRun: (runId: string): `apply:run:${string}` => `apply:run:${runId}`,
  browserSession: (): "browser:session" => "browser:session",
  campaignRule: (
    campaignId: string,
    ruleId?: string | null,
  ): `campaign-rule:${string}` =>
    `campaign-rule:${campaignId}${ruleId ? `:${ruleId}` : ""}`,
  campaignRun: (campaignId: string): `campaign-run:${string}` =>
    `campaign-run:${campaignId}`,
  campaignNotification: (
    notificationId: string,
  ): `campaign-notification:${string}` =>
    `campaign-notification:${notificationId}`,
  campaignNotificationAll: (): "campaign-notification:all" =>
    "campaign-notification:all",
  campaignRuleFunnel: (campaignId: string): `campaign-rule-funnel:${string}` =>
    `campaign-rule-funnel:${campaignId}`,
  groupedDecisionSnooze: (
    decisionId: string,
  ): `grouped-decision:snooze:${string}` =>
    `grouped-decision:snooze:${decisionId}`,
  groupedManualAnswerApply: (
    decisionId: string,
  ): `grouped-manual-answer:apply:${string}` =>
    `grouped-manual-answer:apply:${decisionId}`,
  groupedManualAnswerProject: (
    groupKey: string,
  ): `grouped-manual-answer:project:${string}` =>
    `grouped-manual-answer:project:${groupKey}`,
  userAction: (requestId: string): `user-action:${string}` =>
    `user-action:${requestId}`,
  browserSessionTarget: (targetId: string): `browser:session:${string}` =>
    `browser:session:${targetId}`,
  discoveryAll: (): "discovery:all" => "discovery:all",
  discoveryJob: (jobId: string): `discovery:job:${string}` =>
    `discovery:job:${jobId}`,
  discoveryTarget: (targetId: string): `discovery:target:${string}` =>
    `discovery:target:${targetId}`,
  profileAnalyze: (): "profile:analyze" => "profile:analyze",
  profileImport: (): "profile:import" => "profile:import",
  profileMutation: (): "profile:mutation" => "profile:mutation",
  profileReviewItem: (reviewItemId: string): `profile:review:${string}` =>
    `profile:review:${reviewItemId}`,
  profileSetup: (): "profile:setup" => "profile:setup",
  resumeJob: (jobId: string): `resume:${string}` => `resume:${jobId}`,
  resumeExport: (jobId: string): `resume:export:${string}` =>
    `resume:export:${jobId}`,
  settingsSave: (): "settings:save" => "settings:save",
  sourceDebug: (targetId: string): `source-debug:${string}` =>
    `source-debug:${targetId}`,
  sourceInstruction: (targetId: string): `source-instruction:${string}` =>
    `source-instruction:${targetId}`,
  sourceInstructionVerify: (
    instructionId: string,
  ): `source-instruction-verify:${string}` =>
    `source-instruction-verify:${instructionId}`,
  workspaceReset: (): "workspace:reset" => "workspace:reset",
} as const;

type PendingActionFactory =
  (typeof jobFinderPendingActions)[keyof typeof jobFinderPendingActions];

export type PendingActionScope = ReturnType<PendingActionFactory>;
export type PendingActionState = Partial<Record<PendingActionScope, number>>;

// Pending counts are deliberately kept as the public state shape, but a
// renderer route can outlive a native dialog. A generation lets that route
// retire the old operation without allowing its late `finally` callback to
// decrement a newer operation that reused the same scope.
const pendingActionGenerations = new Map<PendingActionScope, number>();

export function getPendingActionGeneration(scope: PendingActionScope): number {
  return pendingActionGenerations.get(scope) ?? 0;
}

export function invalidatePendingActionScope(scope: PendingActionScope): void {
  pendingActionGenerations.set(scope, getPendingActionGeneration(scope) + 1);
}

export function clearPendingActionScopes(
  current: PendingActionState,
  scopes: readonly PendingActionScope[],
): PendingActionState {
  let nextState: PendingActionState | null = null;

  for (const scope of scopes) {
    if (!(scope in current)) {
      continue;
    }

    nextState ??= { ...current };
    delete nextState[scope];
  }

  return nextState ?? current;
}

export function hasPendingAction(
  pendingActionState: PendingActionState,
  scope: PendingActionScope,
): boolean {
  return (pendingActionState[scope] ?? 0) > 0;
}

export function hasAnyPendingAction(
  pendingActionState: PendingActionState,
  scopes: readonly PendingActionScope[],
): boolean {
  return scopes.some((scope) => hasPendingAction(pendingActionState, scope));
}

export function listPendingActionScopes(
  pendingActionState: PendingActionState,
): readonly PendingActionScope[] {
  return Object.entries(pendingActionState)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([scope]) => scope as PendingActionScope);
}

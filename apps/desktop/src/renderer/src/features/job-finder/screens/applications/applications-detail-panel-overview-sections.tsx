import type {
  ApplicationAttemptListRow,
  ApplicationRecord,
  JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import { ApplicationsDetailFactStrip } from "./applications-detail-fact-strip";
import type { PlannedApplyStanding } from "./applications-recovery-state";

export function ApplicationsDetailPanelOverviewSections(props: {
  selectedAttempt: ApplicationAttemptListRow | null;
  selectedRecord: ApplicationRecord;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
  visibleApplyRunId: string | null;
  showFactStrip?: boolean;
  waitingOnSafetyLimitReview?: boolean;
  plannedStanding?: PlannedApplyStanding | null;
}) {
  const {
    selectedAttempt,
    selectedRecord,
    visibleApplyResult,
    visibleApplyRunId,
    showFactStrip = true,
  } = props;
  return (
    <>
      {/* The status block at the top of the panel is the next step: it
          carries the title, the one sentence, and the one button. A separate
          "NEXT STEP" callout said the same thing a second time, above a fact
          strip that said it a third. */}
      {showFactStrip ? (
        <ApplicationsDetailFactStrip
          selectedAttempt={selectedAttempt}
          selectedRecord={selectedRecord}
          visibleApplyResult={visibleApplyResult}
          visibleApplyRunId={visibleApplyRunId}
          plannedStanding={props.plannedStanding ?? null}
          {...(props.waitingOnSafetyLimitReview === undefined
            ? {}
            : {
                waitingOnSafetyLimitReview: props.waitingOnSafetyLimitReview,
              })}
        />
      ) : null}
    </>
  );
}

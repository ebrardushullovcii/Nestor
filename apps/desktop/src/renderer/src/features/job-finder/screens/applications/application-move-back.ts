import {
  isApplicationRecordSent,
  isApplicationWithdrawnByPerson,
  type ApplicationRecord,
} from "@nestor/contracts";
import type { ApplyJobStateKind } from "../../lib/apply-mode-contracts-stub";

/**
 * The way back from Applications. An unsent application moves back to
 * Shortlisted; a sent one stays and can be marked withdrawn or archived; one
 * being filled in right now, withdrawn or archived offers neither.
 */
export type ApplicationMoveBack = "to_shortlisted" | "sent" | "none";

export function resolveApplicationMoveBack(
  record: ApplicationRecord,
  applyStateKind: ApplyJobStateKind | null | undefined,
): ApplicationMoveBack {
  if (isApplicationRecordSent(record) || applyStateKind === "applied")
    return "sent";
  if (
    record.status === "withdrawn" ||
    isApplicationWithdrawnByPerson(record.crm) ||
    record.crm?.archivedAt ||
    record.lastAttemptState === "in_progress" ||
    applyStateKind === "filling_in"
  )
    return "none";
  return "to_shortlisted";
}

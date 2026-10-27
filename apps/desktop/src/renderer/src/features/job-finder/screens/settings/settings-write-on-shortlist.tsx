import {
  writesResumesOnShortlist,
  type JobFinderSettings,
  type UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { useEffect, useState } from "react";

import { ToggleField } from "../../components/toggle-field";

/**
 * When a job's resume gets written: a switch that saves when flipped, like
 * the other switches in Settings, and goes back if the save fails.
 */
export function SettingsWriteOnShortlist(props: {
  settings: JobFinderSettings;
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
}) {
  const saved = writesResumesOnShortlist(props.settings);
  const [checked, setChecked] = useState(saved);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setChecked(saved);
  }, [saved]);
  const update = (next: boolean) => {
    setChecked(next);
    setFailed(false);
    const revert = () => {
      setChecked(!next);
      setFailed(true);
    };
    try {
      void Promise.resolve(
        props.onUpdateWorkspaceBehavior({ writeResumesOnShortlist: next }),
      ).then((result) => {
        if (result === false) revert();
      }, revert);
    } catch {
      revert();
    }
  };
  return (
    <div data-testid="settings-resume-writing">
      <ToggleField
        checked={checked}
        description="A job's resume starts writing at your Profile resume level as soon as you shortlist it, so it is ready when you open it."
        hint={
          failed
            ? "This was not saved. Try the switch again."
            : checked
              ? "On: resumes start when you shortlist a job."
              : "Off: create resumes yourself from Shortlisted."
        }
        label="Write resumes when I shortlist"
        onCheckedChange={update}
      />
    </div>
  );
}

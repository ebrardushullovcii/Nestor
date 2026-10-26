/**
 * Set while a just-finished guided setup is handing the user off to Find
 * jobs. The setup route consults it so its completed-state redirect targets
 * Find jobs instead of Profile for that one transition.
 */
let profileSetupJustFinished = false;

export function markProfileSetupJustFinished(): void {
  profileSetupJustFinished = true;
}

export function clearProfileSetupJustFinished(): void {
  profileSetupJustFinished = false;
}

export function isProfileSetupJustFinished(): boolean {
  return profileSetupJustFinished;
}

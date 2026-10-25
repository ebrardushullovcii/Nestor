export function resolveAdvancedInterviewSurfacesEnabled(
  environmentValue: string | undefined,
) {
  return environmentValue !== "0";
}

export function areAdvancedInterviewSurfacesEnabled() {
  return resolveAdvancedInterviewSurfacesEnabled(
    process.env.NESTOR_INTERVIEW_ADVANCED_SURFACES,
  );
}

export function resolveVisibleInterviewPopupInputMode() {
  return {
    focusable: true,
    ignoreMouseEvents: false,
  } as const;
}

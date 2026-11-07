import type { ApplyPageSession } from "@nestor/contracts";
import type { ApplicationPreparationLease } from "./application-preparation-scheduler";

/** Check site ownership at every hand before another form operation starts. */
export function guardApplicationPreparationSession(
  session: ApplyPageSession,
  lease: ApplicationPreparationLease,
  waitForReady: () => Promise<void>,
  signal?: AbortSignal,
): ApplyPageSession {
  const guard = async <T>(
    work: () => Promise<T>,
    destination?: string,
  ): Promise<T> => {
    signal?.throwIfAborted();
    await waitForReady();
    if (destination) await lease.moveTo(destination);
    try {
      return await work();
    } finally {
      // A click, popup adoption, or site redirect may change the account
      // session. Wait for that site's turn before the workflow can act again.
      await waitForReady();
      signal?.throwIfAborted();
    }
  };

  return {
    ...session,
    readPage: () => guard(() => session.readPage()),
    fillText: (ref, value) => guard(() => session.fillText(ref, value)),
    chooseOption: (ref, value) => guard(() => session.chooseOption(ref, value)),
    setToggle: (ref, checked) => guard(() => session.setToggle(ref, checked)),
    uploadFile: (ref, file) => guard(() => session.uploadFile(ref, file)),
    clickAction: (ref) => guard(() => session.clickAction(ref)),
    followLink: (ref) => guard(() => session.followLink(ref)),
    navigate: (url) => guard(() => session.navigate(url), url),
    clickElement: (ref) => guard(() => session.clickElement(ref)),
    ...(session.clickWithoutWrites
      ? {
          clickWithoutWrites: (
            expected: Parameters<
              NonNullable<ApplyPageSession["clickWithoutWrites"]>
            >[0],
          ) => guard(() => session.clickWithoutWrites!(expected)),
        }
      : {}),
    ...(session.clickBoundAction
      ? {
          clickBoundAction: (
            expected: Parameters<
              NonNullable<ApplyPageSession["clickBoundAction"]>
            >[0],
          ) => guard(() => session.clickBoundAction!(expected)),
        }
      : {}),
    ...(session.renewAccountWindow
      ? {
          renewAccountWindow: (
            expected: Parameters<
              NonNullable<ApplyPageSession["renewAccountWindow"]>
            >[0],
          ) => guard(() => session.renewAccountWindow!(expected)),
        }
      : {}),
    pressKey: (ref, key) => guard(() => session.pressKey(ref, key)),
    ...(session.typeKeys
      ? {
          typeKeys: (ref: string, text: string) =>
            guard(() => session.typeKeys!(ref, text)),
        }
      : {}),
    scroll: (direction) => guard(() => session.scroll(direction)),
    wait: (milliseconds) => guard(() => session.wait(milliseconds)),
    goBack: () => guard(() => session.goBack()),
    readText: (ref) => guard(() => session.readText(ref)),
    ...(session.adoptOpenedTab
      ? {
          adoptOpenedTab: (index: number) =>
            guard(() => session.adoptOpenedTab!(index)),
        }
      : {}),
    ...(session.clickOpeningAccountWindow
      ? {
          clickOpeningAccountWindow: (
            grant: Parameters<
              NonNullable<ApplyPageSession["clickOpeningAccountWindow"]>
            >[0],
          ) => guard(() => session.clickOpeningAccountWindow!(grant)),
        }
      : {}),
    installPrepareOnlyGuard: (input) =>
      guard(() => session.installPrepareOnlyGuard(input)),
    readBlockedAttempt: () => guard(() => session.readBlockedAttempt()),
    registerPreparedValue: (value) =>
      guard(() => session.registerPreparedValue(value)),
    openIntermediateWriteWindow: () =>
      guard(() => session.openIntermediateWriteWindow()),
    // Cleanup must still close a short write window when a run was aborted.
    closeIntermediateWriteWindow: () => session.closeIntermediateWriteWindow(),
    closeUploadWindow: () => session.closeUploadWindow(),
    ...(session.clickAuthorizedLoginAction
      ? {
          clickAuthorizedLoginAction: (
            grant: Parameters<
              NonNullable<ApplyPageSession["clickAuthorizedLoginAction"]>
            >[0],
          ) => guard(() => session.clickAuthorizedLoginAction!(grant)),
        }
      : {}),
    clickAuthorizedFormAction: (ref) =>
      guard(() => session.clickAuthorizedFormAction(ref)),
    checkServiceWorker: () => guard(() => session.checkServiceWorker()),
  };
}

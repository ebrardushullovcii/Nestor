// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { LaunchContext } from "@nestor/contracts";
import { startLaunchReads, useLaunchReads } from "./launch-reads";

test("launch reads follow later settings and profile changes", async () => {
  let notify: (change: { cause: string }) => void = () => undefined;
  const contexts = ["system", "dark"].map(
    (appearanceTheme) =>
      ({
        workspace: "read",
        settings: { appearanceTheme },
        profileSetupState: null,
      }) as unknown as LaunchContext,
  );
  const launchContext = vi.fn(() => Promise.resolve(contexts.shift()!));
  Object.assign(window, {
    nestor: {
      launchContext,
      jobs: {
        onChange: (listener: typeof notify) => {
          notify = listener;
          return () => undefined;
        },
      },
    },
  });
  startLaunchReads();
  const { result } = renderHook(() => useLaunchReads());
  await waitFor(() =>
    expect(result.current.context?.settings?.appearanceTheme).toBe("system"),
  );
  notify({ cause: "application" });
  expect(launchContext).toHaveBeenCalledOnce();
  notify({ cause: "settings" });
  await waitFor(() =>
    expect(result.current.context?.settings?.appearanceTheme).toBe("dark"),
  );
});

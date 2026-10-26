import {
  createSharedRouteLoader,
  lazyScreen,
  preloadWhenIdle,
} from "@renderer/lib/lazy-screen";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { JobFinderRouteErrorBoundary } from "./job-finder-route-error-boundary";
import { Navigate } from "react-router-dom";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";
import {
  markGuidedSetupAutoOpenSpent,
  shouldAutoOpenGuidedSetup,
} from "@renderer/features/job-finder/components/profile/setup/guided-setup-auto-open";
import { HomeScreen } from "@renderer/features/home/home-screen";

// Profile, setup and Settings are their own chunks, fetched once the window
// is idle or on the first visit, whichever comes first.
const loadProfileSetupScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-profile-setup-screen")
  ).StoredProfileSetupScreen,
}));
const loadProfileScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-profile-screen")
  ).StoredProfileScreen,
}));
const loadSettingsScreen = createSharedRouteLoader(async () => ({
  default: (
    await import("@renderer/features/profile-store/stored-settings-screen")
  ).StoredSettingsScreen,
}));

preloadWhenIdle([
  loadProfileScreen,
  loadSettingsScreen,
  loadProfileSetupScreen,
]);

const StoredProfileScreen = lazyScreen(loadProfileScreen);
const ProfileSetupScreen = lazyScreen(loadProfileSetupScreen);
const SettingsScreen = lazyScreen(loadSettingsScreen);

export { JobFinderRouteErrorBoundary };

export function JobFinderHomeRoute() {
  // Home opens before Profile, so setup state comes from the launch read.
  // A workspace the launch read could not read leaves setup unknown, and
  // Home stays.
  const launched = useLaunchReads().context;
  // A workspace that has not started setup opens guided setup directly; Home
  // is one screen of hallway before it. The redirect is spent immediately so
  // the sidebar's Home destination still works.
  if (
    launched &&
    launched.workspace !== "unreadable" &&
    shouldAutoOpenGuidedSetup(launched.profileSetupState)
  ) {
    markGuidedSetupAutoOpenSpent();
    return <Navigate replace to="/job-finder/profile/setup" />;
  }
  return <HomeScreen />;
}

export function JobFinderProfileRoute() {
  return <StoredProfileScreen />;
}

export function JobFinderProfileSetupRoute() {
  return <ProfileSetupScreen />;
}

export function JobFinderSettingsRoute() {
  return <SettingsScreen />;
}

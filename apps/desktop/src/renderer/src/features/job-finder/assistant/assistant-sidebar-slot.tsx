import { lazy, Suspense, useEffect, useState } from "react";
import { afterFirstScreen } from "../lib/after-first-screen";
import { useAssistant } from "./assistant-provider";

const AssistantSidebar = lazy(async () => ({
  default: (await import("./assistant-sidebar")).AssistantSidebar,
}));

/**
 * The docked assistant is its own chunk: it loads once the first screen is
 * shown, or at once when the sidebar was left open.
 */
export function AssistantSidebarSlot() {
  const open = useAssistant()?.open ?? false;
  const [firstScreenShown, setFirstScreenShown] = useState(false);
  useEffect(() => afterFirstScreen(() => setFirstScreenShown(true)), []);
  if (!open && !firstScreenShown) return null;
  return (
    <Suspense fallback={null}>
      <AssistantSidebar />
    </Suspense>
  );
}

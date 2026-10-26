import { lazy, Suspense, useEffect, useState } from "react";
import { afterFirstScreen } from "../lib/after-first-screen";
import { useAssistant } from "./assistant-provider";

const AssistantSidebar = lazy(async () => ({
  default: (await import("./assistant-sidebar")).AssistantSidebar,
}));

/**
 * The docked assistant is its own chunk: it loads once the first screen is
 * shown, or at once when the sidebar was left open. Once loaded it stays
 * mounted, so closing it early keeps its draft.
 */
export function AssistantSidebarSlot() {
  const open = useAssistant()?.open ?? false;
  const [loaded, setLoaded] = useState(open);
  if (open && !loaded) setLoaded(true);
  useEffect(() => afterFirstScreen(() => setLoaded(true)), []);
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <AssistantSidebar />
    </Suspense>
  );
}

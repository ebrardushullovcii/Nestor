import { createContext } from "react";

/**
 * True while a list screen reads its details in a sheet at every width (a
 * resume that needs more width than a side-by-side pane can give), not only
 * where the layout stacks. The sheet's Back control shows whenever it is.
 */
export const DetailSheetForcedContext = createContext(false);

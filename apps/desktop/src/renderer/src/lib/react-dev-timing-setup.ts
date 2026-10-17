import { disableReactPerformanceTracks } from "./react-dev-timing";

// Imported first by main.tsx: React reads console.timeStamp when it loads.
disableReactPerformanceTracks(
  import.meta.env.VITE_NESTOR_REACT_PERFORMANCE_TRACKS === "1",
);

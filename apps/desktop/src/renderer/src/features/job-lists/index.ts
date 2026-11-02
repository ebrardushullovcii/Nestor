/**
 * The shared pieces of every Job Finder list screen (Find jobs, Shortlisted,
 * Applications, Needs you): one list and details layout, one row, one
 * selection model, the same keys, and lists that stay current through
 * `jobs:changed` events from the job store.
 */
export {
  LIST_DETAIL_REGION_ID,
  LIST_ROW_SELECT_PAD_CLASS,
  ListDetailLayout,
  ListPane,
  ListRowCheck,
  ListRowFrame,
  ListRowSkeleton,
  isStackedLayout,
  listRowPlacement,
  useRowPress,
  type ListRowState,
} from "./list-pane";
export {
  NO_SELECTION,
  SELECTING,
  allLoadedSelected,
  clearSelected,
  countSelected,
  isSelected,
  isSelecting,
  selectAll,
  stepSelectAll,
  toSelectionInput,
  toggleSelection,
  type ListSelection,
} from "./list-selection";
export { isMacPlatform, modShortcut } from "./platform-keys";
export {
  LIST_PAGE_SIZE,
  useStoreList,
  type StoreList,
  type StoreListPage,
  type StoreListState,
} from "./use-store-list";
export { useJobList, type JobListFilter } from "./use-job-list";
export { useSelectAllCount } from "./use-select-all-count";
export { useJobDetail } from "./use-job-detail";
export { useListKeys, type ListKeys } from "./use-list-keys";
export {
  STAGE_LABEL,
  describeAge,
  describeFit,
  describeWhere,
  describeWorkModes,
  plural,
  type FitLevel,
} from "./job-format";
export { Fit, FitMeter } from "./fit";
export { besideList, EmptyPane, type BesideList } from "./empty-pane";
export { ListReadError, readErrorText } from "./list-read-error";
export { DetailSheetBack, useDetailSheet } from "./use-detail-sheet";
export { cleanDescription } from "./description";
export { countText, countWords } from "./count-text";
export { CountFigure } from "./count-figure";

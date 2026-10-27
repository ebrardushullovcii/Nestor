/**
 * The shared pieces of every Job Finder list screen (Find jobs, Shortlisted,
 * Applications, Needs you): one list and details layout, one row, one
 * selection model, the same keys, and lists that stay current through
 * `jobs:changed` events from the job store.
 */
export {
  LIST_DETAIL_REGION_ID,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  type ListRowState,
} from "./list-pane";
export {
  NO_SELECTION,
  countSelected,
  isSelected,
  selectAll,
  toSelectionInput,
  toggleSelection,
  type ListSelection,
} from "./list-selection";
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
  type FitTone,
} from "./job-format";

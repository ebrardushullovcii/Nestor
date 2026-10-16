/**
 * The one column split for every list-and-details screen (Find jobs,
 * Shortlisted, Applications and their loading skeleton). Each screen used to
 * carry its own ratio, so the list and the details jumped width when moving
 * between them. The list column is the narrower one; details get the room.
 */
export const LIST_DETAIL_COLUMNS_CLASS =
  "xl:grid-cols-[minmax(24rem,1fr)_minmax(30rem,1.25fr)] assistant-docked:xl:grid-cols-[minmax(16rem,1fr)_minmax(0,1.25fr)]";

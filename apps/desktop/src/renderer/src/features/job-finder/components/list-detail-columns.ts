/**
 * The one column split for every list-and-details screen (Find jobs,
 * Shortlisted, Applications and their loading skeleton). Each screen used to
 * carry its own ratio, so the list and the details jumped width when moving
 * between them. The list column is the narrower one; details get the room.
 */
export const LIST_DETAIL_COLUMNS_CLASS =
  "xl:grid-cols-[minmax(24rem,1fr)_minmax(30rem,1.25fr)] assistant-docked:xl:grid-cols-[minmax(16rem,1fr)_minmax(0,1.25fr)]";

/**
 * The split for a list read as a table (Applications): its columns need the
 * room, and the details are a short form and a timeline.
 */
export const TABLE_DETAIL_COLUMNS_CLASS =
  "xl:grid-cols-[minmax(0,1fr)_minmax(24rem,30rem)] assistant-docked:xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]";

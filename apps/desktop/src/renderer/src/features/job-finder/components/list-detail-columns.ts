/**
 * The one column split for every list-and-details screen (Find jobs,
 * Shortlisted, Applications and their loading skeleton). Each screen used to
 * carry its own ratio, so the list and the details jumped width when moving
 * between them. The list column is the narrower one; details get the room.
 * They sit side by side wherever the `split` variant holds (globals.css).
 */
export const LIST_DETAIL_COLUMNS_CLASS =
  "split:grid-cols-[minmax(22rem,1fr)_minmax(24rem,1.15fr)] assistant-docked:split:grid-cols-[minmax(16rem,1fr)_minmax(0,1.1fr)]";

/**
 * The split for a list read as a table (Applications): its columns need the
 * room, and the details are a short form and a timeline.
 */
export const TABLE_DETAIL_COLUMNS_CLASS =
  "split:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] assistant-docked:split:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]";

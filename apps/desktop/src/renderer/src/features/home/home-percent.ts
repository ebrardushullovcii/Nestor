/** Keep a small nonzero share, or a share short of all, visible in Home. */
export function formatHomePercent(count: number, total: number): string {
  if (total === 0) return "0%";
  const percent = Math.round((count / total) * 1_000) / 10;
  if (percent === 0 && count > 0) return "<0.1%";
  if (percent === 100 && count < total) return ">99.9%";
  return `${percent}%`;
}

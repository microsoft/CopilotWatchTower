export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString("ko-KR");
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultDateRange(): { date_from: string; date_to: string } {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - 30);
  return { date_from: isoDate(start), date_to: isoDate(today) };
}

export function formatKstDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const kst = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} KST`;
}

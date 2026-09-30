export function fmtDate(d: Date | string, opts: Intl.DateTimeFormatOptions = {}) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", ...opts });
}

export function fmtTime(d: Date | string) {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "09:41" for today, "Yesterday", or "18 Sep". */
export function fmtWhen(d: Date | string) {
  const date = new Date(d);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday.getTime() - 86_400_000);
  if (date >= startToday) return fmtTime(date);
  if (date >= startYesterday) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function fmtLongDate(d: Date = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

export function greeting(d: Date = new Date()) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

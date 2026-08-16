export type SnoozePreset = "later_today" | "tomorrow" | "next_monday";

function atLocalTime(base: Date, days: number, hour: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  next.setHours(hour, 0, 0, 0);
  return next;
}

export function snoozeDate(preset: SnoozePreset, now = new Date()): Date {
  if (preset === "later_today") {
    const today = atLocalTime(now, 0, 18);
    if (today.getTime() > now.getTime()) return today;
    return atLocalTime(now, 1, 8);
  }
  if (preset === "tomorrow") return atLocalTime(now, 1, 8);
  const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
  return atLocalTime(now, daysUntilMonday, 8);
}

export function snoozeIso(preset: SnoozePreset, now = new Date()): string {
  return snoozeDate(preset, now).toISOString();
}

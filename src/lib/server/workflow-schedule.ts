import type { WorkflowSchedule } from "@/lib/shared/types";
// Explicit extension also lets the isolated Node regression suite load this
// small scheduling module without Next's resolver.
import { InputError } from "./errors.ts";

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new InputError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return Number(value);
}

export function validateTimezone(timezone: unknown): string {
  if (typeof timezone !== "string" || !timezone.trim() || timezone.length > 100) throw new InputError("Choose a valid IANA timezone.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new InputError("Choose a valid IANA timezone."); }
  return timezone;
}

export function validateWorkflowSchedule(value: unknown): WorkflowSchedule {
  if (!value || typeof value !== "object") throw new InputError("Choose a schedule.");
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === "minutes") return { kind: "minutes", every: integer(schedule.every, 1, 10_080, "Minute interval") };
  if (schedule.kind === "hours") return { kind: "hours", every: integer(schedule.every, 1, 720, "Hour interval") };
  if (schedule.kind === "daily" && typeof schedule.time === "string" && CLOCK.test(schedule.time)) return { kind: "daily", time: schedule.time };
  if (schedule.kind === "weekly" && typeof schedule.time === "string" && CLOCK.test(schedule.time)) return { kind: "weekly", day: integer(schedule.day, 0, 6, "Weekly day"), time: schedule.time };
  throw new InputError("Choose a supported schedule with a valid time.");
}

function local(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(read("weekday"));
  return { weekday, time: `${read("hour")}:${read("minute")}` };
}

/** UTC is persisted; calendar schedules search for the next matching local minute.
 * On DST spring-forward, a missing local minute is skipped; on fall-back the first
 * matching occurrence after `after` is used. */
export function nextWorkflowRun(schedule: WorkflowSchedule, timezone: string, after: Date): string {
  validateTimezone(timezone);
  const start = after.getTime();
  if (schedule.kind === "minutes") return new Date(start + schedule.every * 60_000).toISOString();
  if (schedule.kind === "hours") return new Date(start + schedule.every * 3_600_000).toISOString();
  let candidate = Math.floor(start / 60_000) * 60_000 + 60_000;
  // Eight days covers the next matching weekly wall-clock minute, including DST shifts.
  for (let minute = 0; minute <= 8 * 24 * 60; minute++, candidate += 60_000) {
    const at = local(new Date(candidate), timezone);
    if (at.time === schedule.time && (schedule.kind === "daily" || at.weekday === schedule.day)) return new Date(candidate).toISOString();
  }
  throw new InputError("Could not calculate the next scheduled time for this timezone.");
}

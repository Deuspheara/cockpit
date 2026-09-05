import type { RuleInput } from "./schemas.js";
const dayMs = 86400000;
export function previousDay(day: string) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - dayMs)
    .toISOString()
    .slice(0, 10);
}
export function dueDates(rule: RuleInput, through: string): string[] {
  const start = new Date(`${rule.startOn}T00:00:00Z`),
    end = new Date(
      `${rule.endOn && rule.endOn < through ? rule.endOn : through}T00:00:00Z`,
    );
  if (end.getTime() - start.getTime() > dayMs * 366 * 100)
    throw new Error("Recurrence horizon exceeds 100 years");
  const result: string[] = [];
  for (let index = 0; index < 5201; index++) {
    let date: Date;
    if (rule.cadence === "weekly") {
      const offset =
        ((rule.weekday ?? start.getUTCDay()) - start.getUTCDay() + 7) % 7;
      date = new Date(
        start.getTime() + (offset + index * 7 * rule.interval) * dayMs,
      );
    } else {
      const months =
        (rule.cadence === "yearly" ? 12 : 1) * index * rule.interval;
      const first = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1),
      );
      const last = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
      ).getUTCDate();
      date = new Date(
        Date.UTC(
          first.getUTCFullYear(),
          first.getUTCMonth(),
          Math.min(rule.dayOfMonth ?? start.getUTCDate(), last),
        ),
      );
    }
    if (date > end) break;
    if (date >= start) result.push(date.toISOString());
  }
  return result;
}

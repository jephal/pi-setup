type CronField = {
  values: Set<number>;
  wildcard: boolean;
};

type CronExpression = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export const CRON_SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseNumber(value: string, names: Record<string, number> | undefined): number {
  const normalized = value.toLowerCase();
  const named = names?.[normalized];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron value: ${value}`);
  return Number(value);
}

function parseField(raw: string, min: number, max: number, names?: Record<string, number>): CronField {
  const values = new Set<number>();
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Empty cron field: ${raw}`);

  for (const part of parts) {
    const [base, stepText] = part.split("/");
    if (part.split("/").length > 2) throw new Error(`Invalid cron step: ${part}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`Invalid cron range: ${part}`);
      start = parseNumber(range[0], names);
      end = parseNumber(range[1], names);
    } else {
      start = parseNumber(base, names);
      end = stepText === undefined ? start : max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Cron value is outside ${min}-${max}: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value === 7 && max === 7 ? 0 : value);
  }

  return {
    values,
    wildcard: raw === "*" || raw === "*/1",
  };
}

export function parseCronExpression(input: string): CronExpression {
  const expression = CRON_SHORTCUTS[input.trim().toLowerCase()] ?? input.trim();
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression must have five fields: minute hour day-of-month month day-of-week");
  }

  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 7, WEEKDAYS),
  };
}

function localParts(date: Date, timezone: string): Record<string, number> & { weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAYS[String(parts.weekday).toLowerCase()];
  if (weekday === undefined) throw new Error(`Could not parse weekday for timezone ${timezone}`);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday,
  };
}

function matchesCron(date: Date, expression: CronExpression, timezone: string): boolean {
  const parts = localParts(date, timezone);
  const dayMatches = expression.dayOfMonth.values.has(parts.day);
  const weekdayMatches = expression.dayOfWeek.values.has(parts.weekday);
  const dayMatchesWithCronSemantics = expression.dayOfMonth.wildcard || expression.dayOfWeek.wildcard
    ? dayMatches && weekdayMatches
    : dayMatches || weekdayMatches;

  return expression.minute.values.has(parts.minute)
    && expression.hour.values.has(parts.hour)
    && expression.month.values.has(parts.month)
    && dayMatchesWithCronSemantics;
}

export function localOccurrenceKey(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function nextCronOccurrence(
  expressionText: string,
  timezone: string,
  after: Date,
  skipLocalKey?: string,
): Date {
  const expression = parseCronExpression(expressionText);
  validateTimezone(timezone);
  if (!Number.isFinite(after.getTime())) throw new Error("Invalid reference date");

  const minute = 60_000;
  let candidate = new Date(Math.floor(after.getTime() / minute) * minute + minute);
  const maxIterations = 366 * 24 * 60 * 2;
  for (let index = 0; index < maxIterations; index += 1) {
    if (matchesCron(candidate, expression, timezone)) {
      const key = localOccurrenceKey(candidate, timezone);
      if (key !== skipLocalKey) return candidate;
    }
    candidate = new Date(candidate.getTime() + minute);
  }
  throw new Error("Cron expression has no occurrence within the next year");
}

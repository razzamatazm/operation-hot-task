import type { AppConfig, OfficeTime, Weekday } from "./types.js";

/* The office's week (#457): the one place that knows when the office is open.
   Weekdays without an entry here close at `businessEndHour:businessEndMinute`. */
export const DEFAULT_BUSINESS_END_BY_WEEKDAY: Partial<Record<Weekday, OfficeTime>> = {
  Fri: { hour: 15, minute: 30 }
};

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalParts extends LocalDate {
  weekday: Weekday;
  hour: number;
  minute: number;
}

const parseOffsetMinutes = (value: string): number => {
  const match = value.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
};

const zonedOffsetMinutes = (date: Date, timezone: string): number => {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit"
  })
    .formatToParts(date)
    .find((entry) => entry.type === "timeZoneName");
  return parseOffsetMinutes(part?.value ?? "GMT");
};

export const zonedParts = (date: Date, timezone: string): LocalParts => {
  const partMap = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    year: Number.parseInt(partMap.year ?? "1970", 10),
    month: Number.parseInt(partMap.month ?? "1", 10),
    day: Number.parseInt(partMap.day ?? "1", 10),
    weekday: (partMap.weekday ?? "Mon") as Weekday,
    hour: Number.parseInt(partMap.hour ?? "0", 10),
    minute: Number.parseInt(partMap.minute ?? "0", 10)
  };
};

export const zonedToUtcIso = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): string => {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = zonedOffsetMinutes(new Date(guessUtc), timezone);
  return new Date(guessUtc - offset * 60 * 1000).toISOString();
};

const weekdayOf = (date: LocalDate): Weekday =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day))
  ) as Weekday;

/* The office's hours on one local date, or `undefined` if it doesn't open. */
export const officeHoursOn = (
  date: LocalDate,
  config: AppConfig
): { open: OfficeTime; close: OfficeTime } | undefined => {
  const weekday = weekdayOf(date);
  if (weekday === "Sat" || weekday === "Sun") {
    return undefined;
  }
  const overrides = { ...DEFAULT_BUSINESS_END_BY_WEEKDAY, ...config.businessEndByWeekday };
  return {
    open: { hour: config.businessStartHour, minute: config.businessStartMinute },
    close: overrides[weekday] ?? { hour: config.businessEndHour, minute: config.businessEndMinute }
  };
};

export const isOfficeDay = (date: LocalDate, config: AppConfig): boolean => officeHoursOn(date, config) !== undefined;

export const minutesOfDay = (time: OfficeTime): number => time.hour * 60 + time.minute;

/* Open and close are both inclusive, as they always have been. */
export const isOfficeOpen = (now: Date, config: AppConfig): boolean => {
  const local = zonedParts(now, config.businessTimezone);
  const hours = officeHoursOn(local, config);
  if (!hours) {
    return false;
  }
  const minutes = minutesOfDay(local);
  return minutes >= minutesOfDay(hours.open) && minutes <= minutesOfDay(hours.close);
};

/* The `count`-th office day after `date`; 0 means `date` itself if it's an office day. */
export const nextOfficeDay = (date: LocalDate, count: number, config: AppConfig): LocalDate => {
  const cursor = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const read = (): LocalDate => ({
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate()
  });
  let remaining = count;

  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isOfficeDay(read(), config)) {
      remaining -= 1;
    }
  }

  while (!isOfficeDay(read(), config)) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return read();
};

const instantOn = (date: LocalDate, time: OfficeTime, timezone: string): Date =>
  new Date(zonedToUtcIso(date.year, date.month, date.day, time.hour, time.minute, timezone));

export const officeOpensAt = (date: LocalDate, config: AppConfig): Date | undefined => {
  const hours = officeHoursOn(date, config);
  return hours ? instantOn(date, hours.open, config.businessTimezone) : undefined;
};

export const officeClosesAt = (date: LocalDate, config: AppConfig): Date | undefined => {
  const hours = officeHoursOn(date, config);
  return hours ? instantOn(date, hours.close, config.businessTimezone) : undefined;
};

/* Today's open if `from` is before it on an office day, else the next office day's. */
export const nextOfficeOpen = (from: Date, config: AppConfig): Date => {
  const local = zonedParts(from, config.businessTimezone);
  const today = officeHoursOn(local, config);
  const beforeOpenToday = today !== undefined && minutesOfDay(local) < minutesOfDay(today.open);
  const day = beforeOpenToday ? local : nextOfficeDay(local, 1, config);
  return officeOpensAt(day, config) as Date;
};

/** Пять полей cron в UTC: минута час день месяц день-недели. Секунд и имён месяцев нет. */

const EXPRESSION_MAX = 100;

const FIELD_MAX = 40;

interface CronField {
  /** Буквальная звёздочка, не диапазон на все значения. Нужна для правила дня cron. */
  star: boolean;
  values: ReadonlySet<number>;
}

interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function isValidSchedule(expression: string): boolean {
  return compileSchedule(expression) !== null;
}

export function scheduleMatches(expression: string, now: Date): boolean {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return false;
  }
  const schedule = compileSchedule(expression);
  if (schedule === null) {
    return false;
  }
  if (!schedule.minute.values.has(now.getUTCMinutes())) {
    return false;
  }
  if (!schedule.hour.values.has(now.getUTCHours())) {
    return false;
  }
  if (!schedule.month.values.has(now.getUTCMonth() + 1)) {
    return false;
  }
  return dayMatches(schedule, now);
}

/**
 * Если ограничены и день месяца, и день недели, достаточно одного совпадения.
 * Так устроено пятипольное cron-выражение: иначе суббота, попавшая на число, молчит.
 */
function dayMatches(schedule: CronSchedule, now: Date): boolean {
  const domOk = fieldHas(schedule.dayOfMonth, now.getUTCDate(), false);
  const dowOk = fieldHas(schedule.dayOfWeek, now.getUTCDay(), true);
  if (schedule.dayOfMonth.star && schedule.dayOfWeek.star) {
    return true;
  }
  if (schedule.dayOfMonth.star) {
    return dowOk;
  }
  if (schedule.dayOfWeek.star) {
    return domOk;
  }
  return domOk || dowOk;
}

function fieldHas(field: CronField, value: number, sundaySeven: boolean): boolean {
  if (field.values.has(value)) {
    return true;
  }
  return sundaySeven && value === 0 && field.values.has(7);
}

function compileSchedule(expression: string): CronSchedule | null {
  if (expression.length < 1 || expression.length > EXPRESSION_MAX) {
    return null;
  }
  for (let index = 0; index < expression.length; index += 1) {
    if (!isScheduleChar(expression.charCodeAt(index))) {
      return null;
    }
  }
  const fields = splitFields(expression);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    domField === undefined ||
    monthField === undefined ||
    dowField === undefined
  ) {
    return null;
  }
  const minute = parseField(minuteField, 0, 59);
  const hour = parseField(hourField, 0, 23);
  const dayOfMonth = parseField(domField, 1, 31);
  const month = parseField(monthField, 1, 12);
  const dayOfWeek = parseField(dowField, 0, 7);
  if (
    minute === null ||
    hour === null ||
    dayOfMonth === null ||
    month === null ||
    dayOfWeek === null
  ) {
    return null;
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function isScheduleChar(code: number): boolean {
  if (code >= 48 && code <= 57) {
    return true;
  }
  return code === 32 || code === 42 || code === 44 || code === 45 || code === 47;
}

function splitFields(expression: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let index = 0; index < expression.length; index += 1) {
    const code = expression.charCodeAt(index);
    if (code === 32) {
      if (current.length === 0) {
        return [];
      }
      fields.push(current);
      current = "";
      continue;
    }
    current += expression.charAt(index);
    if (current.length > FIELD_MAX) {
      return [];
    }
  }
  if (current.length === 0) {
    return [];
  }
  fields.push(current);
  return fields;
}

function parseField(field: string, min: number, max: number): CronField | null {
  if (field.length < 1 || field.length > FIELD_MAX) {
    return null;
  }
  const parts = field.split(",");
  if (parts.length < 1 || parts.length > 16) {
    return null;
  }
  const values = new Set<number>();
  let star = false;
  for (const part of parts) {
    const parsed = parsePart(part, min, max);
    if (parsed === null) {
      return null;
    }
    if (parsed.star) {
      star = true;
    }
    for (const value of parsed.values) {
      values.add(value);
    }
  }
  if (values.size === 0) {
    return null;
  }
  return { star, values };
}

function parsePart(
  part: string,
  min: number,
  max: number,
): { star: boolean; values: number[] } | null {
  if (part.length < 1 || part.length > 20) {
    return null;
  }
  const slash = part.indexOf("/");
  let head = part;
  let step = 1;
  if (slash !== -1) {
    head = part.slice(0, slash);
    const stepText = part.slice(slash + 1);
    if (head.length === 0 || stepText.length === 0 || stepText.includes("/")) {
      return null;
    }
    const parsedStep = parseNumber(stepText, 1, max);
    if (parsedStep === null) {
      return null;
    }
    step = parsedStep;
  }
  if (head === "*") {
    return { star: slash === -1, values: expand(min, max, step) };
  }
  const dash = head.indexOf("-");
  if (dash !== -1) {
    if (dash === 0 || head.indexOf("-", dash + 1) !== -1) {
      return null;
    }
    const start = parseNumber(head.slice(0, dash), min, max);
    const end = parseNumber(head.slice(dash + 1), min, max);
    if (start === null || end === null || start > end) {
      return null;
    }
    return { star: false, values: expand(start, end, step) };
  }
  if (slash !== -1) {
    return null;
  }
  const value = parseNumber(head, min, max);
  if (value === null) {
    return null;
  }
  return { star: false, values: [value] };
}

function expand(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
    if (values.length > 60) {
      break;
    }
  }
  return values;
}

function parseNumber(text: string, min: number, max: number): number | null {
  if (text.length < 1 || text.length > 2) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }
    value = value * 10 + (code - 48);
  }
  if (value < min || value > max) {
    return null;
  }
  return value;
}

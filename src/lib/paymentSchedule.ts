import type {
  PaymentFrequency,
  PaymentRule,
} from "../types/paymentRule";

export interface ScheduledPayment {
  paymentNumber: number;
  date: string;
}

function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date: ${value}`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();

  const firstOfTargetMonth = new Date(
    Date.UTC(year, month, 1),
  );

  const lastDay = new Date(
    Date.UTC(
      firstOfTargetMonth.getUTCFullYear(),
      firstOfTargetMonth.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      firstOfTargetMonth.getUTCFullYear(),
      firstOfTargetMonth.getUTCMonth(),
      Math.min(day, lastDay),
    ),
  );
}

function nextDate(
  date: Date,
  frequency: PaymentFrequency,
): Date {
  switch (frequency) {
    case "daily":
      return addDays(date, 1);

    case "weekly":
      return addDays(date, 7);

    case "monthly":
      return addMonthsClamped(date, 1);
  }
}

/**
 * Plans dates inclusively from startDate through endDate.
 * This function does not register or execute payments.
 */
export function planPaymentDates(
  rule: Pick<
    PaymentRule,
    "frequency" | "startDate" | "endDate" | "maxPayments"
  >,
): ScheduledPayment[] {
  const start = parseDateOnly(rule.startDate);
  const end = parseDateOnly(rule.endDate);

  if (end < start) {
    throw new Error("End date must be on or after start date.");
  }

  if (
    !Number.isSafeInteger(rule.maxPayments) ||
    rule.maxPayments < 1 ||
    rule.maxPayments > 10000
  ) {
    throw new Error("Maximum payments must be between 1 and 10,000.");
  }

  const payments: ScheduledPayment[] = [];
  let current = start;

  while (current <= end && payments.length < rule.maxPayments) {
    payments.push({
      paymentNumber: payments.length + 1,
      date: formatDate(current),
    });

    current = nextDate(current, rule.frequency);
  }

  return payments;
}
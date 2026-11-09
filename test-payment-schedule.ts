import { planPaymentDates } from "./src/lib/paymentSchedule.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

// 1. Daily schedule
const daily = planPaymentDates({
  frequency: "daily",
  startDate: "2026-10-24",
  endDate: "2026-10-26",
  maxPayments: 5,
});
assert(daily.length === 3, "Daily schedule generates 3 payments");
assert(
  daily[2].date === "2026-10-26",
  "Daily schedule includes the end date",
);

// 2. Weekly schedule
const weekly = planPaymentDates({
  frequency: "weekly",
  startDate: "2026-10-24",
  endDate: "2026-11-15",
  maxPayments: 10,
});
assert(weekly.length === 4, "Weekly schedule generates 4 payments");
assert(
  weekly[1].date === "2026-10-31",
  "Weekly schedule advances by 7 days",
);

// 3. Monthly schedule
const monthly = planPaymentDates({
  frequency: "monthly",
  startDate: "2026-01-31",
  endDate: "2026-04-30",
  maxPayments: 10,
});
assert(monthly.length === 4, "Monthly schedule generates 4 payments");
assert(
  monthly[1].date === "2026-02-28",
  "Monthly schedule handles February correctly",
);

// 4. Maximum payment limit
const limited = planPaymentDates({
  frequency: "daily",
  startDate: "2026-10-24",
  endDate: "2026-10-30",
  maxPayments: 2,
});
assert(limited.length === 2, "Maximum payment limit is respected");

// 5. Invalid calendar date
let invalidDateRejected = false;
try {
  planPaymentDates({
    frequency: "daily",
    startDate: "2026-02-30",
    endDate: "2026-03-05",
    maxPayments: 5,
  });
} catch {
  invalidDateRejected = true;
}
assert(invalidDateRejected, "Invalid calendar dates are rejected");

// 6. End date before start date
let reversedRangeRejected = false;
try {
  planPaymentDates({
    frequency: "daily",
    startDate: "2026-10-26",
    endDate: "2026-10-24",
    maxPayments: 5,
  });
} catch {
  reversedRangeRejected = true;
}
assert(reversedRangeRejected, "End date before start date is rejected");

console.log("\nAll schedule tests passed.");
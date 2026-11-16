export type PaymentFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "two_minutes_test";

export interface PaymentRule {
  id: string;
  payer: string;
  recipient: string;
  amountRlo: string;
  frequency: PaymentFrequency;
  startDate: string;
  endDate: string;
  maxPayments: number;
  createdAt: string;
}

export type PaymentRuleStatus =
  | "draft"
  | "pending"
  | "partially_registered"
  | "active"
  | "paused"
  | "completed"
  | "failed";

export type ScheduledPaymentRegistrationStatus =
  | "pending"
  | "verification_pending"
  | "verification_failed"
  | "registered"
  | "executed"
  | "failed"
  | "not_registered";

export interface ScheduledPaymentRegistration {
  paymentNumber: number;
  date: string;

  // Exact millisecond trigger boundaries, stored as strings for JSON compatibility.
  timestampRangeMs?: readonly [string, string];

  nonce: string;
  status: ScheduledPaymentRegistrationStatus;
  subscriptionAddress?: string;
  creationSignature?: string;
  triggeredSignature?: string;
  triggeredBlockNumber?: string;
  error?: string;
}

export interface PaymentRuleRecord extends PaymentRule {
  status: PaymentRuleStatus;
  scheduledPayments?: ScheduledPaymentRegistration[];

  // Retained for compatibility with existing records.
  subscriptionAddress?: string;
  creationSignature?: string;
}
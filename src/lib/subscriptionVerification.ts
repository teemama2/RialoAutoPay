import {
  PublicKey,
  transferInstruction,
  type Instruction,
  type Subscription,
  type SubscriptionInstruction,
} from "@rialo/ts-cdk";

import { rialoClient } from "./rialoClient";
import {
  buildNativeDestroyInstruction,
  deriveSubscriptionAddress,
} from "./subscriptionBuilder";

const SYSTEM_PROGRAM_ID =
  "11111111111111111111111111111111";

const CLOCK_TOPIC = "clock";

const CLOCK_SYSVAR =
  "SysvarC1ock11111111111111111111111111111111";

const U64_MAX = 18_446_744_073_709_551_615n;
const DAY_MS = 86_400_000;

const MAX_LOOKUP_ATTEMPTS = 5;
const LOOKUP_RETRY_DELAY_MS = 800;

export class SubscriptionVerificationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SubscriptionVerificationError";
    this.retryable = retryable;
  }
}

export type SubscriptionVerificationInput = {
  subscriberAddress: string;
  recipientAddress: string;
  nonce: string;
  subscriptionAddress: string;
  amountKelvin: bigint;
  timestampRange: readonly [bigint, bigint];
};

/**
 * Converts an RLO decimal amount to kelvin without floating-point math.
 */
export function parsePaymentAmountToKelvin(
  amountRlo: string,
): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(
    amountRlo.trim(),
  );

  if (!match) {
    throw new Error(
      "Invalid RLO amount. Maximum precision is 9 decimal places.",
    );
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt(
    (match[2] ?? "").padEnd(9, "0") || "0",
  );

  const amount = whole * 1_000_000_000n + fraction;

  if (amount <= 0n || amount > U64_MAX) {
    throw new Error("RLO amount is outside the supported range.");
  }

  return amount;
}

/**
 * Creates UTC calendar-day boundaries for a scheduled payment.
 * Rialo timestamp ranges use milliseconds, start-inclusive/end-exclusive.
 */
export function getUtcPaymentTimestampRange(
  paymentDate: string,
): readonly [bigint, bigint] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    throw new Error(`Invalid scheduled date: ${paymentDate}`);
  }

  const startMs = Date.parse(
    `${paymentDate}T00:00:00.000Z`,
  );

  if (
    !Number.isFinite(startMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== paymentDate
  ) {
    throw new Error(`Invalid calendar date: ${paymentDate}`);
  }

  return [
    BigInt(startMs),
    BigInt(startMs + DAY_MS),
  ];
}

function sameBytes(
  first: Uint8Array,
  second: Uint8Array,
): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every(
    (byte, index) => byte === second[index],
  );
}

function verifyInstruction(
  actual: SubscriptionInstruction,
  expected: Instruction,
  label: string,
): void {
  if (
    actual.programId !== expected.programId.toString()
  ) {
    throw new Error(
      `${label}: the stored program ID does not match.`,
    );
  }

  if (actual.accounts.length !== expected.accounts.length) {
    throw new Error(
      `${label}: the stored account count does not match.`,
    );
  }

  for (
    let index = 0;
    index < expected.accounts.length;
    index += 1
  ) {
    const actualAccount = actual.accounts[index];
    const expectedAccount = expected.accounts[index];

    if (
      actualAccount.pubkey !== expectedAccount.pubkey.toString() ||
      actualAccount.isSigner !== expectedAccount.isSigner ||
      actualAccount.isWritable !== expectedAccount.isWritable
    ) {
      throw new Error(
        `${label}: stored account ${index + 1} does not match.`,
      );
    }
  }

  if (!sameBytes(actual.data, expected.data)) {
    throw new Error(
      `${label}: stored instruction data does not match the intended payment.`,
    );
  }
}

/**
 * Checks the subscription record returned by the Rialo SDK.
 */
export function assertSubscriptionRecordMatches(
  subscription: Subscription,
  expected: SubscriptionVerificationInput,
): void {
  const subscriber = PublicKey.fromString(
    expected.subscriberAddress,
  );

  const recipient = PublicKey.fromString(
    expected.recipientAddress,
  );

  const subscriptionAddress = PublicKey.fromString(
    expected.subscriptionAddress,
  );

  if (subscription.subscriber !== subscriber.toString()) {
    throw new Error(
      "The stored subscription belongs to a different subscriber.",
    );
  }

  if (subscription.kind !== "OneShot") {
    throw new Error(
      "The stored subscription is not a OneShot subscription.",
    );
  }

  if (subscription.topic !== CLOCK_TOPIC) {
    throw new Error(
      "The stored subscription has an unexpected event topic.",
    );
  }

  if (subscription.eventAccount !== CLOCK_SYSVAR) {
    throw new Error(
      "The stored subscription has an unexpected clock event account.",
    );
  }

  const actualRange = subscription.timestampRange;
  const [expectedStart, expectedEnd] = expected.timestampRange;

  if (
    !actualRange ||
    actualRange[0] !== expectedStart ||
    actualRange[1] !== expectedEnd
  ) {
    throw new Error(
      "The stored subscription timestamp range does not match the scheduled payment date.",
    );
  }

  if (subscription.instructions.length !== 2) {
    throw new Error(
      "The stored OneShot subscription does not contain the expected transfer and cleanup instructions.",
    );
  }

  const expectedTransfer = transferInstruction(
    subscriber,
    recipient,
    expected.amountKelvin,
  );

  verifyInstruction(
    subscription.instructions[0],
    expectedTransfer,
    "Payment transfer",
  );

  const expectedDestroy = buildNativeDestroyInstruction(
    subscriber.toString(),
    subscriptionAddress.toString(),
    expected.nonce,
  );

  verifyInstruction(
    subscription.instructions[1],
    expectedDestroy,
    "OneShot cleanup",
  );

  if (
    expectedTransfer.programId.toString() !== SYSTEM_PROGRAM_ID
  ) {
    throw new Error(
      "The expected payment is not a native System Program transfer.",
    );
  }
}

/**
 * Retrieves the subscription from Rialo Devnet and verifies its contents.
 *
 * A temporary lookup failure is retryable. A returned record that does
 * not match the intended payment is a permanent verification failure.
 */
export async function verifyNativeSubscriptionRegistration(
  expected: SubscriptionVerificationInput,
): Promise<Subscription> {
  const subscriber = PublicKey.fromString(
    expected.subscriberAddress,
  );

  const derivedAddress = await deriveSubscriptionAddress(
    subscriber.toString(),
    expected.nonce,
  );

  const expectedAddress = PublicKey.fromString(
    expected.subscriptionAddress,
  ).toString();

  if (derivedAddress !== expectedAddress) {
    throw new SubscriptionVerificationError(
      "The saved subscription address does not match the address derived from its subscriber and nonce.",
      false,
    );
  }

  let lastLookupError =
    "No subscription record was returned.";

  for (
    let attempt = 1;
    attempt <= MAX_LOOKUP_ATTEMPTS;
    attempt += 1
  ) {
    let subscription: Subscription;

    try {
      subscription = await rialoClient.getSubscription(
        subscriber,
        expected.nonce,
      );
    } catch (cause) {
      lastLookupError =
        cause instanceof Error
          ? cause.message
          : "Rialo could not return the subscription record.";

      if (attempt < MAX_LOOKUP_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, LOOKUP_RETRY_DELAY_MS);
        });
      }

      continue;
    }

    try {
      assertSubscriptionRecordMatches(
        subscription,
        expected,
      );
    } catch (cause) {
      throw new SubscriptionVerificationError(
        cause instanceof Error
          ? cause.message
          : "The stored subscription does not match the intended payment.",
        false,
      );
    }

    return subscription;
  }

  throw new SubscriptionVerificationError(
    `The creation transaction was confirmed, but Rialo did not return a verifiable subscription record after ${MAX_LOOKUP_ATTEMPTS} attempts. Last RPC error: ${lastLookupError}`,
    true,
  );
}

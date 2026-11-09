import assert from "node:assert/strict";

import {
  PublicKey,
  transferInstruction,
  type Subscription,
  type SubscriptionInstruction,
} from "@rialo/ts-cdk";

import {
  assertSubscriptionRecordMatches,
  getUtcPaymentTimestampRange,
  parsePaymentAmountToKelvin,
  type SubscriptionVerificationInput,
} from "../src/lib/subscriptionVerification.ts";

import {
  buildNativeDestroyInstruction,
  deriveSubscriptionAddress,
} from "../src/lib/subscriptionBuilder.ts";

const SUBSCRIBER =
  "CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko";

const RECIPIENT =
  "11111111111111111111111111111111";

const CLOCK_SYSVAR =
  "SysvarC1ock11111111111111111111111111111111";

const NONCE = "verification-test";
const AMOUNT = 1_250_000_000n;
const PAYMENT_DATE = "2026-12-04";

const START = BigInt(
  Date.parse(`${PAYMENT_DATE}T00:00:00.000Z`),
);

const END = START + 86_400_000n;

const subscriberKey = PublicKey.fromString(SUBSCRIBER);
const recipientKey = PublicKey.fromString(RECIPIENT);

type FixtureOverrides = {
  subscriber?: string;
  kind?: Subscription["kind"];
  topic?: string;
  eventAccount?: string;
  timestampRange?: [bigint, bigint];
  transferRecipient?: PublicKey;
  transferAmount?: bigint;
  destroyProgram?: string;
  destroyAccounts?: SubscriptionInstruction["accounts"];
  destroyData?: Uint8Array;
  instructionCount?: "normal" | "missing-destroy";
};

const expectedAddress = await deriveSubscriptionAddress(
  SUBSCRIBER,
  NONCE,
);

const expected: SubscriptionVerificationInput = {
  subscriberAddress: SUBSCRIBER,
  recipientAddress: RECIPIENT,
  nonce: NONCE,
  subscriptionAddress: expectedAddress,
  amountKelvin: AMOUNT,
  timestampRange: [START, END],
};

function makeSubscription(
  overrides: FixtureOverrides = {},
): Subscription {
  const transfer = transferInstruction(
    subscriberKey,
    overrides.transferRecipient ?? recipientKey,
    overrides.transferAmount ?? AMOUNT,
  );

  const transferRecord: SubscriptionInstruction = {
    programId: transfer.programId.toString(),
    accounts: transfer.accounts.map((account) => ({
      pubkey: account.pubkey.toString(),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: new Uint8Array(transfer.data),
  };

  const expectedDestroy = buildNativeDestroyInstruction(
    SUBSCRIBER,
    expectedAddress,
    NONCE,
  );

  const destroyRecord: SubscriptionInstruction = {
    programId:
      overrides.destroyProgram ?? expectedDestroy.programId.toString(),
    accounts: overrides.destroyAccounts ?? expectedDestroy.accounts.map(
      (account) => ({
        pubkey: account.pubkey.toString(),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      }),
    ),
    data: overrides.destroyData ?? new Uint8Array(expectedDestroy.data),
  };

  const instructions =
    overrides.instructionCount === "missing-destroy"
      ? [transferRecord]
      : [transferRecord, destroyRecord];

  return {
    subscriber: overrides.subscriber ?? SUBSCRIBER,
    kind: overrides.kind ?? "OneShot",
    topic: overrides.topic ?? "clock",
    eventAccount: overrides.eventAccount ?? CLOCK_SYSVAR,
    timestampRange:
      overrides.timestampRange ?? [START, END],
    instructions,
  };
}

function toRawRialoRpcRecord(subscription: Subscription) {
  return {
    kind: subscription.kind,
    topic: subscription.topic,
    subscriber: subscription.subscriber,
    event_account: subscription.eventAccount,
    timestamp_range: subscription.timestampRange?.map(String),
    instructions: subscription.instructions.map((instruction) => ({
      program_id: instruction.programId,
      accounts: instruction.accounts.map((account) => ({
        pubkey: account.pubkey,
        is_signer: account.isSigner,
        is_writable: account.isWritable,
      })),
      data: Array.from(instruction.data),
    })),
  };
}

function test(
  name: string,
  callback: () => void,
): void {
  callback();
  console.log(`PASS: ${name}`);
}

function expectMismatch(
  name: string,
  subscription: Subscription,
  pattern: RegExp,
): void {
  test(name, () => {
    assert.throws(
      () => assertSubscriptionRecordMatches(
        subscription,
        expected,
      ),
      pattern,
    );
  });
}

console.log("\n===== SUBSCRIPTION VERIFICATION TESTS =====\n");

test("Correct subscription record is accepted", () => {
  assert.doesNotThrow(() => {
    assertSubscriptionRecordMatches(
      makeSubscription(),
      expected,
    );
  });
});

test("Raw Rialo snake_case RPC subscription record is accepted", () => {
  const rawRecord = toRawRialoRpcRecord(makeSubscription());

  assert.equal(
    rawRecord.event_account,
    CLOCK_SYSVAR,
  );

  assert.deepEqual(
    rawRecord.timestamp_range,
    [START.toString(), END.toString()],
  );

  assert.doesNotThrow(() => {
    assertSubscriptionRecordMatches(
      rawRecord,
      expected,
    );
  });
});

expectMismatch(
  "Wrong subscriber is rejected",
  makeSubscription({
    subscriber: RECIPIENT,
  }),
  /different subscriber/,
);

expectMismatch(
  "Persistent subscription is rejected",
  makeSubscription({
    kind: "Persistent",
  }),
  /not a OneShot/,
);

expectMismatch(
  "Wrong event topic is rejected",
  makeSubscription({
    topic: "other-topic",
  }),
  /unexpected event topic/,
);

expectMismatch(
  "Wrong event account is rejected",
  makeSubscription({
    eventAccount: RECIPIENT,
  }),
  /unexpected clock event account/,
);

expectMismatch(
  "Wrong timestamp range is rejected",
  makeSubscription({
    timestampRange: [START, END + 1n],
  }),
  /timestamp range does not match/,
);

expectMismatch(
  "Wrong transfer recipient is rejected",
  makeSubscription({
    transferRecipient: subscriberKey,
  }),
  /account 2 does not match/,
);

expectMismatch(
  "Wrong transfer amount is rejected",
  makeSubscription({
    transferAmount: AMOUNT + 1n,
  }),
  /instruction data does not match/,
);

expectMismatch(
  "Missing OneShot cleanup instruction is rejected",
  makeSubscription({
    instructionCount: "missing-destroy",
  }),
  /transfer and cleanup instructions/,
);

expectMismatch(
  "Wrong cleanup program is rejected",
  makeSubscription({
    destroyProgram: RECIPIENT,
  }),
  /stored program ID does not match/,
);

expectMismatch(
  "Wrong cleanup subscription address is rejected",
  makeSubscription({
    destroyAccounts: [
      {
        pubkey: SUBSCRIBER,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: RECIPIENT,
        isSigner: false,
        isWritable: true,
      },
    ],
  }),
  /stored account 2 does not match/,
);

expectMismatch(
  "Empty cleanup instruction data is rejected",
  makeSubscription({
    destroyData: new Uint8Array(),
  }),
  /instruction data does not match/,
);

function tamperedDestroyNonce(): Uint8Array {
  const instruction = buildNativeDestroyInstruction(
    SUBSCRIBER,
    expectedAddress,
    NONCE,
  );

  const data = new Uint8Array(instruction.data);
  data[data.length - 1] ^= 1;
  return data;
}

expectMismatch(
  "Wrong cleanup nonce payload is rejected",
  makeSubscription({
    destroyData: tamperedDestroyNonce(),
  }),
  /instruction data does not match/,
);

test("RLO decimal amount converts exactly to kelvin", () => {
  assert.equal(
    parsePaymentAmountToKelvin("1.25"),
    1_250_000_000n,
  );

  assert.equal(
    parsePaymentAmountToKelvin("0.000000001"),
    1n,
  );
});

test("Invalid RLO precision is rejected", () => {
  assert.throws(
    () => parsePaymentAmountToKelvin("1.1234567890"),
    /Maximum precision/,
  );
});

test("Zero RLO amount is rejected", () => {
  assert.throws(
    () => parsePaymentAmountToKelvin("0"),
    /outside the supported range/,
  );
});

test("UTC scheduled date produces millisecond boundaries", () => {
  assert.deepEqual(
    getUtcPaymentTimestampRange(PAYMENT_DATE),
    [START, END],
  );
});

test("Invalid calendar date is rejected", () => {
  assert.throws(
    () => getUtcPaymentTimestampRange("2026-02-30"),
    /Invalid calendar date/,
  );
});

test("Invalid date format is rejected", () => {
  assert.throws(
    () => getUtcPaymentTimestampRange("04-12-2026"),
    /Invalid scheduled date/,
  );
});

console.log("\n==========================================");
console.log("RESULT: 20 verification tests passed.");
console.log("==========================================\n");

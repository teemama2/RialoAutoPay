import assert from "node:assert/strict";
import {
  PublicKey,
  type Instruction,
} from "@rialo/ts-cdk";

import {
  SUBSCRIBER_PROGRAM_ID,
  MAX_STATIC_ACCOUNTS_PER_PACKET,
  deriveSubscriptionAddress,
  buildNativeSubscribeInstruction,
  buildNativeUnsubscribeInstruction,
} from "../src/lib/subscriptionBuilder.ts";

const SUBSCRIBER =
  "CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko";

const SYSTEM_PROGRAM =
  "11111111111111111111111111111111";

const CLOCK_SYSVAR =
  "SysvarC1ock11111111111111111111111111111111";

const U64_MAX = 18_446_744_073_709_551_615n;

type Overrides = {
  nonceText?: string;
  kind?: "Persistent" | "OneShot";
  timestampRange?: readonly [bigint, bigint];
  activeCommits?: readonly [bigint, bigint];
};

function makeInput(
  instructions: Instruction[],
  overrides: Overrides = {},
) {
  return {
    subscriberAddress: SUBSCRIBER,
    nonceText: overrides.nonceText ?? "builder-test",
    predicate: {
      topic: "clock",
      eventAccount: CLOCK_SYSVAR,
      timestampRange:
        overrides.timestampRange ?? [0n, U64_MAX] as const,
    },
    instructions,
    kind: overrides.kind ?? "Persistent",
    activeCommits:
      overrides.activeCommits ?? [0n, U64_MAX] as const,
  };
}

function basicInstruction(): Instruction {
  return {
    programId: PublicKey.fromString(SYSTEM_PROGRAM),
    accounts: [],
    data: new Uint8Array([1, 2, 3]),
  };
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let leadingZeroes = 0;

  while (
    leadingZeroes < bytes.length &&
    bytes[leadingZeroes] === 0
  ) {
    leadingZeroes++;
  }

  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = alphabet[remainder] + encoded;
  }

  return "1".repeat(leadingZeroes) + encoded;
}

function generatedPublicKey(value: number): PublicKey {
  const bytes = new Uint8Array(32);
  let remaining = BigInt(value);

  for (let index = 31; index >= 0 && remaining > 0n; index--) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }

  return PublicKey.fromString(encodeBase58(bytes));
}

async function runTests() {
  let passed = 0;

  async function test(
    name: string,
    callback: () => void | Promise<void>,
  ) {
    await callback();
    passed++;
    console.log(`PASS: ${name}`);
  }

  console.log("\n===== SUBSCRIPTION BUILDER TESTS =====\n");

  await test("Rialo static account limit is 126", () => {
    assert.equal(MAX_STATIC_ACCOUNTS_PER_PACKET, 126);
  });

  await test("Subscription PDA derivation is deterministic", async () => {
    const first = await deriveSubscriptionAddress(
      SUBSCRIBER,
      "builder-test",
    );

    const second = await deriveSubscriptionAddress(
      SUBSCRIBER,
      "builder-test",
    );

    assert.equal(first, second);
  });

  await test("Different nonces produce different subscription PDAs", async () => {
    const first = await deriveSubscriptionAddress(
      SUBSCRIBER,
      "builder-test-one",
    );

    const second = await deriveSubscriptionAddress(
      SUBSCRIBER,
      "builder-test-two",
    );

    assert.notEqual(first, second);
  });

  await test("Persistent Subscribe instruction has correct outer accounts", async () => {
    const result = await buildNativeSubscribeInstruction(
      makeInput([basicInstruction()]),
    );

    assert.equal(
      result.instruction.programId.toString(),
      SUBSCRIBER_PROGRAM_ID,
    );

    assert.equal(
      result.subscriptionAddress,
      await deriveSubscriptionAddress(SUBSCRIBER, "builder-test"),
    );

    assert.equal(result.instruction.accounts.length, 3);

    assert.equal(
      result.instruction.accounts[0].pubkey.toString(),
      SUBSCRIBER,
    );
    assert.equal(result.instruction.accounts[0].isSigner, true);
    assert.equal(result.instruction.accounts[0].isWritable, true);

    assert.equal(
      result.instruction.accounts[1].pubkey.toString(),
      result.subscriptionAddress,
    );
    assert.equal(result.instruction.accounts[1].isWritable, true);

    assert.equal(
      result.instruction.accounts[2].pubkey.toString(),
      SYSTEM_PROGRAM,
    );
    assert.equal(result.instruction.accounts[2].isWritable, false);

    assert.ok(result.instruction.data.length > 0);
  });

  await test("OneShot includes the additional Destroy instruction", async () => {
    const persistent = await buildNativeSubscribeInstruction(
      makeInput([basicInstruction()], {
        nonceText: "oneshot-check",
        kind: "Persistent",
      }),
    );

    const oneShot = await buildNativeSubscribeInstruction(
      makeInput([basicInstruction()], {
        nonceText: "oneshot-check",
        kind: "OneShot",
      }),
    );

    assert.ok(
      oneShot.instruction.data.length >
      persistent.instruction.data.length,
    );
  });

  await test("Unsubscribe instruction has the expected accounts", async () => {
    const result = await buildNativeUnsubscribeInstruction(
      SUBSCRIBER,
      "unsubscribe-test",
    );

    assert.equal(
      result.instruction.programId.toString(),
      SUBSCRIBER_PROGRAM_ID,
    );

    assert.equal(result.instruction.accounts.length, 2);

    assert.equal(
      result.instruction.accounts[0].pubkey.toString(),
      SUBSCRIBER,
    );
    assert.equal(result.instruction.accounts[0].isSigner, true);
    assert.equal(result.instruction.accounts[0].isWritable, true);

    assert.equal(
      result.instruction.accounts[1].pubkey.toString(),
      result.subscriptionAddress,
    );
    assert.equal(result.instruction.accounts[1].isWritable, true);

    assert.ok(result.instruction.data.length > 0);
  });

  await test("Empty subscription instruction list is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(makeInput([])),
      /at least one instruction/,
    );
  });

  await test("Empty nonce is rejected", async () => {
    await assert.rejects(
      () => deriveSubscriptionAddress(SUBSCRIBER, ""),
      /Nonce must contain 1-32 UTF-8 bytes/,
    );
  });

  await test("Nonce longer than 32 UTF-8 bytes is rejected", async () => {
    await assert.rejects(
      () => deriveSubscriptionAddress(SUBSCRIBER, "a".repeat(33)),
      /Nonce must contain 1-32 UTF-8 bytes/,
    );
  });

  await test("Additional signer in an inner instruction is rejected", async () => {
    const invalidInstruction: Instruction = {
      programId: PublicKey.fromString(SYSTEM_PROGRAM),
      accounts: [{
        pubkey: generatedPublicKey(900),
        isSigner: true,
        isWritable: true,
      }],
      data: new Uint8Array(),
    };

    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([invalidInstruction]),
      ),
      /cannot require another signer/,
    );
  });

  await test("Reversed predicate timestamp range is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([basicInstruction()], {
          timestampRange: [20n, 10n],
        }),
      ),
      /Invalid predicate timestamp range/,
    );
  });

  await test("Negative predicate timestamp is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([basicInstruction()], {
          timestampRange: [-1n, 10n],
        }),
      ),
      /Invalid predicate timestamp range/,
    );
  });

  await test("Predicate timestamp above u64 maximum is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([basicInstruction()], {
          timestampRange: [0n, U64_MAX + 1n],
        }),
      ),
      /Invalid predicate timestamp range/,
    );
  });

  await test("Reversed active commit range is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([basicInstruction()], {
          activeCommits: [20n, 10n],
        }),
      ),
      /Invalid active commit range/,
    );
  });

  await test("Active commit above u64 maximum is rejected", async () => {
    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput([basicInstruction()], {
          activeCommits: [0n, U64_MAX + 1n],
        }),
      ),
      /Invalid active commit range/,
    );
  });

  await test("Exactly 126 unique inner program keys are accepted", async () => {
    const instructions: Instruction[] = Array.from(
      { length: 126 },
      (_, index) => ({
        programId: generatedPublicKey(index + 1),
        accounts: [],
        data: new Uint8Array(),
      }),
    );

    const result = await buildNativeSubscribeInstruction(
      makeInput(instructions, {
        nonceText: "limit-126",
      }),
    );

    assert.ok(result.instruction.data.length > 0);
  });

  await test("127 unique inner program keys are rejected", async () => {
    const instructions: Instruction[] = Array.from(
      { length: 127 },
      (_, index) => ({
        programId: generatedPublicKey(index + 1),
        accounts: [],
        data: new Uint8Array(),
      }),
    );

    await assert.rejects(
      () => buildNativeSubscribeInstruction(
        makeInput(instructions, {
          nonceText: "limit-127",
        }),
      ),
      /127 unique program\/account keys/,
    );
  });

  console.log("\n======================================");
  console.log(`RESULT: ${passed} tests passed.`);
  console.log("======================================\n");
}

runTests().catch((error: unknown) => {
  console.error("\nTEST FAILURE:");
  console.error(error);
  process.exitCode = 1;
});

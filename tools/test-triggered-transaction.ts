
import assert from "node:assert/strict";

import {
  verifyTriggeredTransaction,
} from "../src/lib/subscriptionMonitor.ts";

const PAYER =
  "CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko";

const RECIPIENT =
  "3f6L7jBBdPEKJf7v1rb9fNLhYetSw85Cwv79srGnsWrZ";

const SYSTEM_PROGRAM =
  "11111111111111111111111111111111";

const SIGNATURE = "5".repeat(64);

const EXPECTED = {
  payerAddress: PAYER,
  recipientAddress: RECIPIENT,
  expectedAmountRlo: "0.001",
};

function encodeBase58(bytes: Uint8Array): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = alphabet[remainder] + encoded;
  }

  let leadingZeros = 0;

  while (
    leadingZeros < bytes.length &&
    bytes[leadingZeros] === 0
  ) {
    leadingZeros++;
  }

  return "1".repeat(leadingZeros) + encoded;
}

function makeTransferData(amountKelvin: bigint): string {
  const bytes = new Uint8Array(12);

  // System Program Transfer discriminator = 2.
  bytes.set([2, 0, 0, 0], 0);

  let remaining = amountKelvin;

  for (let index = 4; index < 12; index++) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }

  return encodeBase58(bytes);
}

type FixtureOptions = {
  signature?: string;
  error?: unknown;
  includeErrorField?: boolean;
  recipient?: string;
  amount?: bigint;
  data?: string;
  blockHeight?: number;
  includeMeta?: boolean;
  secondTransfer?: boolean;
  includeTopLevelTransfer?: boolean;
  accountIndices?: number[] | Uint8Array;
  accountField?: "accounts" | "accountKeyIndexes";
  invalidProgramIndex?: boolean;
  innerInstructions?: unknown[];
  innerField?: "innerInstructions" | "inner_instructions";
};

function makeRpcResult(options: FixtureOptions = {}) {
  const transferData =
    options.data ??
    makeTransferData(options.amount ?? 1_000_000n);

  const keys = [
    PAYER,
    options.recipient ?? RECIPIENT,
    SYSTEM_PROGRAM,
  ];

  const instruction = {
    programIdIndex: options.invalidProgramIndex ? 99 : 2,
    [options.accountField ?? "accounts"]:
      options.accountIndices ?? [0, 1],
    data: transferData,
  };

  const instructions =
    options.includeTopLevelTransfer === false
      ? []
      : [instruction];

  if (options.secondTransfer) {
    instructions.push({
      ...instruction,
      data: makeTransferData(1_000_000n),
    });
  }

  const meta: Record<string, unknown> = {
    fee: "5000",
  };

  if (options.includeErrorField !== false) {
    meta.err = options.error ?? null;
  }

  if (options.innerInstructions !== undefined) {
    meta[options.innerField ?? "innerInstructions"] =
      options.innerInstructions;
  }

  return {
    block_height: options.blockHeight ?? 12345,
    block_time: 1794441600,
    ...(options.includeMeta === false ? {} : { meta }),
    transaction: {
      signatures: [
        options.signature ?? SIGNATURE,
      ],
      message: {
        accountKeys: keys,
        instructions,
      },
    },
  };
}

async function invokeVerifier(
  result: ReturnType<typeof makeRpcResult>,
  signature = SIGNATURE,
) {
  const originalFetch = globalThis.fetch;
  let requestVerified = false;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    assert.equal(String(input), "/rialo-rpc");

    const request = JSON.parse(
      String(init?.body),
    );

    assert.equal(request.method, "getTransaction");

    assert.deepEqual(request.params, [
      {
        version: 0,
        signature,
      },
    ]);

    requestVerified = true;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 7,
        result,
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const verified = await verifyTriggeredTransaction(
      signature,
      EXPECTED,
    );

    assert.equal(requestVerified, true);

    return verified;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runTests() {
  let passed = 0;

  async function test(
    name: string,
    callback: () => Promise<void>,
  ) {
    await callback();
    passed++;
    console.log(`PASS: ${name}`);
  }

  console.log("\n===== TRIGGERED TRANSACTION TESTS =====\n");

  await test(
    "Successful transfer is verified when meta.err is omitted",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          includeErrorField: false,
        }),
      );

      assert.equal(result.status, "success");
      assert.equal(result.signature, SIGNATURE);
      assert.equal(result.blockNumber, "12345");
      assert.equal(result.blockTime, "1794441600");
    },
  );

  await test(
    "Successful transfer is verified when meta.err is null",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult(),
      );

      assert.equal(result.status, "success");
    },
  );

  await test(
    "On-chain execution error is reported as failed",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          error: "InstructionError",
        }),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.error, "InstructionError");
    },
  );

  await test(
    "Wrong transaction signature is rejected",
    async () => {
      await assert.rejects(
        () => invokeVerifier(
          makeRpcResult({
            signature: "6".repeat(64),
          }),
        ),
        /signature does not match/,
      );
    },
  );

  await test(
    "Missing execution metadata is rejected",
    async () => {
      await assert.rejects(
        () => invokeVerifier(
          makeRpcResult({
            includeMeta: false,
          }),
        ),
        /missing its execution metadata/,
      );
    },
  );

  await test(
    "Wrong recipient is rejected",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          recipient: PAYER,
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /No valid System Program transfer/);
    },
  );

  await test(
    "Incorrect transfer amount is rejected",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          amount: 2_000_000n,
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /amount mismatch/i);
    },
  );

  await test(
    "Multiple matching transfers are rejected",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          secondTransfer: true,
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /Multiple matching transfers/);
    },
  );

  await test(
    "Malformed base58 transfer data is rejected",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          data: "!!!!",
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /malformed data/i);
    },
  );

  await test(
    "Invalid program index does not produce a false payment",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          invalidProgramIndex: true,
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /No valid System Program transfer/);
    },
  );

  await test(
    "SDK InnerInstruction wrapper containing a CPI transfer is verified",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          includeTopLevelTransfer: false,
          innerInstructions: [{
            instructionIndex: 0,
            instruction: {
              programIdIndex: 2,
              accounts: [0, 1],
              data: makeTransferData(1_000_000n),
            },
          }],
        }),
      );

      assert.equal(result.status, "success");
    },
  );

  await test(
    "Snake-case grouped inner instructions are verified",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          includeTopLevelTransfer: false,
          innerField: "inner_instructions",
          innerInstructions: [{
            index: 0,
            instructions: [{
              program_id_index: 2,
              accounts: new Uint8Array([0, 1]),
              data: makeTransferData(1_000_000n),
            }],
          }],
        }),
      );

      assert.equal(result.status, "success");
    },
  );

  await test(
    "Incorrect amount in a CPI transfer is rejected",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          includeTopLevelTransfer: false,
          innerInstructions: [{
            instructionIndex: 0,
            instruction: {
              programIdIndex: 2,
              accounts: [0, 1],
              data: makeTransferData(2_000_000n),
            },
          }],
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /amount mismatch/i);
    },
  );

  await test(
    "Duplicate top-level and CPI transfers are rejected as ambiguous",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          innerInstructions: [{
            instructionIndex: 0,
            instruction: {
              programIdIndex: 2,
              accounts: [0, 1],
              data: makeTransferData(1_000_000n),
            },
          }],
        }),
      );

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /Multiple matching transfers/);
    },
  );

  await test(
    "Uint8Array account indices are supported",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          accountIndices: new Uint8Array([0, 1]),
        }),
      );

      assert.equal(result.status, "success");
    },
  );

  await test(
    "SDK accountKeyIndexes field is supported",
    async () => {
      const result = await invokeVerifier(
        makeRpcResult({
          accountField: "accountKeyIndexes",
          accountIndices: [0, 1],
        }),
      );

      assert.equal(result.status, "success");
    },
  );

  console.log("\n==========================================");
  console.log(`RESULT: ${passed} transaction tests passed.`);
  console.log("==========================================\n");
}

runTests().catch((error: unknown) => {
  console.error("\nTRANSACTION TEST FAILURE:");
  console.error(error);
  process.exitCode = 1;
});

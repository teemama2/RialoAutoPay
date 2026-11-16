
import assert from "node:assert/strict";

import {
  fetchSubscriptionActivity,
  postRpc,
} from "../src/lib/subscriptionMonitor.ts";

import { formatBlockTime } from "../src/lib/formatBlockTime.ts";

const SUBSCRIBER =
  "CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko";

const RECIPIENT =
  "3f6L7jBBdPEKJf7v1rb9fNLhYetSw85Cwv79srGnsWrZ";

// Block-time display regression tests.
const FIXED_BLOCK_TIME_MS = Date.UTC(2026, 10, 15, 11, 0, 0);

assert.equal(
  formatBlockTime(BigInt(FIXED_BLOCK_TIME_MS)),
  formatBlockTime(BigInt(FIXED_BLOCK_TIME_MS / 1000)),
  "Seconds and milliseconds must format to the same UTC instant.",
);

assert.match(
  formatBlockTime(BigInt(FIXED_BLOCK_TIME_MS)),
  /15 Nov 2026/,
  "Millisecond timestamps must not display a year thousands of years ahead.",
);

assert.equal(
  formatBlockTime(null),
  "Not supplied by Rialo RPC",
);

console.log("PASS: Millisecond block times display the correct UTC date.");
console.log("PASS: Seconds and milliseconds produce the same display.");
console.log("PASS: Missing block times remain clearly identified.");

const HISTORY = [
  {
    signature: "history-success",
    blockHeight: 100,
    blockTime: 1794441600,
    err: null,
  },
  {
    signature: "history-failed",
    block_height: 101,
    block_time: 1794441601,
    err: { InstructionError: "Test failure" },
  },
  {
    signature: "history-unknown",
    blockHeight: 102,
    blockTime: null,
  },
];

async function runTests() {
  const originalFetch = globalThis.fetch;
  const requestedMethods: string[] = [];

  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = JSON.parse(
      String(init?.body),
    );

    requestedMethods.push(request.method);

    let result: unknown;

    switch (request.method) {
      case "getSubscription":
        result = { subscription: null };
        break;

      case "getSignaturesForAddress":
        result = { value: HISTORY };
        break;

      case "getTriggeredTransactions":
        result = { transactions: [] };
        break;

      default:
        throw new Error(
          `Unexpected RPC method: ${request.method}`,
        );
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: request.id,
        result,
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const activity = await fetchSubscriptionActivity(
      SUBSCRIBER,
      "history-001",
      RECIPIENT,
    );

    const sender = activity.senderAddressHistory;

    assert.equal(sender.length, 3);

    assert.equal(
      sender[0].executionStatus,
      "success",
      "Explicit err:null should mean successful execution.",
    );

    assert.equal(
      sender[1].executionStatus,
      "failed",
      "A non-null execution error should mean failure.",
    );

    assert.deepEqual(
      sender[1].err,
      { InstructionError: "Test failure" },
    );

    assert.equal(
      sender[2].executionStatus,
      "unknown",
      "A missing err field must not be treated as success.",
    );

    assert.equal(
      sender[2].blockTime,
      null,
      "A missing block time should not discard a transaction.",
    );

    assert.equal(
      activity.recipientAddressHistory.length,
      3,
    );

    assert.ok(
      activity.subscriptionLookupError,
      "Missing active subscription should be reported separately.",
    );

    assert.ok(
      requestedMethods.includes("getTriggeredTransactions"),
      "Triggered history should still be queried.",
    );

    console.log(
      "PASS: Explicit null execution result is classified as success.",
    );

    console.log(
      "PASS: Non-null execution error is classified as failed.",
    );

    console.log(
      "PASS: Missing execution result is classified as unknown.",
    );

    console.log(
      "PASS: Missing block time does not discard transaction history.",
    );

    console.log(
      "PASS: History remains available when active subscription is missing.",
    );

        // Test 6: RPC timeout is reported clearly.
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;

        const rejectAbort = () => {
          reject(
            new DOMException(
              "The request was aborted.",
              "AbortError",
            ),
          );
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener(
          "abort",
          rejectAbort,
          { once: true },
        );
      })) as typeof fetch;

    await assert.rejects(
      () => postRpc(99, "getHealth", [], 10),
      /Rialo RPC request timed out/,
    );

    console.log(
      "PASS: RPC timeout is reported clearly.",
    );

    // Test 7: HTTP errors are reported with their status.
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({
          jsonrpc: "2.0",
          id: 100,
          result: null,
        }),
      }) as Response) as typeof fetch;

    await assert.rejects(
      () => postRpc(100, "getHealth", []),
      /HTTP 503/,
    );

    console.log(
      "PASS: HTTP errors include their response status.",
    );

        console.log(
      "\nRESULT: 7 transaction-history and RPC resilience tests passed.",
    );

  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch((error: unknown) => {
  console.error("\nTRANSACTION HISTORY TEST FAILURE:");
  console.error(error);
  process.exitCode = 1;
});

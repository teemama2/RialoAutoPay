
import assert from "node:assert/strict";

import {
  fetchSubscriptionActivity,
} from "../src/lib/subscriptionMonitor.ts";

const SUBSCRIBER =
  "CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko";

const RECIPIENT =
  "3f6L7jBBdPEKJf7v1rb9fNLhYetSw85Cwv79srGnsWrZ";

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

    console.log("\nRESULT: 5 transaction-history tests passed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch((error: unknown) => {
  console.error("\nTRANSACTION HISTORY TEST FAILURE:");
  console.error(error);
  process.exitCode = 1;
});

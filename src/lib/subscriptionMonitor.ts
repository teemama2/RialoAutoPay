import { PublicKey } from "@rialo/ts-cdk";
import { deriveSubscriptionAddress } from "./subscriptionBuilder";

type JsonRecord = Record<string, unknown>;

export type SignatureInfo = {
  signature: string;
  blockHeight: bigint;
  blockTime: bigint;
  err: unknown;
};

export type TriggeredTransaction = {
  signature: string;
  blockNumber: bigint;
};

function asRecord(value: unknown): JsonRecord {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as JsonRecord;
  }

  return {};
}

function rpcErrorMessage(
  payload: JsonRecord,
): string | null {
  if (!payload.error) {
    return null;
  }

  const rpcError = asRecord(payload.error);

  return String(
    rpcError.message ?? "Rialo RPC request failed.",
  );
}

async function postRpc(
  id: number,
  method: string,
  params: unknown[],
): Promise<JsonRecord> {
  const response = await fetch("/rialo-rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  let payload: JsonRecord;

  try {
    payload = asRecord(await response.json());
  } catch {
    throw new Error(
      "The Rialo RPC response was not valid JSON.",
    );
  }

  const rpcError = rpcErrorMessage(payload);

  if (rpcError) {
    throw new Error(rpcError);
  }

  if (!response.ok) {
    throw new Error(
      `Rialo RPC request failed with HTTP ${response.status}.`,
    );
  }

  return payload;
}

function normalizeTimestampRange(
  value: unknown,
): [string, string] | null {
  if (Array.isArray(value) && value.length === 2) {
    return [
      String(value[0]),
      String(value[1]),
    ];
  }

  const range = asRecord(value);

  const start = range.start ?? range.from;
  const end = range.end ?? range.to;

  if (start !== undefined && end !== undefined) {
    return [String(start), String(end)];
  }

  return null;
}

function extractRecipient(
  subscription: JsonRecord | null,
): string | null {
  if (
    !subscription ||
    !Array.isArray(subscription.instructions)
  ) {
    return null;
  }

  const transferInstruction = subscription.instructions
    .map(asRecord)
    .find((instruction) => {
      const programId =
        instruction.program_id ??
        instruction.programId;

      return (
        programId ===
        "11111111111111111111111111111111"
      );
    });

  if (
    !transferInstruction ||
    !Array.isArray(transferInstruction.accounts)
  ) {
    return null;
  }

  const recipientMeta = asRecord(
    transferInstruction.accounts[1],
  );

  const recipient = recipientMeta.pubkey;

  return typeof recipient === "string"
    ? recipient
    : null;
}

async function readAddressHistory(
  address: string,
  requestId: number,
): Promise<{
  entries: SignatureInfo[];
  error: string | null;
}> {
  try {
    const publicKey = PublicKey.fromString(address);

    const payload = await postRpc(
      requestId,
      "getSignaturesForAddress",
      [
        {
          address: publicKey.toString(),
          config: {},
        },
      ],
    );

    const result = asRecord(payload.result);

    const values: unknown = result.value;

    if (!Array.isArray(values)) {
      throw new Error(
        "Rialo returned an unexpected transaction-history response.",
      );
    }

    const entries: SignatureInfo[] = values.map(
      (item: unknown) => {
        const row = asRecord(item);

        if (typeof row.signature !== "string") {
          throw new Error(
            "A transaction-history entry has no signature.",
          );
        }

        const height =
          row.blockHeight ?? row.block_height;

        const time =
          row.blockTime ?? row.block_time;

        if (height == null || time == null) {
          throw new Error(
            "A transaction-history entry is missing its block height or time.",
          );
        }

        return {
          signature: row.signature,
          blockHeight: BigInt(String(height)),
          blockTime: BigInt(String(time)),
          err: row.err ?? null,
        };
      },
    );

    return {
      entries,
      error: null,
    };
  } catch (cause) {
    return {
      entries: [],
      error:
        cause instanceof Error
          ? cause.message
          : "Unable to retrieve this account's transaction history.",
    };
  }
}

async function readTriggeredHistory(
  subscriptionAddress: string,
): Promise<{
  entries: TriggeredTransaction[];
  error: string | null;
}> {
  try {
    const address = PublicKey.fromString(
      subscriptionAddress,
    );

    const payload = await postRpc(
      3,
      "getTriggeredTransactions",
      [address.toString(), "50"],
    );

    const result = asRecord(payload.result);

    const transactions: unknown = result.transactions;

    if (!Array.isArray(transactions)) {
      throw new Error(
        "Rialo returned an unexpected triggered-transaction response.",
      );
    }

    const entries: TriggeredTransaction[] =
      transactions.map((item: unknown) => {
        const row = asRecord(item);

        if (typeof row.signature !== "string") {
          throw new Error(
            "A triggered transaction is missing its signature.",
          );
        }

        // Rialo returns blockNumber in camelCase.
        // Accept block_number as a fallback for compatibility.
        const blockNumber =
          row.blockNumber ?? row.block_number;

        if (blockNumber == null) {
          throw new Error(
            "A triggered transaction is missing its block number.",
          );
        }

        return {
          signature: row.signature,
          blockNumber: BigInt(String(blockNumber)),
        };
      });

    return {
      entries,
      error: null,
    };
  } catch (cause) {
    return {
      entries: [],
      error:
        cause instanceof Error
          ? cause.message
          : "Unable to retrieve triggered-transaction history.",
    };
  }
}

/**
 * Retrieves a subscription, if it still exists, plus transaction
 * history for the subscriber, recipient, and subscription account.
 *
 * A one-shot subscription may be removed after execution. Its triggered
 * transaction history is queried independently of the active record.
 */
export async function fetchSubscriptionActivity(
  subscriberAddress: string,
  nonce: string,
  recipientAddressOverride = "",
) {
  if (!subscriberAddress.trim()) {
    throw new Error(
      "A subscriber wallet address is required.",
    );
  }

  if (!nonce.trim()) {
    throw new Error(
      "A subscription nonce is required.",
    );
  }

  const subscriber = PublicKey.fromString(
    subscriberAddress,
  );

  const normalizedNonce = nonce.trim();

  const subscriptionAddress =
    await deriveSubscriptionAddress(
      subscriberAddress,
      normalizedNonce,
    );

  let subscription: JsonRecord | null = null;
  let subscriptionLookupError: string | null = null;

  // Read the active subscription independently of transaction history.
  try {
    const payload = await postRpc(
      1,
      "getSubscription",
      [
        {
          subscriber: subscriber.toString(),
          nonce: normalizedNonce,
        },
      ],
    );

    const result = asRecord(payload.result);

    const rawSubscription = asRecord(
      result.subscription,
    );

    if (Object.keys(rawSubscription).length === 0) {
      throw new Error(
        "The RPC response did not contain an active subscription record.",
      );
    }

    const eventAccount =
      rawSubscription.event_account ??
      rawSubscription.eventAccount ??
      null;

    const rawTimestampRange =
      rawSubscription.timestamp_range ??
      rawSubscription.timestampRange;

    subscription = {
      ...rawSubscription,
      eventAccount:
        eventAccount == null
          ? null
          : String(eventAccount),
      timestampRange:
        normalizeTimestampRange(rawTimestampRange),
    };
  } catch (cause) {
    subscriptionLookupError =
      cause instanceof Error
        ? cause.message
        : "Unable to retrieve the subscription record.";
  }

  // Use the entered recipient address if supplied. Otherwise, try to
  // discover it from the active subscription instructions.
  let recipientAddress: string | null = null;

  try {
    if (recipientAddressOverride.trim()) {
      recipientAddress = PublicKey.fromString(
        recipientAddressOverride.trim(),
      ).toString();
    } else {
      const discoveredRecipient =
        extractRecipient(subscription);

      if (discoveredRecipient) {
        recipientAddress = PublicKey.fromString(
          discoveredRecipient,
        ).toString();
      }
    }
  } catch (cause) {
    throw new Error(
      cause instanceof Error
        ? `Invalid recipient address: ${cause.message}`
        : "The recipient address is invalid.",
    );
  }

  const [
    senderHistory,
    recipientHistory,
    triggerHistory,
  ] = await Promise.all([
    readAddressHistory(
      subscriber.toString(),
      2,
    ),

    recipientAddress
      ? readAddressHistory(
          recipientAddress,
          5,
        )
      : Promise.resolve({
          entries: [] as SignatureInfo[],
          error:
            "Recipient address unavailable. Enter the recipient address to query its history.",
        }),

    readTriggeredHistory(subscriptionAddress),
  ]);

  return {
    subscriptionAddress,
    subscription,
    subscriptionLookupError,

    triggeredTransactions: triggerHistory.entries,
    triggeredTransactionsError: triggerHistory.error,
    transactionCount: triggerHistory.entries.length,

    recipientAddress,

    senderAddressHistory: senderHistory.entries,
    senderHistoryError: senderHistory.error,

    recipientAddressHistory: recipientHistory.entries,
    recipientHistoryError: recipientHistory.error,
  };
}

/**
 * Fetches triggered transactions even if the subscription record
 * has already been removed following one-shot execution.
 */
export async function fetchTriggeredTransactionsForSubscriptionAddress(
  subscriptionAddress: string,
): Promise<TriggeredTransaction[]> {
  const result = await readTriggeredHistory(
    subscriptionAddress,
  );

  if (result.error) {
    throw new Error(result.error);
  }

  return result.entries;
}

function decodeBase58ToBytes(value: string): Uint8Array {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  if (!value) {
    throw new Error("Transaction instruction data is empty.");
  }

  const littleEndian: number[] = [];

  for (const character of value) {
    const digit = alphabet.indexOf(character);

    if (digit < 0) {
      throw new Error("Invalid base58 transaction instruction data.");
    }

    let carry = digit;

    for (let i = 0; i < littleEndian.length; i++) {
      carry += littleEndian[i] * 58;
      littleEndian[i] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }

    while (carry > 0) {
      littleEndian.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }

  let leadingZeros = 0;

  while (
    leadingZeros < value.length &&
    value[leadingZeros] === "1"
  ) {
    leadingZeros++;
  }

  return Uint8Array.from([
    ...new Array(leadingZeros).fill(0),
    ...littleEndian.reverse(),
  ]);
}

/**
 * Converts an RLO decimal amount into kelvin without
 * using floating-point arithmetic.
 *
 * 1 RLO = 1,000,000,000 kelvin.
 */
function rloToKelvin(amountRlo: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(
    amountRlo.trim(),
  );

  if (!match) {
    throw new Error(
      `Invalid RLO amount: ${amountRlo}. Maximum precision is 9 decimal places.`,
    );
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt(
    (match[2] ?? "").padEnd(9, "0") || "0",
  );

  const amount =
    whole * BigInt("1000000000") + fraction;

  if (amount <= BigInt(0)) {
    throw new Error("The expected payment amount must be greater than zero.");
  }

  return amount;
}

/**
 * Decodes a native System Program transfer instruction.
 *
 * Layout:
 * 4 bytes: instruction discriminator (2 = Transfer)
 * 8 bytes: transfer amount in little-endian u64.
 */
function decodeSystemTransferKelvin(
  encodedData: string,
): bigint | null {
  const bytes = decodeBase58ToBytes(encodedData);

  if (bytes.length < 4) {
    return null;
  }

  const discriminator =
    bytes[0] +
    bytes[1] * 256 +
    bytes[2] * 65536 +
    bytes[3] * 16777216;

  // System Program instruction 2 = Transfer.
  if (discriminator !== 2) {
    return null;
  }

  if (bytes.length !== 12) {
    throw new Error(
      "The System Program transfer instruction has an invalid data length.",
    );
  }

  let amount = BigInt(0);
  let multiplier = BigInt(1);

  // Decode the u64 amount in little-endian order.
  for (let i = 4; i < 12; i++) {
    amount += BigInt(bytes[i]) * multiplier;
    multiplier *= BigInt(256);
  }

  return amount;
}

export interface VerifiedTriggeredTransaction {
  signature: string;
  blockNumber: string;
  blockTime?: string;
  status: "success" | "failed";
  error?: string;
}

/**
 * Verifies:
 * 1. The transaction exists and matches the requested signature.
 * 2. The transaction executed successfully.
 * 3. The sender and recipient are correct.
 * 4. The instruction is a native System Program transfer.
 * 5. The actual on-chain amount equals the expected RLO amount.
 */
export async function verifyTriggeredTransaction(
  signature: string,
  expected: {
    payerAddress: string;
    recipientAddress: string;
    expectedAmountRlo: string;
  },
): Promise<VerifiedTriggeredTransaction> {
  const payer = PublicKey.fromString(
    expected.payerAddress,
  ).toString();

  const recipient = PublicKey.fromString(
    expected.recipientAddress,
  ).toString();

  const expectedKelvin = rloToKelvin(
    expected.expectedAmountRlo,
  );

  // Rialo expects a GetTransactionRequest object,
  // not a standalone signature string.
  const payload = await postRpc(
    7,
    "getTransaction",
    [
      {
        version: 0,
        signature,
      },
    ],
  );

  const result = asRecord(payload.result);

  if (Object.keys(result).length === 0) {
    throw new Error(
      "Rialo did not return the full transaction record.",
    );
  }

  if (
    result.meta == null ||
    typeof result.meta !== "object" ||
    Array.isArray(result.meta)
  ) {
    throw new Error(
      "The transaction response is missing its execution metadata.",
    );
  }

  const transaction = asRecord(result.transaction);
  const meta = asRecord(result.meta);

  // Rialo's SDK type makes meta.err optional: successful transactions
  // may omit the field entirely. A present non-null error means failure.

  const blockHeight =
    result.block_height ?? result.blockHeight;

  if (blockHeight == null) {
    throw new Error(
      "The transaction response is missing its block height.",
    );
  }

  const blockTime =
    result.block_time ?? result.blockTime;

  const blockNumber = String(blockHeight);

  const normalizedBlockTime =
    blockTime == null ? undefined : String(blockTime);

  const failed = (
    error: string,
  ): VerifiedTriggeredTransaction => ({
    signature,
    blockNumber,
    blockTime: normalizedBlockTime,
    status: "failed",
    error,
  });

  // Confirm that the returned transaction is the one requested.
  const signatures = transaction.signatures;

  if (
    !Array.isArray(signatures) ||
    !signatures.includes(signature)
  ) {
    throw new Error(
      "The returned transaction signature does not match the requested signature.",
    );
  }

  // A transaction rejected by the chain is a failed payment.
  if (meta.err !== null && meta.err !== undefined) {
    return failed(
      typeof meta.err === "string"
        ? meta.err
        : JSON.stringify(meta.err),
    );
  }

  const message = asRecord(transaction.message);

  const rawKeys =
    message.accountKeys ?? message.account_keys;

  const rawInstructions = message.instructions;

  if (
    !Array.isArray(rawKeys) ||
    !Array.isArray(rawInstructions)
  ) {
    throw new Error(
      "The transaction response is missing its account keys or instructions.",
    );
  }

  // Include cross-program invocation instructions. Rialo's SDK type
  // describes each entry as { instructionIndex, instruction }, while
  // some RPC responses use grouped { index, instructions } records.
  const rawInnerInstructions =
    meta.innerInstructions ?? meta.inner_instructions ?? [];

  if (!Array.isArray(rawInnerInstructions)) {
    throw new Error(
      "The transaction response contains an invalid inner-instruction list.",
    );
  }

  const allInstructions: unknown[] = [...rawInstructions];

  for (const entry of rawInnerInstructions) {
    const wrapper = asRecord(entry);

    if (wrapper.instruction != null) {
      allInstructions.push(wrapper.instruction);
      continue;
    }

    if (Array.isArray(wrapper.instructions)) {
      allInstructions.push(...wrapper.instructions);
      continue;
    }

    // Also accept a direct compiled inner instruction.
    allInstructions.push(entry);
  }

  const accountKeys = rawKeys.map((key: unknown) => {
    if (typeof key === "string") {
      return key;
    }

    const keyRecord = asRecord(key);

    return String(
      keyRecord.pubkey ?? keyRecord.address ?? "",
    );
  });

  const systemProgram =
    "11111111111111111111111111111111";

  const matchingTransferAmounts: bigint[] = [];
  let malformedTransferFound = false;

  for (const item of allInstructions) {
    const instruction = asRecord(item);

    const programIdIndex = Number(
      instruction.programIdIndex ??
        instruction.program_id_index,
    );

    if (
      !Number.isInteger(programIdIndex) ||
      programIdIndex < 0 ||
      programIdIndex >= accountKeys.length
    ) {
      continue;
    }

    if (accountKeys[programIdIndex] !== systemProgram) {
      continue;
    }

    const rawAccountIndices =
      instruction.accounts ??
      instruction.accountKeyIndexes ??
      instruction.account_key_indexes;

    const accountIndices =
      rawAccountIndices instanceof Uint8Array
        ? Array.from(rawAccountIndices)
        : rawAccountIndices;

    if (
      !Array.isArray(accountIndices) ||
      accountIndices.length < 2
    ) {
      continue;
    }

    const sourceIndex = Number(accountIndices[0]);
    const destinationIndex = Number(accountIndices[1]);

    if (
      !Number.isInteger(sourceIndex) ||
      !Number.isInteger(destinationIndex) ||
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      sourceIndex >= accountKeys.length ||
      destinationIndex >= accountKeys.length
    ) {
      continue;
    }

    // Only inspect transfers involving the expected accounts.
    if (
      accountKeys[sourceIndex] !== payer ||
      accountKeys[destinationIndex] !== recipient
    ) {
      continue;
    }

    if (typeof instruction.data !== "string") {
      malformedTransferFound = true;
      continue;
    }

    try {
      const amount = decodeSystemTransferKelvin(
        instruction.data,
      );

      if (amount !== null) {
        matchingTransferAmounts.push(amount);
      }
    } catch {
      malformedTransferFound = true;
    }
  }

  if (malformedTransferFound) {
    return failed(
      "The matching transfer instruction contains invalid or malformed data.",
    );
  }

  if (matchingTransferAmounts.length === 0) {
    return failed(
      "No valid System Program transfer was found between the expected payer and recipient.",
    );
  }

  if (matchingTransferAmounts.length !== 1) {
    return failed(
      "Multiple matching transfers were found. The payment cannot be verified unambiguously.",
    );
  }

  const actualKelvin = matchingTransferAmounts[0];

  if (actualKelvin !== expectedKelvin) {
    return failed(
      `Transfer amount mismatch. Expected ${expectedKelvin.toString()} kelvin (${expected.expectedAmountRlo} RLO), but the blockchain transaction transferred ${actualKelvin.toString()} kelvin.`,
    );
  }

  return {
    signature,
    blockNumber,
    blockTime: normalizedBlockTime,
    status: "success",
  };
}
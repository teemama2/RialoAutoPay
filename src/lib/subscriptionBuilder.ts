import {
  PublicKey,
  Schema,
  serialize,
  type Instruction,
} from "@rialo/ts-cdk";

export const SUBSCRIBER_PROGRAM_ID =
  "Subscriber111111111111111111111111111111111";

export const RIALO_SUBSCRIBE_SEED = "rialo_subscribe";

const SYSTEM_PROGRAM =
  "11111111111111111111111111111111";

const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Rialo 0.18.1 defines this as:
 * PACKET_DATA_SIZE / size_of::<Pubkey>()
 *
 * PACKET_DATA_SIZE = 4048
 * Pubkey size = 32 bytes
 * 4048 / 32 = 126
 *
 * Note: The Rust source comment says 38, but its actual
 * constant expression evaluates to 126.
 */
export const MAX_STATIC_ACCOUNTS_PER_PACKET = 126;

type NativePredicate = {
  topic: string;
  eventAccount?: string | null;
  timestampRange?: readonly [bigint, bigint] | null;
};

type NativeSubscriptionInput = {
  subscriberAddress: string;
  nonceText: string;
  predicate: NativePredicate;
  instructions: Instruction[];
  kind: "Persistent" | "OneShot";
  activeCommits?: readonly [bigint, bigint];
};

const accountMetaSchema = Schema.struct([
  ["pubkey", Schema.pubkey()],
  ["is_signer", Schema.bool()],
  ["is_writable", Schema.bool()],
]);

const instructionSchema = Schema.struct([
  ["program_id", Schema.pubkey()],
  ["accounts", Schema.vec(accountMetaSchema)],
  ["data", Schema.bytes()],
]);

const predicateSchema = Schema.struct([
  ["topic", Schema.string()],
  ["event_account", Schema.option(Schema.pubkey())],
  [
    "timestamp_range",
    Schema.option(Schema.tuple(Schema.u64(), Schema.u64())),
  ],
]);

const subscriptionSchema = Schema.struct([
  ["subscriber", Schema.pubkey()],
  ["predicate", predicateSchema],
  ["instructions", Schema.vec(instructionSchema)],
  [
    "kind",
    Schema.enum([
      ["Persistent", null],
      ["OneShot", null],
    ]),
  ],
  ["active_commits", Schema.tuple(Schema.u64(), Schema.u64())],
]);

const subscribePayloadSchema = Schema.struct([
  ["nonce", Schema.fixedArray(32)],
  ["handler", subscriptionSchema],
]);

const subscriberInstructionSchema = Schema.enum([
  [
    "Subscribe",
    subscribePayloadSchema,
  ],
  [
    "Unsubscribe",
    Schema.struct([
      ["nonce", Schema.fixedArray(32)],
    ]),
  ],
  [
    "Update",
    subscribePayloadSchema,
  ],
  [
    "Destroy",
    Schema.struct([
      ["nonce", Schema.fixedArray(32)],
    ]),
  ],
]);

/**
 * Encodes an application nonce using Rialo's short-nonce
 * convention: UTF-8 bytes followed by zero padding.
 *
 * This application deliberately restricts nonce strings
 * to 1-32 UTF-8 bytes instead of implementing Blake3
 * hashing for longer strings.
 */
function encodeNonce(nonceText: string): Uint8Array {
  const bytes = new TextEncoder().encode(nonceText);

  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(
      "Nonce must contain 1-32 UTF-8 bytes.",
    );
  }

  const nonce = new Uint8Array(32);
  nonce.set(bytes);

  return nonce;
}

/**
 * Builds the exact native Destroy instruction used by a OneShot
 * subscription. Shared with verification to check its encoded nonce.
 */
export function buildNativeDestroyInstruction(
  subscriberAddress: string,
  subscriptionAddress: string,
  nonceText: string,
): Instruction {
  const subscriber = PublicKey.fromString(subscriberAddress);
  const subscription = PublicKey.fromString(subscriptionAddress);
  const programId = PublicKey.fromString(SUBSCRIBER_PROGRAM_ID);
  const nonce = encodeNonce(nonceText);

  const data = serialize(subscriberInstructionSchema, {
    variant: "Destroy",
    value: {
      nonce: Array.from(nonce),
    },
  });

  return {
    programId,
    accounts: [
      {
        pubkey: subscriber,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: subscription,
        isSigner: false,
        isWritable: true,
      },
    ],
    data,
  };
}

/**
 * Enforces Rialo's native Subscription::sanitize_instructions
 * unique program/account key limit.
 *
 * Each instruction contributes:
 * - Its program ID
 * - Every account public key
 *
 * Duplicate keys are counted only once.
 */
function validateStaticAccountLimit(
  instructions: Instruction[],
): void {
  const allPublicKeys = new Set<string>();

  for (const instruction of instructions) {
    allPublicKeys.add(instruction.programId.toString());

    for (const account of instruction.accounts) {
      allPublicKeys.add(account.pubkey.toString());
    }
  }

  if (allPublicKeys.size > MAX_STATIC_ACCOUNTS_PER_PACKET) {
    throw new Error(
      `Subscription instructions reference ${allPublicKeys.size} unique program/account keys. ` +
      `Rialo 0.18.1 permits at most ${MAX_STATIC_ACCOUNTS_PER_PACKET}.`,
    );
  }
}

export async function deriveSubscriptionAddress(
  subscriberAddress: string,
  nonceText: string,
): Promise<string> {
  const subscriber = PublicKey.fromString(subscriberAddress);
  const programId = PublicKey.fromString(SUBSCRIBER_PROGRAM_ID);
  const nonce = encodeNonce(nonceText);

  const [address] = PublicKey.findProgramAddress(
    [
      new TextEncoder().encode(RIALO_SUBSCRIBE_SEED),
      subscriber.toBytes(),
      nonce,
    ],
    programId,
  );

  return address.toString();
}

/**
 * Constructs a native Subscribe instruction.
 * Supports Persistent and OneShot subscriptions.
 *
 * This function does not sign or submit a transaction.
 */
export async function buildNativeSubscribeInstruction(
  input: NativeSubscriptionInput,
): Promise<{
  instruction: Instruction;
  subscriptionAddress: string;
}> {
  if (input.instructions.length === 0) {
    throw new Error(
      "A subscription must contain at least one instruction.",
    );
  }

  const subscriber = PublicKey.fromString(
    input.subscriberAddress,
  );

  const nonce = encodeNonce(input.nonceText);

  const programId = PublicKey.fromString(
    SUBSCRIBER_PROGRAM_ID,
  );

  // Required by Rialo's native Subscribe instruction.
  const systemProgram = PublicKey.fromString(
    SYSTEM_PROGRAM,
  );

  // Derive the subscription PDA from the official seeds.
  const [subscriptionAddress] = PublicKey.findProgramAddress(
    [
      new TextEncoder().encode(RIALO_SUBSCRIBE_SEED),
      subscriber.toBytes(),
      nonce,
    ],
    programId,
  );

  // Native subscriptions cannot require signatures from
  // additional accounts other than the subscriber.
  for (const inner of input.instructions) {
    for (const account of inner.accounts) {
      if (
        account.isSigner &&
        account.pubkey.toString() !== subscriber.toString()
      ) {
        throw new Error(
          "Subscription instructions cannot require another signer.",
        );
      }
    }
  }

  const eventAccount = input.predicate.eventAccount
    ? PublicKey.fromString(
        input.predicate.eventAccount,
      ).toBytes()
    : null;

  const timestampRange =
    input.predicate.timestampRange ?? null;

  if (
    timestampRange &&
    (
      timestampRange[0] < 0n ||
      timestampRange[1] < timestampRange[0] ||
      timestampRange[1] > U64_MAX
    )
  ) {
    throw new Error(
      "Invalid predicate timestamp range.",
    );
  }

  const [activeStart, activeEnd] =
    input.activeCommits ?? [0n, U64_MAX];

  if (
    activeStart < 0n ||
    activeEnd < activeStart ||
    activeEnd > U64_MAX
  ) {
    throw new Error(
      "Invalid active commit range.",
    );
  }

  // Start with the instructions that should execute
  // when the subscription predicate matches.
  const instructionsToExecute = [
    ...input.instructions,
  ];

  // Rialo's native helper appends a Destroy instruction
  // to a OneShot subscription so its account can be
  // cleaned up after execution.
  if (input.kind === "OneShot") {
    instructionsToExecute.push(
      buildNativeDestroyInstruction(
        subscriber.toString(),
        subscriptionAddress.toString(),
        input.nonceText,
      ),
    );
  }

  // Validate the complete instruction list, including
  // the automatic Destroy instruction for OneShot.
  validateStaticAccountLimit(instructionsToExecute);

  const handler = {
    subscriber: subscriber.toBytes(),

    predicate: {
      topic: input.predicate.topic,
      event_account: eventAccount,
      timestamp_range: timestampRange,
    },

    instructions: instructionsToExecute.map((inner) => ({
      program_id: inner.programId.toBytes(),

      accounts: inner.accounts.map((account) => ({
        pubkey: account.pubkey.toBytes(),
        is_signer: account.isSigner,
        is_writable: account.isWritable,
      })),

      data: inner.data,
    })),

    kind: {
      variant: input.kind,
    },

    active_commits: [
      activeStart,
      activeEnd,
    ],
  };

  const data = serialize(
    subscriberInstructionSchema,
    {
      variant: "Subscribe",
      value: {
        nonce: Array.from(nonce),
        handler,
      },
    },
  );

  const instruction: Instruction = {
    programId,

    accounts: [
      {
        pubkey: subscriber,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: subscriptionAddress,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: systemProgram,
        isSigner: false,
        isWritable: false,
      },
    ],

    data,
  };

  return {
    instruction,
    subscriptionAddress: subscriptionAddress.toString(),
  };
}

export async function buildNativeUnsubscribeInstruction(
  subscriberAddress: string,
  nonceText: string,
): Promise<{
  instruction: Instruction;
  subscriptionAddress: string;
}> {
  const subscriber = PublicKey.fromString(subscriberAddress);
  const programId = PublicKey.fromString(SUBSCRIBER_PROGRAM_ID);
  const nonce = encodeNonce(nonceText);

  const [subscriptionAddress] = PublicKey.findProgramAddress(
    [
      new TextEncoder().encode(RIALO_SUBSCRIBE_SEED),
      subscriber.toBytes(),
      nonce,
    ],
    programId,
  );

  const data = serialize(subscriberInstructionSchema, {
    variant: "Unsubscribe",
    value: {
      nonce: Array.from(nonce),
    },
  });

  const instruction: Instruction = {
    programId,
    accounts: [
      {
        pubkey: subscriber,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: subscriptionAddress,
        isSigner: false,
        isWritable: true,
      },
    ],
    data,
  };

  return {
    instruction,
    subscriptionAddress: subscriptionAddress.toString(),
  };
}

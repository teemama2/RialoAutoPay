import { readFileSync } from "node:fs";
import { PublicKey, Schema, serialize } from "@rialo/ts-cdk";

const key = (value) => PublicKey.fromString(value).toBytes();
const zeroKey = new Uint8Array(32);
const nonce = new Uint8Array(32);

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
  ["timestamp_range", Schema.option(
    Schema.tuple(Schema.u64(), Schema.u64())
  )],
]);

const subscriptionSchema = Schema.struct([
  ["subscriber", Schema.pubkey()],
  ["predicate", predicateSchema],
  ["instructions", Schema.vec(instructionSchema)],
  ["kind", Schema.enum([
    ["Persistent", null],
    ["OneShot", null],
  ])],
  ["active_commits", Schema.tuple(Schema.u64(), Schema.u64())],
]);

const subscribePayloadSchema = Schema.struct([
  ["nonce", Schema.fixedArray(32)],
  ["handler", subscriptionSchema],
]);

const subscriberInstructionSchema = Schema.enum([
  ["Subscribe", subscribePayloadSchema],
  ["Unsubscribe", Schema.struct([["nonce", Schema.fixedArray(32)]])],
  ["Update", subscribePayloadSchema],
  ["Destroy", Schema.struct([["nonce", Schema.fixedArray(32)]])],
]);

const clockSysvar = "SysvarC1ock11111111111111111111111111111111";
const systemProgram = "11111111111111111111111111111111";

const handler = {
  subscriber: zeroKey,
  predicate: {
    topic: "clock",
    event_account: key(clockSysvar),
    timestamp_range: [0n, 18446744073709551615n],
  },
  instructions: [{
    program_id: key(systemProgram),
    accounts: [],
    data: new Uint8Array(),
  }],
  kind: { variant: "Persistent" },
  active_commits: [0n, 18446744073709551615n],
};

const encoded = serialize(subscriberInstructionSchema, {
  variant: "Subscribe",
  value: { nonce, handler },
});

const reference = readFileSync(
  "tools/rialo-subscription-reference/subscribe-reference.bin"
);

const toHex = (bytes) =>
  Buffer.from(bytes).toString("hex");

console.log("Reference length:", reference.length);
console.log("TypeScript length:", encoded.length);
console.log("Byte-for-byte match:", Buffer.from(encoded).equals(reference));

if (!Buffer.from(encoded).equals(reference)) {
  let firstMismatch = -1;
  const limit = Math.min(encoded.length, reference.length);

  for (let i = 0; i < limit; i++) {
    if (encoded[i] !== reference[i]) {
      firstMismatch = i;
      break;
    }
  }

  console.log("First mismatch offset:", firstMismatch);
  if (firstMismatch >= 0) {
    console.log("Expected:", toHex(reference.slice(firstMismatch, firstMismatch + 16)));
    console.log("Actual:  ", toHex(encoded.slice(firstMismatch, firstMismatch + 16)));
  }
  process.exitCode = 1;
} else {
  console.log("PASS: TypeScript encoding matches the Rust reference.");
}

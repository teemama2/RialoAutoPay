import { useState } from "react";
import {
  PublicKey,
  TransactionBuilder,
} from "@rialo/ts-cdk";

import {
  useChainId,
  useSignAndSendTransaction,
} from "@rialo/frost";

import { fetchSubscriptionActivity } from "./lib/subscriptionMonitor";
import { buildNativeUnsubscribeInstruction } from "./lib/subscriptionBuilder";
import { rialoClient } from "./lib/rialoClient";

type Props = {
  subscriberAddress: string;
};

type Activity = Awaited<
  ReturnType<typeof fetchSubscriptionActivity>
>;

function displayError(value: unknown): string {
  if (value == null) {
    return "No execution error reported";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function SubscriptionActivityPanel({
  subscriberAddress,
}: Props) {
  const chainId = useChainId();

  const {
    mutateAsync: signAndSendAsync,
    isPending,
  } = useSignAndSendTransaction();

  const [nonce, setNonce] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelSignature, setCancelSignature] = useState("");

  async function checkActivity() {
    setError("");
    setMessage("");
    setActivity(null);
    setCancelSignature("");

    if (!subscriberAddress) {
      setError("Connect your wallet first.");
      return;
    }

    if (!nonce.trim()) {
      setError("Enter the exact subscription nonce.");
      return;
    }

    if (chainId !== "rialo:devnet") {
      setError("Switch your wallet to Rialo Devnet.");
      return;
    }

    setLoading(true);

    try {
      const result = await fetchSubscriptionActivity(
        subscriberAddress,
        nonce.trim(),
        recipientAddress,
      );

      setActivity(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to check subscription activity.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function cancelSubscription() {
    setError("");
    setMessage("");
    setCancelSignature("");

    if (!subscriberAddress || !activity?.subscription) {
      setError(
        "No active subscription record was returned. Cannot request unsubscription from this panel.",
      );
      return;
    }

    if (chainId !== "rialo:devnet") {
      setError("Switch your wallet to Rialo Devnet.");
      return;
    }

    const confirmed = window.confirm(
      "You are about to request unsubscription on Rialo Devnet. " +
        "This does not reverse a transfer that has already executed. Continue?",
    );

    if (!confirmed) {
      return;
    }

    setCanceling(true);

    try {
      const payer = PublicKey.fromString(subscriberAddress);

      const result = await buildNativeUnsubscribeInstruction(
        subscriberAddress,
        nonce.trim(),
      );

      const configHashPrefix =
        await rialoClient.getConfigHashPrefix();

      const transaction = TransactionBuilder.create()
        .setPayer(payer)
        .setValidFrom(BigInt(Date.now()))
        .setConfigHashPrefix(configHashPrefix)
        .addInstruction(result.instruction)
        .build();

      const submission = await signAndSendAsync({
        transaction,
        sendOptions: {
          skipPreflight: false,
          maxRetries: 3,
          confirmMaxRetries: 10,
          confirmRetryDelayMs: 1000,
        },
      });

      setCancelSignature(submission.signature);

      setMessage(
        "The unsubscribe transaction returned a signature. " +
          "Recheck the subscription to verify its state.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The unsubscribe transaction failed.",
      );
    } finally {
      setCanceling(false);
    }
  }

  const busy = loading || canceling || isPending;

  const timestampRange =
    activity?.subscription?.timestampRange ?? null;

  const hasTimestampRange =
    Array.isArray(timestampRange) &&
    timestampRange.length === 2;

  return (
    <section className="feature-card">
      <h2>Subscription Activity</h2>

      <p>
        Inspect a subscription, its triggered transactions, and
        account transaction histories on Rialo Devnet.
      </p>

      <label className="label" htmlFor="subscription-nonce">
        Subscription nonce
      </label>

      <input
        id="subscription-nonce"
        type="text"
        value={nonce}
        onChange={(event) => setNonce(event.target.value)}
        placeholder="Enter the exact subscription nonce"
        disabled={busy}
      />

      <label className="label" htmlFor="history-recipient">
        Recipient address (optional if the subscription is still active)
      </label>

      <input
        id="history-recipient"
        type="text"
        value={recipientAddress}
        onChange={(event) => setRecipientAddress(event.target.value)}
        placeholder="Enter the payment recipient address"
        disabled={busy}
      />

      <button
        type="button"
        onClick={checkActivity}
        disabled={busy || !subscriberAddress}
      >
        {loading ? "Checking Rialo..." : "Check subscription and histories"}
      </button>

      {!subscriberAddress && (
        <p className="notice">Connect your wallet to continue.</p>
      )}

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}

      {cancelSignature && (
        <div className="notice">
          <p>
            <strong>Unsubscribe transaction signature</strong>
          </p>
          <code>{cancelSignature}</code>
        </div>
      )}

      {activity && (
        <div>
          <h3>Subscription lookup</h3>

          <p className="label">Subscription address</p>
          <code>{activity.subscriptionAddress}</code>

          {activity.subscriptionLookupError && (
            <div className="notice">
              <strong>Active subscription record unavailable</strong>
              <p>{activity.subscriptionLookupError}</p>
              <p>
                Account histories are queried separately below.
                A missing subscription record does not prove the payment
                executed.
              </p>
            </div>
          )}

          {activity.subscription && (
            <>
              {!hasTimestampRange && (
                <p className="notice" role="alert">
                  No timestamp range was returned in the subscription record.
                </p>
              )}

              <h3>Subscription record</h3>

              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {JSON.stringify(
                  activity.subscription,
                  (_key, value) =>
                    typeof value === "bigint"
                      ? value.toString()
                      : value,
                  2,
                )}
              </pre>

              <button
                type="button"
                onClick={cancelSubscription}
                disabled={busy}
              >
                {busy
                  ? "Processing..."
                  : "Unsubscribe this registration"}
              </button>
            </>
          )}

          <h3>Subscription-triggered transactions</h3>
          <p>
            <strong>Returned:</strong> {activity.transactionCount}
          </p>

          {activity.triggeredTransactionsError && (
            <p className="notice" role="alert">
              {activity.triggeredTransactionsError}
            </p>
          )}

          {activity.triggeredTransactions.length === 0 ? (
            <p>
              No triggered transactions were returned by this query.
            </p>
          ) : (
            <ul>
              {activity.triggeredTransactions.map((tx, index) => (
                <li key={`${tx.signature}-${index}`}>
                  <p className="label">Signature</p>
                  <code>{tx.signature}</code>
                  <p>Block: {tx.blockNumber.toString()}</p>
                </li>
              ))}
            </ul>
          )}

          <h3>Sender transaction history</h3>
          <p className="label">Address</p>
          <code>{subscriberAddress}</code>

          {activity.senderHistoryError && (
            <p className="notice" role="alert">
              {activity.senderHistoryError}
            </p>
          )}

          {activity.senderAddressHistory.length === 0 ? (
            <p>No sender transaction signatures were returned.</p>
          ) : (
            <ul>
              {activity.senderAddressHistory.slice(0, 20).map((tx) => (
                <li key={tx.signature}>
                  <p className="label">Signature</p>
                  <code>{tx.signature}</code>
                  <p>Block height: {tx.blockHeight.toString()}</p>
                  <p>Block time value: {tx.blockTime.toString()}</p>
                  <p>Execution error: {displayError(tx.err)}</p>
                </li>
              ))}
            </ul>
          )}

          <h3>Recipient transaction history</h3>

          {activity.recipientAddress && (
            <code>{activity.recipientAddress}</code>
          )}

          {activity.recipientHistoryError && (
            <p className="notice" role="alert">
              {activity.recipientHistoryError}
            </p>
          )}

          {activity.recipientAddressHistory.length === 0 ? (
            <p>No recipient transaction signatures were returned.</p>
          ) : (
            <ul>
              {activity.recipientAddressHistory.slice(0, 20).map((tx) => (
                <li key={tx.signature}>
                  <p className="label">Signature</p>
                  <code>{tx.signature}</code>
                  <p>Block height: {tx.blockHeight.toString()}</p>
                  <p>Block time value: {tx.blockTime.toString()}</p>
                  <p>Execution error: {displayError(tx.err)}</p>
                </li>
              ))}
            </ul>
          )}

          <p className="notice">
            These lists show transactions associated with the accounts.
            To confirm the scheduled payment, we must identify the relevant
            signature and inspect that transaction's instructions and result.
          </p>
        </div>
      )}
    </section>
  );
}
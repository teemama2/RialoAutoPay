
import { useState } from "react";
import {
  PublicKey,
  TransactionBuilder,
  transferInstruction,
  KELVIN_PER_RLO,
} from "@rialo/ts-cdk";
import {
  useActiveAccount,
  useChainId,
  useSignAndSendTransaction,
} from "@rialo/frost";
import { rialoClient } from "./lib/rialoClient";

function parseRloToKelvin(value: string): bigint {
  const normalized = value.trim();

  // RLO supports up to 9 decimal places.
  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new Error(
      "Enter a positive amount with no more than 9 decimal places.",
    );
  }

  const [whole, fraction = ""] = normalized.split(".");
  const scale = BigInt(KELVIN_PER_RLO);

  return (
    BigInt(whole) * scale +
    BigInt(fraction.padEnd(9, "0") || "0")
  );
}

export default function PaymentRuleForm() {
  const account = useActiveAccount();
  const chainId = useChainId();

  const {
    mutateAsync: signAndSendAsync,
    isPending,
  } = useSignAndSendTransaction();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  function clearResult() {
    setError("");
    setSignature("");
    setReview(false);
  }

  function reviewPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearResult();

    if (!account) {
      setError("Connect your wallet before preparing a payment.");
      return;
    }

    if (chainId !== "rialo:devnet") {
      setError(
        `Wrong network. Switch your wallet to Rialo Devnet. Current network: ${chainId || "unknown"}.`,
      );
      return;
    }

    try {
      const recipientKey = PublicKey.fromString(recipient.trim());
      const amountInKelvin = parseRloToKelvin(amount);

      if (amountInKelvin <= 0n) {
        setError("Amount must be greater than zero.");
        return;
      }

      if (recipientKey.toString() === account.address) {
        setError("Recipient must be different from your wallet.");
        return;
      }

      setReview(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Invalid recipient address or payment amount.",
      );
    }
  }

  async function confirmPayment() {
    setError("");
    setSignature("");

    if (!account) {
      setError("Your wallet is disconnected. Reconnect it to continue.");
      return;
    }

    if (chainId !== "rialo:devnet") {
      setError("Switch to Rialo Devnet before sending.");
      return;
    }

    try {
      const payer = PublicKey.fromString(account.address);
      const destination = PublicKey.fromString(recipient.trim());
      const amountInKelvin = parseRloToKelvin(amount);

      if (amountInKelvin <= 0n) {
        throw new Error("Amount must be greater than zero.");
      }

      // Fetch current network configuration before building the transaction.
      const configHashPrefix =
        await rialoClient.getConfigHashPrefix();

      const transaction = TransactionBuilder.create()
        .setPayer(payer)
        .setValidFrom(BigInt(Date.now()))
        .setConfigHashPrefix(configHashPrefix)
        .addInstruction(
          transferInstruction(payer, destination, amountInKelvin),
        )
        .build();

      // Frost requests wallet authorization, submits the transaction,
      // and waits for confirmation. Nothing is sent before this action.
      const result = await signAndSendAsync({
        transaction,
        sendOptions: {
          skipPreflight: false,
  maxRetries: 3,
  confirmMaxRetries: 10,
  confirmRetryDelayMs: 1000,
        },
      });

      setSignature(result.signature);
      setReview(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The payment could not be completed.",
      );
    }
  }

  return (
    <section className="account-card">
      <h2>Send a Devnet Payment</h2>

      <p>
        Prepare a one-time RLO transfer. Your connected wallet
        must authorize the transaction.
      </p>

      <form onSubmit={reviewPayment}>
        <label htmlFor="recipient">Recipient address</label>
        <input
          id="recipient"
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
            clearResult();
          }}
          placeholder="Enter Rialo recipient address"
          autoComplete="off"
          required
          disabled={isPending}
        />

        <label htmlFor="amount">Amount (RLO)</label>
        <input
          id="amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            clearResult();
          }}
          placeholder="e.g. 0.1"
          required
          disabled={isPending}
        />

        <button type="submit" disabled={isPending || !account}>
          Review payment
        </button>
      </form>

      {review && (
        <div className="notice" aria-live="polite">
          <h3>Confirm payment details</h3>
          <p>
            <strong>Network:</strong> Rialo Devnet
          </p>
          <p>
            <strong>From:</strong> <code>{account?.address}</code>
          </p>
          <p>
            <strong>To:</strong> <code>{recipient.trim()}</code>
          </p>
          <p>
            <strong>Amount:</strong> {amount} RLO
          </p>
          <p>
            Verify the recipient and amount carefully. Confirming
            will open the wallet authorization flow.
          </p>

          <button
            type="button"
            onClick={confirmPayment}
            disabled={isPending}
          >
            {isPending ? "Waiting for wallet / confirmation..." : "Authorize and send"}
          </button>

          <button
            type="button"
            onClick={() => setReview(false)}
            disabled={isPending}
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}

      {signature && (
        <div className="notice" aria-live="polite">
          <h3>Transaction confirmed</h3>
          <p>The wallet submission returned a transaction signature:</p>
          <code>{signature}</code>
          <p>
            Keep this signature as your transaction reference.
          </p>
          <button
            type="button"
            onClick={() => {
              setRecipient("");
              setAmount("");
              setSignature("");
              setReview(false);
              setError("");
            }}
          >
            Prepare another payment
          </button>
        </div>
      )}

      <p className="notice">
        This sends a one-time payment only. Recurring AutoPay rules
        are not executed by this form.
      </p>
    </section>
  );
}

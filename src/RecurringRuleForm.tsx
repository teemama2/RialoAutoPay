import { useMemo, useState } from "react";
import type {
  FormEvent,
  CSSProperties,
} from "react";

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

import type {
  PaymentFrequency,
  PaymentRule,
  PaymentRuleRecord,
  ScheduledPaymentRegistration,
} from "./types/paymentRule";

import { rialoClient } from "./lib/rialoClient";
import { planPaymentDates } from "./lib/paymentSchedule";
import { buildNativeSubscribeInstruction } from "./lib/subscriptionBuilder";

interface Props {
  onRuleUpdated?: (rule: PaymentRuleRecord) => void;
}

const CLOCK_TOPIC = "clock";
const CLOCK_SYSVAR =
  "SysvarC1ock11111111111111111111111111111111";

const U64_MAX = 18_446_744_073_709_551_615n;
const DAY_MS = 86_400_000;

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "12px",
  marginTop: "6px",
  borderRadius: "10px",
  border: "1px solid #35435c",
  background: "#0b1020",
  color: "#e9edf5",
  font: "inherit",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginTop: "16px",
  color: "#cbd5e1",
  fontWeight: 600,
};

const previewStyle: CSSProperties = {
  marginTop: "20px",
  padding: "16px",
  border: "1px solid #27334c",
  borderRadius: "12px",
  overflowWrap: "anywhere",
};

function parseRloToKelvin(value: string): bigint {
  const normalized = value.trim();

  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new Error(
      "Enter a positive RLO amount with no more than 9 decimal places.",
    );
  }

  const [whole, fraction = ""] = normalized.split(".");
  const amount =
    BigInt(whole) * BigInt(KELVIN_PER_RLO) +
    BigInt(fraction.padEnd(9, "0") || "0");

  if (amount <= 0n || amount > U64_MAX) {
    throw new Error("The RLO amount is outside the supported range.");
  }

  return amount;
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function makeNonce(ruleId: string, paymentNumber: number): string {
  const prefix = ruleId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  const index = (paymentNumber - 1).toString(16).padStart(4, "0");
  const nonce = `${prefix}${index}`;

  if (new TextEncoder().encode(nonce).length > 32) {
    throw new Error("Generated subscription nonce is too long.");
  }

  return nonce;
}

/**
 * The schedule planner treats date-only values as UTC calendar dates.
 * The subscription predicate uses the same UTC calendar-day boundaries.
 */
function getTimestampRange(
  paymentDate: string,
): readonly [bigint, bigint] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    throw new Error(`Invalid scheduled date: ${paymentDate}`);
  }

  const startMs = Date.parse(`${paymentDate}T00:00:00.000Z`);

  if (
    !Number.isFinite(startMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== paymentDate
  ) {
    throw new Error(`Invalid calendar date: ${paymentDate}`);
  }

  const endMs = startMs + DAY_MS;

  if (startMs <= Date.now()) {
    throw new Error(
      `Payment date ${paymentDate} is not in the future. Choose dates starting tomorrow or later.`,
    );
  }

  return [BigInt(startMs), BigInt(endMs)];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "An unexpected error occurred during registration.";
}

export default function RecurringRuleForm({
  onRuleUpdated,
}: Props) {
  const account = useActiveAccount();
  const chainId = useChainId();

  const {
    mutateAsync: signAndSendAsync,
    isPending,
  } = useSignAndSendTransaction();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] =
    useState<PaymentFrequency>("monthly");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxPayments, setMaxPayments] = useState("12");

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [registeredCount, setRegisteredCount] = useState(0);

  const schedulePreview = useMemo(() => {
    if (!startDate || !endDate || !maxPayments.trim()) {
      return { payments: [], error: "" };
    }

    try {
      const payments = planPaymentDates({
        frequency,
        startDate,
        endDate,
        maxPayments: Number(maxPayments),
      });

      return { payments, error: "" };
    } catch (cause) {
      return {
        payments: [],
        error: errorMessage(cause),
      };
    }
  }, [frequency, startDate, endDate, maxPayments]);

  function clearFeedback() {
    setError("");
    setMessage("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    setRegisteredCount(0);

    if (isRegistering || isPending) {
      return;
    }

    if (!account) {
      setError("Connect your wallet before registering a schedule.");
      return;
    }

    if (chainId !== "rialo:devnet") {
      setError("Switch your wallet to Rialo Devnet.");
      return;
    }

    let payer: PublicKey;
    let destination: PublicKey;
    let amountInKelvin: bigint;

    try {
      payer = PublicKey.fromString(account.address);
      destination = PublicKey.fromString(recipient.trim());
      amountInKelvin = parseRloToKelvin(amount);

      if (destination.toString() === payer.toString()) {
        throw new Error("Recipient must differ from your wallet.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }

    if (!startDate || !endDate) {
      setError("Choose both a start date and an end date.");
      return;
    }

    if (endDate < startDate) {
      setError("End date must be on or after the start date.");
      return;
    }

    const limit = Number(maxPayments);

    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000
    ) {
      setError("Maximum payments must be between 1 and 10,000.");
      return;
    }

    if (schedulePreview.error) {
      setError(schedulePreview.error);
      return;
    }

    const payments = schedulePreview.payments;

    if (payments.length === 0) {
      setError("The selected dates produce no scheduled payments.");
      return;
    }

    // Validate every date before asking the wallet to register anything.
    try {
      for (const payment of payments) {
        getTimestampRange(payment.date);
        makeNonce(crypto.randomUUID(), payment.paymentNumber);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }

    const rule: PaymentRule = {
      id: crypto.randomUUID(),
      payer: payer.toString(),
      recipient: destination.toString(),
      amountRlo: amount.trim(),
      frequency,
      startDate,
      endDate,
      maxPayments: limit,
      createdAt: new Date().toISOString(),
    };

    const registrations: ScheduledPaymentRegistration[] =
      payments.map((payment) => ({
        paymentNumber: payment.paymentNumber,
        date: payment.date,
        nonce: makeNonce(rule.id, payment.paymentNumber),
        status: "pending",
      }));

    let record: PaymentRuleRecord = {
      ...rule,
      status: "pending",
      scheduledPayments: registrations,
    };

    const updateRecord = (next: PaymentRuleRecord) => {
      record = next;
      onRuleUpdated?.(next);
    };

    // Register the rule immediately so failures and progress remain visible.
    updateRecord(record);

    const approved = window.confirm(
      `This schedule contains ${payments.length} payment(s). ` +
        "Each payment requires a separate wallet authorization to register. " +
        "If you stop partway through, already registered subscriptions will remain on-chain. Continue?",
    );

    if (!approved) {
      updateRecord({
        ...record,
        status: "draft",
        scheduledPayments: registrations.map((item) => ({
          ...item,
          status: "not_registered",
        })),
      });
      setMessage("Registration cancelled. No subscription was submitted.");
      return;
    }

    setIsRegistering(true);

    try {
      for (let index = 0; index < payments.length; index += 1) {
        const payment = payments[index];
        const registration = registrations[index];

        try {
          // Re-check connection and network before each transaction.
          if (chainId !== "rialo:devnet") {
            throw new Error("Switch to Rialo Devnet before continuing.");
          }

          const currentPayer = PublicKey.fromString(account.address);
          const currentDestination = PublicKey.fromString(rule.recipient);
          const timestampRange = getTimestampRange(payment.date);

          const transfer = transferInstruction(
            currentPayer,
            currentDestination,
            amountInKelvin,
          );

          const built = await buildNativeSubscribeInstruction({
            subscriberAddress: currentPayer.toString(),
            nonceText: registration.nonce,
            predicate: {
              topic: CLOCK_TOPIC,
              eventAccount: CLOCK_SYSVAR,
              timestampRange,
            },
            instructions: [transfer],
            kind: "OneShot",
            activeCommits: [0n, U64_MAX],
          });

          const configHashPrefix =
            await rialoClient.getConfigHashPrefix();

          const transaction = TransactionBuilder.create()
            .setPayer(currentPayer)
            .setValidFrom(BigInt(Date.now()))
            .setConfigHashPrefix(configHashPrefix)
            .addInstruction(built.instruction)
            .build();

          const result = await signAndSendAsync({
            transaction,
            sendOptions: {
              skipPreflight: false,
              maxRetries: 3,
              confirmMaxRetries: 10,
              confirmRetryDelayMs: 1000,
            },
          });

          registrations[index] = {
            ...registration,
            status: "registered",
            subscriptionAddress: built.subscriptionAddress,
            creationSignature: result.signature,
          };

          const completed = registrations.filter(
            (item) => item.status === "registered",
          ).length;

          setRegisteredCount(completed);

          updateRecord({
            ...record,
            status:
              completed === registrations.length
                ? "active"
                : "partially_registered",
            scheduledPayments: [...registrations],
          });
        } catch (cause) {
          registrations[index] = {
            ...registration,
            status: "failed",
            error: errorMessage(cause),
          };

          for (let remaining = index + 1; remaining < registrations.length; remaining += 1) {
            registrations[remaining] = {
              ...registrations[remaining],
              status: "not_registered",
            };
          }

          const completed = registrations.filter(
            (item) => item.status === "registered",
          ).length;

          updateRecord({
            ...record,
            status: completed > 0 ? "partially_registered" : "failed",
            scheduledPayments: [...registrations],
          });

          setError(
            `Registration stopped at payment ${payment.paymentNumber} of ${payments.length}. ` +
              `${completed} subscription(s) were registered. ${errorMessage(cause)}`,
          );

          return;
        }
      }

      updateRecord({
        ...record,
        status: "active",
        scheduledPayments: [...registrations],
      });

      setMessage(
        `All ${registrations.length} one-shot subscription(s) were submitted and confirmed by the wallet flow. ` +
          "The scheduled transfers have not necessarily executed yet. Check Subscription Activity to inspect triggered transactions.",
      );
    } finally {
      setIsRegistering(false);
    }
  }

  const visiblePayments = schedulePreview.payments.slice(0, 8);
  const remainingPayments =
    schedulePreview.payments.length - visiblePayments.length;

  const busy = isRegistering || isPending;

  return (
    <section className="account-card">
      <h2>Create recurring payment</h2>

      <p>
        Configure the recipient, amount, frequency, date range, and payment
        limit. Each scheduled payment will be registered as its own one-shot
        subscription on Rialo Devnet.
      </p>

      <form onSubmit={handleSubmit}>
        <label style={labelStyle} htmlFor="auto-recipient">
          Recipient address
        </label>
        <input
          id="auto-recipient"
          style={fieldStyle}
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
            clearFeedback();
          }}
          placeholder="Rialo recipient address"
          autoComplete="off"
          required
          disabled={busy}
        />

        <label style={labelStyle} htmlFor="auto-amount">
          Amount per payment (RLO)
        </label>
        <input
          id="auto-amount"
          style={fieldStyle}
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            clearFeedback();
          }}
          inputMode="decimal"
          placeholder="0.1"
          required
          disabled={busy}
        />

        <label style={labelStyle} htmlFor="auto-frequency">
          Frequency
        </label>
        <select
          id="auto-frequency"
          style={fieldStyle}
          value={frequency}
          onChange={(event) =>
            setFrequency(event.target.value as PaymentFrequency)
          }
          disabled={busy}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>

        <label style={labelStyle} htmlFor="auto-start">
          Start date (UTC)
        </label>
        <input
          id="auto-start"
          style={fieldStyle}
          type="date"
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
            clearFeedback();
          }}
          required
          disabled={busy}
        />

        <label style={labelStyle} htmlFor="auto-end">
          End date (UTC)
        </label>
        <input
          id="auto-end"
          style={fieldStyle}
          type="date"
          value={endDate}
          min={startDate || undefined}
          onChange={(event) => {
            setEndDate(event.target.value);
            clearFeedback();
          }}
          required
          disabled={busy}
        />

        <label style={labelStyle} htmlFor="auto-limit">
          Maximum number of payments
        </label>
        <input
          id="auto-limit"
          style={fieldStyle}
          type="number"
          min="1"
          max="10000"
          step="1"
          value={maxPayments}
          onChange={(event) => {
            setMaxPayments(event.target.value);
            clearFeedback();
          }}
          required
          disabled={busy}
        />

        <section
          style={previewStyle}
          aria-live="polite"
          aria-label="Payment schedule preview"
        >
          <h3 style={{ marginTop: 0 }}>Payment schedule preview</h3>

          {!startDate || !endDate ? (
            <p>Choose a start date and end date to preview payments.</p>
          ) : schedulePreview.error ? (
            <p role="alert">{schedulePreview.error}</p>
          ) : schedulePreview.payments.length === 0 ? (
            <p>No payments fall within the selected date range.</p>
          ) : (
            <>
              <p>
                <strong>{schedulePreview.payments.length}</strong> planned
                payment(s).
              </p>

              <p>
                Frequency:{" "}
                {frequency.charAt(0).toUpperCase() + frequency.slice(1)}
              </p>

              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    textAlign: "left",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ padding: "8px 4px" }}>Payment</th>
                      <th style={{ padding: "8px 4px" }}>Planned date (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePayments.map((payment) => (
                      <tr key={payment.paymentNumber}>
                        <td
                          style={{
                            padding: "8px 4px",
                            borderTop: "1px solid #27334c",
                          }}
                        >
                          {payment.paymentNumber}
                        </td>
                        <td
                          style={{
                            padding: "8px 4px",
                            borderTop: "1px solid #27334c",
                          }}
                        >
                          {formatDate(payment.date)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {remainingPayments > 0 && (
                <p>
                  Showing the first 8 dates. {remainingPayments} more
                  scheduled payment(s) are not shown.
                </p>
              )}

              <p>
                Estimated total:{" "}
                {(Number(amount) * schedulePreview.payments.length).toLocaleString(
                  "en-US",
                  { maximumFractionDigits: 9 },
                )}{" "}
                RLO across the planned payments.
              </p>
            </>
          )}

          <p className="notice">
            Registration requires wallet approval for each scheduled payment.
            Dates use UTC calendar-day boundaries. This preview does not itself
            register or execute transfers.
          </p>
        </section>

        <button
          type="submit"
          disabled={!account || chainId !== "rialo:devnet" || busy}
          style={{ marginTop: "20px" }}
        >
          {busy
            ? `Registering subscriptions (${registeredCount}/${schedulePreview.payments.length})...`
            : "Review and register schedule"}
        </button>
      </form>

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
    </section>
  );
}
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

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
import {
  planPaymentDates,
  planTwoMinuteTestPayments,
  type ScheduledPayment,
} from "./lib/paymentSchedule";
import { buildNativeSubscribeInstruction } from "./lib/subscriptionBuilder";
import {
  getScheduledPaymentTimestampRange,
  SubscriptionVerificationError,
  verifyNativeSubscriptionRegistration,
} from "./lib/subscriptionVerification";

interface Props {
  onRuleUpdated?: (rule: PaymentRuleRecord) => void;
}

const CLOCK_TOPIC = "clock";
const CLOCK_SYSVAR =
  "SysvarC1ock11111111111111111111111111111111";

const U64_MAX = 18_446_744_073_709_551_615n;
const DAY_MS = 86_400_000;

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
    try {
      if (frequency === "two_minutes_test") {
        return {
          payments: planTwoMinuteTestPayments(),
          error: "",
        };
      }

      if (!startDate || !endDate || !maxPayments.trim()) {
        return { payments: [] as ScheduledPayment[], error: "" };
      }

      const payments = planPaymentDates({
        frequency,
        startDate,
        endDate,
        maxPayments: Number(maxPayments),
      });

      return { payments, error: "" };
    } catch (cause) {
      return {
        payments: [] as ScheduledPayment[],
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

    const isTwoMinuteTest = frequency === "two_minutes_test";
    const limit = isTwoMinuteTest ? 3 : Number(maxPayments);

    let payments: ScheduledPayment[];

    if (isTwoMinuteTest) {
      // Generate fresh windows at submission time, not from an old preview.
      payments = planTwoMinuteTestPayments();
    } else {
      if (!startDate || !endDate) {
        setError("Choose both a start date and an end date.");
        return;
      }

      if (endDate < startDate) {
        setError("End date must be on or after the start date.");
        return;
      }

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

      payments = schedulePreview.payments;
    }

    if (payments.length === 0) {
      setError("The selected settings produce no scheduled payments.");
      return;
    }

    // Validate every trigger window before requesting wallet approval.
    try {
      for (const payment of payments) {
        if (isTwoMinuteTest && !payment.timestampRangeMs) {
          throw new Error(
            `Test payment ${payment.paymentNumber} has no timestamp window.`,
          );
        }

        if (payment.timestampRangeMs) {
          const range = getScheduledPaymentTimestampRange(
            payment.date,
            payment.timestampRangeMs,
          );

          if (range[0] <= BigInt(Date.now())) {
            throw new Error(
              "A test payment window has already started. Generate a fresh test schedule.",
            );
          }

          if (range[1] - range[0] !== 120_000n) {
            throw new Error(
              "Each test payment must have a two-minute trigger window.",
            );
          }
        } else {
          getTimestampRange(payment.date);
        }

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
      startDate: isTwoMinuteTest ? payments[0].date : startDate,
      endDate: isTwoMinuteTest
        ? payments[payments.length - 1].date
        : endDate,
      maxPayments: limit,
      createdAt: new Date().toISOString(),
    };

    const registrations: ScheduledPaymentRegistration[] =
      payments.map((payment) => ({
        paymentNumber: payment.paymentNumber,
        date: payment.date,
        timestampRangeMs: payment.timestampRangeMs,
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

    const freshWindowSummary = isTwoMinuteTest
      ? "\n\nFresh DevNet trigger windows (UTC):\n" +
        payments.map((payment) => {
          const range = payment.timestampRangeMs;

          if (!range) {
            throw new Error(
              `Payment ${payment.paymentNumber} has no saved timestamp range.`,
            );
          }

          return (
            `Payment ${payment.paymentNumber}: ` +
            `${new Date(Number(range[0])).toISOString()} – ` +
            `${new Date(Number(range[1])).toISOString()}`
          );
        }).join("\n")
      : "";

    const approved = window.confirm(
      `This schedule contains ${payments.length} payment(s).\n` +
        `Amount per payment: ${amount.trim()} RLO\n` +
        `Recipient: ${destination.toString()}` +
        freshWindowSummary +
        "\n\nEach payment requires a separate wallet authorization to register. " +
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
          const timestampRange = registration.timestampRangeMs
            ? getScheduledPaymentTimestampRange(
                payment.date,
                registration.timestampRangeMs,
              )
            : getTimestampRange(payment.date);

          if (timestampRange[0] <= BigInt(Date.now())) {
            throw new Error(
              "This payment's trigger window has already started. Registration stopped to avoid a missed test payment.",
            );
          }

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

          // The transaction has executed, but do not call the
          // subscription registered until its stored record is verified.
          registrations[index] = {
            ...registration,
            status: "verification_pending",
            subscriptionAddress: built.subscriptionAddress,
            creationSignature: result.signature,
            error: "Creation transaction confirmed; verifying the stored subscription.",
          };

          const confirmedCount = registrations.filter(
            (item) => Boolean(item.creationSignature),
          ).length;

          setRegisteredCount(confirmedCount);

          // Persist the signature and PDA before attempting readback.
          updateRecord({
            ...record,
            status: "partially_registered",
            scheduledPayments: [...registrations],
          });

          try {
            await verifyNativeSubscriptionRegistration({
              subscriberAddress: currentPayer.toString(),
              recipientAddress: currentDestination.toString(),
              nonce: registration.nonce,
              subscriptionAddress: built.subscriptionAddress,
              amountKelvin: amountInKelvin,
              timestampRange,
            });

            registrations[index] = {
              ...registrations[index],
              status: "registered",
              error: undefined,
            };
          } catch (verificationCause) {
            const retryable =
              verificationCause instanceof SubscriptionVerificationError &&
              verificationCause.retryable;

            registrations[index] = {
              ...registrations[index],
              status: retryable
                ? "verification_pending"
                : "verification_failed",
              error: errorMessage(verificationCause),
            };

            if (!retryable) {
              for (
                let remaining = index + 1;
                remaining < registrations.length;
                remaining += 1
              ) {
                registrations[remaining] = {
                  ...registrations[remaining],
                  status: "not_registered",
                };
              }

              updateRecord({
                ...record,
                status: "partially_registered",
                scheduledPayments: [...registrations],
              });

              setError(
                `Payment ${payment.paymentNumber} has a confirmed creation transaction, but its on-chain subscription did not match the intended payment. Further registrations were stopped. ${errorMessage(verificationCause)}`,
              );

              return;
            }
          }

          const allVerified = registrations.every(
            (item) => item.status === "registered",
          );

          updateRecord({
            ...record,
            status: allVerified ? "active" : "partially_registered",
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
            (item) => Boolean(item.creationSignature),
          ).length;

          updateRecord({
            ...record,
            status: completed > 0 ? "partially_registered" : "failed",
            scheduledPayments: [...registrations],
          });

          setError(
            `Registration stopped at payment ${payment.paymentNumber} of ${payments.length}. ` +
              `${completed} subscription creation transaction(s) were already confirmed. ${errorMessage(cause)}`,
          );

          return;
        }
      }

      const allVerified = registrations.every(
        (item) => item.status === "registered",
      );

      const pendingVerificationCount = registrations.filter(
        (item) => item.status === "verification_pending",
      ).length;

      updateRecord({
        ...record,
        status: allVerified ? "active" : "partially_registered",
        scheduledPayments: [...registrations],
      });

      setMessage(
        allVerified
          ? `All ${registrations.length} one-shot subscriptions were submitted, confirmed, and independently verified from Rialo Devnet. The scheduled transfers have not necessarily executed yet.`
          : `All ${registrations.length} subscription creation transactions were confirmed. ${pendingVerificationCount} subscription record(s) still need on-chain verification. Use Refresh Payment Statuses to retry. The scheduled transfers have not necessarily executed yet.`,
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
        <label className="form-label" htmlFor="auto-recipient">
          Recipient address
        </label>
        <input
          id="auto-recipient"
          className="form-control"
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

        <label className="form-label" htmlFor="auto-amount">
          Amount per payment (RLO)
        </label>
        <input
          id="auto-amount"
          className="form-control"
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

        <label className="form-label" htmlFor="auto-frequency">
          Frequency
        </label>
        <select
          id="auto-frequency"
          className="form-control"
          value={frequency}
          onChange={(event) =>
            setFrequency(event.target.value as PaymentFrequency)
          }
          disabled={busy}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="two_minutes_test">
            Every 2 Minutes (DevNet Test)
          </option>
        </select>

        {frequency !== "two_minutes_test" && (
          <>
            <label className="form-label" htmlFor="auto-start">
              Start date (UTC)
            </label>
            <input
              id="auto-start"
              className="form-control"
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                clearFeedback();
              }}
              required
              disabled={busy}
            />

            <label className="form-label" htmlFor="auto-end">
              End date (UTC)
            </label>
            <input
              id="auto-end"
              className="form-control"
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

            <label className="form-label" htmlFor="auto-limit">
              Maximum number of payments
            </label>
            <input
              id="auto-limit"
              className="form-control"
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
          </>
        )}

        {frequency === "two_minutes_test" && (
          <p className="form-help">
            DevNet test mode creates exactly 3 separate one-shot payments.
            Each has a 2-minute UTC trigger window. Each registration
            requires its own wallet approval. Keep enough test RLO in the
            payer wallet for all three transfers and network fees.
          </p>
        )}

        <section
          className="schedule-preview"
          aria-live="polite"
          aria-label="Payment schedule preview"
        >
          <h3 className="schedule-preview-title">Payment schedule preview</h3>

          {frequency !== "two_minutes_test" && (!startDate || !endDate) ? (
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
                {frequency === "two_minutes_test"
                  ? "Every 2 Minutes (DevNet Test)"
                  : frequency.charAt(0).toUpperCase() + frequency.slice(1)}
              </p>

              <div className="schedule-table-wrap">
                <table className="schedule-table">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>
                        {frequency === "two_minutes_test"
                          ? "Trigger window (UTC)"
                          : "Planned date (UTC)"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePayments.map((payment) => (
                      <tr key={payment.paymentNumber}>
                        <td>
                          {payment.paymentNumber}
                        </td>
                        <td>
                          {payment.timestampRangeMs
                            ? `${new Date(
                                Number(payment.timestampRangeMs[0]),
                              ).toISOString()} – ${new Date(
                                Number(payment.timestampRangeMs[1]),
                              ).toISOString()}`
                            : formatDate(payment.date)}
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
            {frequency === "two_minutes_test"
              ? " Each test window lasts two minutes. The first window is planned five minutes after schedule generation to allow registration approvals. Fresh windows are generated when you submit; the final window can end about eleven minutes after submission."
              : " Dates use UTC calendar-day boundaries."}
            {" "}This preview does not itself register or execute transfers.
          </p>
        </section>

        <button
          type="submit"
          disabled={!account || chainId !== "rialo:devnet" || busy}
          className="register-schedule-button"
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
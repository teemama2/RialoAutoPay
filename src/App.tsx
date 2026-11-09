import { useRef, useState } from "react";
import type { PaymentRuleRecord } from "./types/paymentRule";

import {
  FrostProvider,
  ConnectButton,
  useIsConnected,
  useActiveAccount,
  useChainId,
  useNativeBalance,
  useWallets,
  useWalletsReady,
} from "@rialo/frost";

import { getWallets } from "@wallet-standard/app";
import PaymentRuleForm from "./PaymentRuleForm";
import RecurringRuleForm from "./RecurringRuleForm";
import SubscriptionActivityPanel from "./SubscriptionActivityPanel";
import { frostConfig } from "./frost.config";

import {
  fetchTriggeredTransactionsForSubscriptionAddress,
  verifyTriggeredTransaction,
} from "./lib/subscriptionMonitor";

import {
  getUtcPaymentTimestampRange,
  parsePaymentAmountToKelvin,
  SubscriptionVerificationError,
  verifyNativeSubscriptionRegistration,
} from "./lib/subscriptionVerification";

import "./App.css";

const STORAGE_PREFIX = "rialo-autopay:rules:v1:";

function getStorageKey(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function loadWalletRules(address: string | undefined): {
  rules: PaymentRuleRecord[];
  message: string;
} {
  if (!address) {
    return { rules: [], message: "" };
  }

  try {
    const raw = localStorage.getItem(getStorageKey(address));

    if (!raw) {
      return { rules: [], message: "" };
    }

    const parsed: unknown = JSON.parse(raw);

    return {
      rules: Array.isArray(parsed)
        ? (parsed as PaymentRuleRecord[])
        : [],
      message: "",
    };
  } catch {
    return {
      rules: [],
      message: "Saved rules could not be read from this browser.",
    };
  }
}

type AutoPayDashboardProps = {
  walletAddress: string | undefined;
};

function AutoPayDashboard({ walletAddress }: AutoPayDashboardProps) {
  const connected = useIsConnected();
  const account = useActiveAccount();
  const chainId = useChainId();

  // Each wallet gets a separate keyed dashboard instance. Load that
  // wallet's browser records once when its dashboard is mounted.
  const [initialWalletState] = useState(() =>
    loadWalletRules(walletAddress),
  );

  const [paymentRules, setPaymentRules] =
    useState<PaymentRuleRecord[]>(initialWalletState.rules);
  const paymentRulesRef = useRef<PaymentRuleRecord[]>(
    initialWalletState.rules,
  );

  const [storageMessage, setStorageMessage] =
    useState(initialWalletState.message);
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState("");

  const {
    formatted,
    balance,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useNativeBalance();

  const wallets = useWallets();
  const walletsReady = useWalletsReady();

  // Update React state and persist the same wallet's records together.
  // This runs from user actions or completed reconciliation, not an effect.
  function commitPaymentRules(
    update: (current: PaymentRuleRecord[]) => PaymentRuleRecord[],
  ) {
    const nextRules = update(paymentRulesRef.current);

    paymentRulesRef.current = nextRules;
    setPaymentRules(nextRules);

    const address = account?.address;

    // Never write this dashboard's state under a different wallet key.
    if (!address || address !== walletAddress) {
      return;
    }

    try {
      localStorage.setItem(
        getStorageKey(address),
        JSON.stringify(nextRules),
      );
      setStorageMessage("");
    } catch {
      setStorageMessage(
        "Browser storage failed. Rule updates may not survive a refresh.",
      );
    }
  }

  function updateRule(record: PaymentRuleRecord) {
    commitPaymentRules((current) => {
      const exists = current.some(
        (item) => item.id === record.id,
      );

      if (exists) {
        return current.map((item) =>
          item.id === record.id ? record : item,
        );
      }

      return [record, ...current];
    });
  }

  async function refreshPaymentStatuses() {
  setReconcileMessage("");
  setIsReconciling(true);

  try {
    if (!account?.address) {
      throw new Error("Connect your wallet first.");
    }

    if (chainId !== "rialo:devnet") {
      throw new Error("Switch your wallet to Rialo Devnet.");
    }

    if (walletAddress !== account.address) {
      throw new Error(
        "The active wallet changed. Please retry the status refresh.",
      );
    }

    let checked = 0;
    let newlyExecuted = 0;
    let reverifiedExecuted = 0;
    let failedExecutions = 0;
    let stillUnverified = 0;

    let checksRemaining = 50;

    const problems: string[] = [];
    const updatedRules: PaymentRuleRecord[] = [];

    for (const rule of paymentRules) {
      const scheduledPayments = [
        ...(rule.scheduledPayments ?? []),
      ];

      for (
        let index = 0;
        index < scheduledPayments.length;
        index += 1
      ) {
        const payment = scheduledPayments[index];

        if (checksRemaining <= 0) {
          break;
        }

        // Recheck previously executed payments directly by signature.
        const canReverifyExecuted =
          payment.status === "executed" &&
          Boolean(payment.triggeredSignature);

        // Registered payments require a subscription address so we
        // can find their triggered transactions.
        const canCheckRegistered =
          (
            payment.status === "registered" ||
            payment.status === "verification_pending" ||
            payment.status === "verification_failed"
          ) &&
          Boolean(payment.subscriptionAddress);

        if (
          !canReverifyExecuted &&
          !canCheckRegistered
        ) {
          continue;
        }

        checksRemaining -= 1;
        checked += 1;

        // Path A: re-verify an already executed transaction.
        if (
          payment.status === "executed" &&
          payment.triggeredSignature
        ) {
          try {
           const verified = await verifyTriggeredTransaction(
            payment.triggeredSignature,
            {
              payerAddress: rule.payer,
              recipientAddress: rule.recipient,
              expectedAmountRlo: rule.amountRlo,
            },
          );

            if (verified.status === "success") {
              scheduledPayments[index] = {
                ...payment,
                status: "executed",
                triggeredSignature: verified.signature,
                triggeredBlockNumber: verified.blockNumber,
                error: undefined,
              };

              reverifiedExecuted += 1;
            } else {
              scheduledPayments[index] = {
                ...payment,
                status: "failed",
                triggeredSignature: verified.signature,
                triggeredBlockNumber: verified.blockNumber,
                error:
                  verified.error ??
                  "The transaction reported an execution failure.",
              };

              failedExecutions += 1;

              problems.push(
                `Payment ${payment.paymentNumber} in rule ${rule.id} reported an execution failure.`,
              );
            }
          } catch (cause) {
            // Preserve the previous verified status if a temporary
            // RPC problem prevents us from checking it again.
            stillUnverified += 1;

            problems.push(
              `Payment ${payment.paymentNumber} in rule ${rule.id} could not be re-verified: ${
                cause instanceof Error
                  ? cause.message
                  : "Unknown verification error."
              }`,
            );
          }

          continue;
        }

        // Path B: verify registration, then inspect triggered transactions.
        if (
          (
            payment.status !== "registered" &&
            payment.status !== "verification_pending" &&
            payment.status !== "verification_failed"
          ) ||
          !payment.subscriptionAddress
        ) {
          continue;
        }

        // Retry readback for confirmed transactions, including records
        // flagged by an earlier verifier version.
        if (
          payment.status === "verification_pending" ||
          payment.status === "verification_failed"
        ) {
          try {
            await verifyNativeSubscriptionRegistration({
              subscriberAddress: rule.payer,
              recipientAddress: rule.recipient,
              nonce: payment.nonce,
              subscriptionAddress: payment.subscriptionAddress,
              amountKelvin: parsePaymentAmountToKelvin(rule.amountRlo),
              timestampRange: getUtcPaymentTimestampRange(payment.date),
            });

            scheduledPayments[index] = {
              ...payment,
              status: "registered",
              error: undefined,
            };
          } catch (cause) {
            const retryable =
              cause instanceof SubscriptionVerificationError &&
              cause.retryable;

            if (!retryable) {
              scheduledPayments[index] = {
                ...payment,
                status: "verification_failed",
                error:
                  cause instanceof Error
                    ? cause.message
                    : "The stored subscription did not match the intended payment.",
              };

              stillUnverified += 1;

              problems.push(
                `Payment ${payment.paymentNumber} in rule ${rule.id} has a confirmed creation transaction, but its stored subscription could not be verified: ${
                  cause instanceof Error
                    ? cause.message
                    : "Unknown verification error."
                }`,
              );

              continue;
            }

            // Preserve the confirmed signature and address. Continue to
            // check triggered history because a OneShot record may already
            // have been removed after execution.
            scheduledPayments[index] = {
              ...payment,
              status: "verification_pending",
              error:
                cause instanceof Error
                  ? cause.message
                  : "Subscription readback is temporarily unavailable.",
            };
          }
        }

        try {
          const triggeredTransactions =
            await fetchTriggeredTransactionsForSubscriptionAddress(
              payment.subscriptionAddress,
            );

          if (triggeredTransactions.length === 0) {
            stillUnverified += 1;
            continue;
          }

          let verificationCompleted = false;

          for (const triggered of triggeredTransactions) {
            try {
             const verified = await verifyTriggeredTransaction(
              triggered.signature,
              {
                payerAddress: rule.payer,
                recipientAddress: rule.recipient,
                expectedAmountRlo: rule.amountRlo,
              },
            );

              if (verified.status === "success") {
                scheduledPayments[index] = {
                  ...payment,
                  status: "executed",
                  triggeredSignature: verified.signature,
                  triggeredBlockNumber: verified.blockNumber,
                  error: undefined,
                };

                newlyExecuted += 1;
                verificationCompleted = true;
                break;
              }

              scheduledPayments[index] = {
                ...payment,
                status: "failed",
                triggeredSignature: verified.signature,
                triggeredBlockNumber: verified.blockNumber,
                error:
                  verified.error ??
                  "The triggered transaction reported an execution failure.",
              };

              failedExecutions += 1;
              verificationCompleted = true;

              problems.push(
                `Payment ${payment.paymentNumber} in rule ${rule.id} failed execution verification.`,
              );

              break;
            } catch (cause) {
              problems.push(
                `Transaction ${triggered.signature} could not be verified: ${
                  cause instanceof Error
                    ? cause.message
                    : "Unknown verification error."
                }`,
              );
            }
          }

          if (!verificationCompleted) {
            stillUnverified += 1;
          }
        } catch (cause) {
          stillUnverified += 1;

          problems.push(
            `Payment ${payment.paymentNumber} in rule ${rule.id}: ${
              cause instanceof Error
                ? cause.message
                : "Unable to retrieve triggered transactions."
            }`,
          );
        }
      }

      const allExecuted =
        scheduledPayments.length > 0 &&
        scheduledPayments.every(
          (payment) => payment.status === "executed",
        );

      const hasFailedPayment =
        scheduledPayments.some(
          (payment) =>
            payment.status === "failed" ||
            payment.status === "verification_failed",
        );

      const allRegistrationsVerified =
        scheduledPayments.length > 0 &&
        scheduledPayments.every(
          (payment) =>
            payment.status === "registered" ||
            payment.status === "executed",
        );

      updatedRules.push({
        ...rule,
        status: allExecuted
          ? "completed"
          : hasFailedPayment
            ? "failed"
            : allRegistrationsVerified
              ? "active"
              : rule.status,
        scheduledPayments,
      });
    }

    // Merge changes into the latest state so unrelated rules are retained,
    // then persist the resulting records for this wallet.
    commitPaymentRules((current) => {
      const updatesById = new Map(
        updatedRules.map((rule) => [rule.id, rule]),
      );

      return current.map((rule) => {
        const update = updatesById.get(rule.id);

        if (!update) {
          return rule;
        }

        return {
          ...rule,
          status: update.status,
          scheduledPayments: update.scheduledPayments,
        };
      });
    });

    const summary =
      `${checked} payment(s) checked. ` +
      `${newlyExecuted} newly verified as executed. ` +
      `${reverifiedExecuted} previously executed payment(s) re-verified. ` +
      `${failedExecutions} execution failure(s) confirmed. ` +
      `${stillUnverified} remain unverified.`;

    setReconcileMessage(
      problems.length > 0
        ? `${summary} Details: ${problems.slice(0, 3).join(" | ")}`
        : checked === 0
          ? "No registered or previously executed payments with saved signatures were available to check. Existing records were left unchanged."
          : summary,
    );
  } catch (cause) {
    setReconcileMessage(
      cause instanceof Error
        ? cause.message
        : "Could not refresh payment statuses.",
    );
  } finally {
    setIsReconciling(false);
  }
}

  console.log("Frost wallets ready:", walletsReady);

  console.log(
    "Frost discovered wallets:",
    wallets.map((wallet) => wallet.name),
  );

  console.log(
    "Wallet Standard registry:",
    getWallets().get().map((wallet) => ({
      name: wallet.name,
      chains: wallet.chains,
      features: Object.keys(wallet.features),
    })),
  );

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <h1>Rialo AutoPay</h1>
          <p>Reactive payments on Rialo</p>
        </div>

        <ConnectButton />
      </header>

      <section className="network-card">
        <span className="status-dot" />
        <div>
          <strong>Rialo Devnet</strong>
          <p>{chainId || "Checking network..."}</p>
        </div>
      </section>

      <section className="account-card">
        <h2>Wallet Overview</h2>

        {!connected ? (
          <p>
            Connect your Rialo-compatible wallet to continue.
          </p>
        ) : (
          <>
            <p className="label">Connected address</p>
            <code>
              {account?.address ?? "Address unavailable"}
            </code>

            <p className="label">Native balance</p>

            <h3>
              {isLoading
                ? "Loading balance..."
                : isError
                  ? "Balance request failed"
                  : formatted !== undefined
                    ? `${formatted} RIA`
                    : "Balance unavailable"}
            </h3>

            {isError && (
              <p className="notice">
                {error instanceof Error
                  ? error.message
                  : "An unknown balance error occurred."}
              </p>
            )}

            {!isLoading && !isError && balance === undefined && (
              <p className="notice">
                The balance query returned no balance value.
              </p>
            )}

            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching
                ? "Refreshing..."
                : "Refresh balance"}
            </button>
          </>
        )}
      </section>

      <section className="feature-card">
        <h2>One-Time Payment</h2>
        <p>
          Send an individual RLO payment from your connected
          wallet on Rialo Devnet.
        </p>
        <PaymentRuleForm />
      </section>

      <section className="feature-card">
        <h2>Recurring AutoPay Rules</h2>
        <p>
          Define a payment recipient, amount, frequency,
          schedule, and payment limit.
        </p>

        <RecurringRuleForm onRuleUpdated={updateRule} />

        <h3>Saved recurring rules</h3>

        {paymentRules.length === 0 ? (
          <p>
            No recurring rules have been saved for this wallet yet.
          </p>
        ) : (
          <div>
            {paymentRules.map((rule) => {
              const scheduledPayments =
                rule.scheduledPayments ?? [];

              const executedCount = scheduledPayments.filter(
                (payment) => payment.status === "executed",
              ).length;

              const registeredCount = scheduledPayments.filter(
                (payment) => payment.status === "registered",
              ).length;

              return (
                <article
                  className="account-card"
                  key={rule.id}
                  style={{ marginTop: "12px" }}
                >
                  <h3>{rule.amountRlo} RLO per payment</h3>

                  <p>
                    <strong>Recipient:</strong>{" "}
                    <code>{rule.recipient}</code>
                  </p>

                  <p>
                    <strong>Frequency:</strong> {rule.frequency}
                  </p>

                  <p>
                    <strong>Period:</strong>{" "}
                    {rule.startDate} to {rule.endDate}
                  </p>

                  <p>
                    <strong>Payment limit:</strong> {rule.maxPayments}
                  </p>

                  <p>
                    <strong>Rule status:</strong> {rule.status}
                  </p>

                  {scheduledPayments.length > 0 && (
                    <p>
                      <strong>Verified executed:</strong>{" "}
                      {executedCount} of {scheduledPayments.length}
                    </p>
                  )}

                  <p className="notice">
                    {rule.status === "completed"
                      ? "Every scheduled payment in this rule has been verified as executed."
                      : rule.status === "partially_registered"
                        ? "Some registrations did not complete. Review individual payment statuses below."
                        : rule.status === "failed"
                          ? "The rule or a payment has a failure. Review the details below."
                          : rule.status === "active"
                            ? "The rule has registered subscriptions. Execution status may still need verification."
                            : "The rule is not marked as fully completed."}
                  </p>

                  {scheduledPayments.length > 0 && (
                    <div>
                      <h4>Scheduled payment records</h4>

                      {scheduledPayments.map((payment) => (
                        <div
                          className="notice"
                          key={payment.nonce}
                          style={{ marginTop: "12px" }}
                        >
                          <p>
                            <strong>
                              Payment {payment.paymentNumber}
                            </strong>
                          </p>

                          <p>
                            <strong>Planned date (UTC):</strong>{" "}
                            {payment.date}
                          </p>

                          <p>
                            <strong>Status:</strong> {payment.status}
                          </p>

                          <p><strong>Nonce:</strong></p>
                          <code>{payment.nonce}</code>

                          {payment.subscriptionAddress && (
                            <>
                              <p>
                                <strong>Subscription address:</strong>
                              </p>
                              <code>
                                {payment.subscriptionAddress}
                              </code>
                            </>
                          )}

                          {payment.creationSignature && (
                            <>
                              <p>
                                <strong>Registration signature:</strong>
                              </p>
                              <code>{payment.creationSignature}</code>
                            </>
                          )}

                          {payment.triggeredSignature && (
                            <>
                              <p>
                                <strong>Verified triggered signature:</strong>
                              </p>
                              <code>{payment.triggeredSignature}</code>
                            </>
                          )}

                          {payment.triggeredBlockNumber && (
                            <p>
                              <strong>Execution block:</strong>{" "}
                              {payment.triggeredBlockNumber}
                            </p>
                          )}

                          {payment.error && (
                            <p role="alert">
                              <strong>Details:</strong> {payment.error}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {registeredCount > 0 && (
                    <p className="notice">
                      {registeredCount} subscription creation transaction(s)
                      have been confirmed. Registration verification and
                      scheduled execution are tracked separately above.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={refreshPaymentStatuses}
          disabled={
            !account ||
            chainId !== "rialo:devnet" ||
            isReconciling
          }
          style={{ marginTop: "12px" }}
        >
          {isReconciling
            ? "Verifying payments..."
            : "Refresh payment statuses"}
        </button>

        {reconcileMessage && (
          <p className="notice" role="status">
            {reconcileMessage}
          </p>
        )}

        {storageMessage && (
          <p className="notice" role="alert">
            {storageMessage}
          </p>
        )}

        <p className="notice">
          Rules are saved in this browser separately for each wallet.
          Browser storage is not an on-chain record and does not replace
          verifying a transaction on Rialo.
        </p>
      </section>

      <SubscriptionActivityPanel
        subscriberAddress={account?.address ?? ""}
      />
    </main>
  );
}

function WalletScopedDashboard() {
  const account = useActiveAccount();
  const walletAddress = account?.address;

  return (
    <AutoPayDashboard
      key={walletAddress ?? "disconnected"}
      walletAddress={walletAddress}
    />
  );
}

export default function App() {
  return (
    <FrostProvider config={frostConfig}>
      <WalletScopedDashboard />
    </FrostProvider>
  );
}

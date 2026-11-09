import { useRef, useState } from "react";
import type { PaymentRuleRecord } from "./types/paymentRule";

import {
  FrostProvider,
  ConnectButton,
  useIsConnected,
  useActiveAccount,
  useChainId,
  useNativeBalance,
} from "@rialo/frost";

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


  const trackedPayments = paymentRules.flatMap(
    (rule) => rule.scheduledPayments ?? [],
  );

  const verifiedRegistrations = trackedPayments.filter(
    (payment) =>
      payment.status === "registered" ||
      payment.status === "executed",
  ).length;

  const verifiedSettlements = trackedPayments.filter(
    (payment) => payment.status === "executed",
  ).length;

  const attentionCount = trackedPayments.filter(
    (payment) =>
      payment.status === "failed" ||
      payment.status === "verification_failed" ||
      payment.status === "verification_pending",
  ).length;

  const isDevnet = chainId === "rialo:devnet";

  const metrics = [
    {
      label: "Payment rules",
      value: paymentRules.length,
      description: "Saved rules",
    },
    {
      label: "Scheduled payments",
      value: trackedPayments.length,
      description: "Planned payment instances",
    },
    {
      label: "Verified registrations",
      value: verifiedRegistrations,
      description: "On-chain records verified",
    },
    {
      label: "Verified settlements",
      value: verifiedSettlements,
      description: "Transfers independently checked",
    },
    {
      label: "Needs attention",
      value: attentionCount,
      description: "Failed or pending verification",
    },
  ];

  function readableStatus(status: string) {
    return status.replace(/_/g, " ");
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            RA
          </div>

          <div className="brand-copy">
            <p className="brand-eyebrow">RIALO AUTOPAY</p>
            <h1>Rialo AutoPay</h1>
            <p>Reactive payments and escrow enforcement</p>
          </div>
        </div>

        <div className="topbar-actions">
          <ConnectButton />
        </div>
      </header>

      <nav className="dashboard-nav" aria-label="Dashboard navigation">
        <a href="#overview">Overview</a>
        <a href="#payments">Payment operations</a>
        <a href="#rules">Payment register</a>
        <a href="#activity">Activity</a>
      </nav>

      <section className="network-card">
        <span
          className={`status-dot ${
            connected && isDevnet ? "is-connected" : "is-disconnected"
          }`}
        />

        <div className="network-copy">
          <span className="eyebrow">ACTIVE NETWORK</span>
          <strong>
            {isDevnet
              ? "Rialo Devnet"
              : chainId || "Network unavailable"}
          </strong>
          <p>
            {connected
              ? isDevnet
                ? "Wallet connected to the target test network."
                : "Your wallet is connected to a different network."
              : "Connect a wallet to access payment operations."}
          </p>
        </div>

        <span
          className={`network-badge ${
            connected && isDevnet ? "is-online" : "is-offline"
          }`}
        >
          {connected
            ? isDevnet
              ? "DEVNET CONNECTED"
              : "WRONG NETWORK"
            : "WALLET DISCONNECTED"}
        </span>
      </section>

      <section
        id="overview"
        className="overview-grid"
        aria-label="Wallet and account overview"
      >
        <article className="account-card wallet-card">
          <div className="card-topline">
            <span className="eyebrow">ACCOUNT OVERVIEW</span>

            <span
              className={`status-pill ${
                connected ? "status-active" : "status-pending"
              }`}
            >
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>


<h2>Wallet balance</h2>

{!connected ? (
  <div className="balance-display">
    <span className="balance-amount">—</span>
  </div>
) : !isDevnet ? (
  <div className="balance-display">
    <span className="balance-amount">Wrong network</span>
  </div>
) : (
  <div className="balance-display">
    <span className="balance-amount">
      {isLoading
        ? "Loading..."
        : isError
          ? "Unavailable"
          : formatted !== undefined
            ? formatted
            : "Unavailable"}
    </span>

    {!isLoading && !isError && formatted !== undefined && (
      <span className="balance-unit">RIA</span>
    )}
  </div>
)}

<p className="balance-caption">
  {!connected
    ? "Connect a wallet to view its Rialo Devnet balance."
    : !isDevnet
      ? "Switch your wallet to Rialo Devnet to view the native token balance."
      : "Native token balance reported by Rialo Devnet."}
</p>

{connected && (
  <div className="wallet-address-block">
    <span className="eyebrow">CONNECTED ADDRESS</span>
    <code>
      {account?.address ?? "Address unavailable"}
    </code>
  </div>
)}

{isError && connected && isDevnet && (
  <p className="notice" role="alert">
    {error instanceof Error
      ? error.message
      : "An unknown balance error occurred."}
  </p>
)}

{!isLoading &&
  !isError &&
  balance === undefined &&
  connected &&
  isDevnet && (
    <p className="notice">
      The balance query returned no balance value.
    </p>
  )}

<button
  type="button"
  className="secondary-button"
  onClick={() => refetch()}
  disabled={!connected || !isDevnet || isFetching}
>
  {isFetching ? "Refreshing..." : "Refresh wallet balance"}
</button>

        </article>

        <section className="overview-metrics" aria-label="Payment statistics">
          <div className="metrics-heading">
            <div>
              <span className="eyebrow">OPERATIONAL SUMMARY</span>
              <h2>Payment activity</h2>
            </div>
            <span className="local-data-label">LOCAL RECORDS</span>
          </div>

          <div className="metrics-grid">
            {metrics.map((metric) => (
              <article className="metric-card" key={metric.label}>
                <span className="metric-label">{metric.label}</span>
                <strong className="metric-value">
                  {metric.value.toLocaleString("en-US")}
                </strong>
                <span className="metric-description">
                  {metric.description}
                </span>
              </article>
            ))}
          </div>
        </section>
      </section>

      <p className="data-source-note">
        The wallet balance is retrieved from Rialo Devnet. Payment statistics
        are calculated from this browser's saved payment records; they are
        not independent on-chain account totals.
      </p>

      <section
        id="payments"
        className="workspace-grid"
        aria-label="Payment operations"
      >
        <div className="workspace-column">
          <div className="workspace-label">
            <span className="workspace-number">01</span>
            <div>
              <span className="eyebrow">DIRECT TRANSFER</span>
              <h2>One-time payment</h2>
            </div>
          </div>

          <PaymentRuleForm />
        </div>

        <div className="workspace-column">
          <div className="workspace-label">
            <span className="workspace-number">02</span>
            <div>
              <span className="eyebrow">REACTIVE AUTOMATION</span>
              <h2>Recurring AutoPay</h2>
            </div>
          </div>

          <RecurringRuleForm onRuleUpdated={updateRule} />
        </div>
      </section>

      <section
        id="rules"
        className="feature-card records-panel"
        aria-labelledby="records-title"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">PAYMENT OPERATIONS</span>
            <h2 id="records-title">Saved payment register</h2>
            <p>
              Inspect registered schedules, their subscription addresses
              and verified execution references.
            </p>
          </div>

          <button
            type="button"
            onClick={refreshPaymentStatuses}
            disabled={!account || !isDevnet || isReconciling}
          >
            {isReconciling
              ? "Verifying payments..."
              : "Refresh payment statuses"}
          </button>
        </div>

        {paymentRules.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-mark">—</span>
            <h3>No saved payment rules</h3>
            <p>
              Create a payment schedule to begin tracking subscription
              registrations and settlement records.
            </p>
          </div>
        ) : (
          <div className="rule-list">
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
                <article className="rule-card" key={rule.id}>
                  <div className="rule-card-header">
                    <div>
                      <span className="eyebrow">
                        {rule.frequency.toUpperCase()} PAYMENT RULE
                      </span>

                      <h3>
                        {rule.amountRlo} RLO
                        <span className="rule-unit"> per payment</span>
                      </h3>
                    </div>

                    <span
                      className={`status-pill status-${rule.status}`}
                    >
                      {readableStatus(rule.status)}
                    </span>
                  </div>

                  <div className="rule-metadata">
                    <div className="rule-meta-item rule-recipient">
                      <span className="eyebrow">RECIPIENT</span>
                      <code>{rule.recipient}</code>
                    </div>

                    <div className="rule-meta-item">
                      <span className="eyebrow">FREQUENCY</span>
                      <strong>{readableStatus(rule.frequency)}</strong>
                    </div>

                    <div className="rule-meta-item">
                      <span className="eyebrow">SCHEDULE PERIOD (UTC)</span>
                      <strong>
                        {rule.startDate} – {rule.endDate}
                      </strong>
                    </div>

                    <div className="rule-meta-item">
                      <span className="eyebrow">PAYMENT LIMIT</span>
                      <strong>
                        {rule.maxPayments.toLocaleString("en-US")}
                      </strong>
                    </div>
                  </div>

                  <div className="rule-progress">
                    <div>
                      <span className="eyebrow">VERIFIED EXECUTION</span>
                      <strong>
                        {executedCount} / {scheduledPayments.length}
                      </strong>
                    </div>

                    <div>
                      <span className="eyebrow">
                        REGISTERED, NOT YET EXECUTED
                      </span>
                      <strong>{registeredCount}</strong>
                    </div>

                    <div>
                      <span className="eyebrow">SCHEDULED INSTANCES</span>
                      <strong>{scheduledPayments.length}</strong>
                    </div>
                  </div>

                  <p className="rule-message">
                    {rule.status === "completed"
                      ? "Every scheduled payment in this rule has been verified as executed."
                      : rule.status === "partially_registered"
                        ? "Some registrations did not complete. Review the individual payment records."
                        : rule.status === "failed"
                          ? "A rule or payment failure was recorded. Inspect the details below."
                          : rule.status === "active"
                            ? "The subscription registrations are verified. Scheduled transfers still require execution verification."
                            : "This rule is not marked as fully completed."}
                  </p>

                  {scheduledPayments.length > 0 && (
                    <details className="schedule-details">
                      <summary>
                        Inspect scheduled payment records (
                        {scheduledPayments.length})
                      </summary>

                      <div className="schedule-records">
                        {scheduledPayments.map((payment) => (
                          <article
                            className="schedule-record"
                            key={payment.nonce}
                          >
                            <div className="schedule-record-header">
                              <div>
                                <span className="eyebrow">
                                  PAYMENT {payment.paymentNumber}
                                </span>
                                <strong>{payment.date} UTC</strong>
                              </div>

                              <span
                                className={`status-pill status-${payment.status}`}
                              >
                                {readableStatus(payment.status)}
                              </span>
                            </div>

                            <div className="schedule-record-data">
                              <div>
                                <span className="eyebrow">NONCE</span>
                                <code>{payment.nonce}</code>
                              </div>

                              {payment.subscriptionAddress && (
                                <div>
                                  <span className="eyebrow">
                                    SUBSCRIPTION ADDRESS
                                  </span>
                                  <code>{payment.subscriptionAddress}</code>
                                </div>
                              )}

                              {payment.creationSignature && (
                                <div>
                                  <span className="eyebrow">
                                    CREATION SIGNATURE
                                  </span>
                                  <code>{payment.creationSignature}</code>
                                </div>
                              )}

                              {payment.triggeredSignature && (
                                <div>
                                  <span className="eyebrow">
                                    TRIGGERED TRANSACTION
                                  </span>
                                  <code>{payment.triggeredSignature}</code>
                                </div>
                              )}

                              {payment.triggeredBlockNumber && (
                                <div>
                                  <span className="eyebrow">
                                    EXECUTION BLOCK
                                  </span>
                                  <strong>
                                    {payment.triggeredBlockNumber}
                                  </strong>
                                </div>
                              )}

                              {payment.error && (
                                <div className="record-error">
                                  <span className="eyebrow">DETAILS</span>
                                  <p role="alert">{payment.error}</p>
                                </div>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}

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

        <p className="data-source-note">
          Rules are stored in this browser separately for each wallet.
          Browser storage is not an on-chain record and does not replace
          verifying a transaction on Rialo.
        </p>
      </section>

      <section
        id="activity"
        className="activity-section"
        aria-labelledby="activity-heading"
      >
        <div className="section-heading activity-heading">
          <div>
            <span className="eyebrow">NETWORK INSPECTION</span>
            <h2 id="activity-heading">
              Subscription and transaction activity
            </h2>
            <p>
              Inspect native subscription records, triggered transactions
              and sender/recipient account histories.
            </p>
          </div>
        </div>

        <SubscriptionActivityPanel
          subscriberAddress={account?.address ?? ""}
        />
      </section>

      <footer className="dashboard-footer">
        <span>RIALO AUTOPAY</span>
        <span>Rialo Devnet · Reactive payment operations</span>
      </footer>
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

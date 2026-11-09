# RIALO AUTOPAY
## Client Operating Guide

**Product:** RialoAutoPay
**Network:** Rialo Devnet
**Document version:** 1.0
**Prepared:** 9 November 2026

---

## 1. Introduction

RialoAutoPay is a payment scheduling and subscription management application built around the Rialo blockchain ecosystem.

It enables an authorized wallet operator to configure scheduled payment instructions, register those instructions as native Rialo OneShot subscriptions, and inspect their on-chain execution records.

The application provides:

- Rialo Devnet wallet connection.
- Native wallet balance display.
- One-time RLO transfers.
- Daily, weekly, and monthly payment scheduling.
- On-chain OneShot subscription registration.
- Subscription record inspection.
- Triggered transaction history.
- Independent verification of payment recipient and amount.
- Payer and recipient transaction history.
- Subscription cancellation where an active record is available.

**Important:** This release operates on Rialo Devnet. It is not a production-mainnet payment service.

## 2. Accessing the application

Open the application using the URL provided by the project administrator.

A compatible wallet must be available and connected through the application's wallet connection interface.

### Network requirement

The wallet must be connected to **Rialo Devnet** before payment or subscription operations can be performed.

The dashboard displays the active network and wallet connection status.

The expected network status is:

**DEVNET CONNECTED**

When the wallet is disconnected or connected to another network:

- The application identifies the incorrect connection state.
- The Devnet balance is not displayed as though it belonged to the active network.
- Balance refresh is disabled outside Rialo Devnet.
- Payment registration and transaction operations are restricted by network checks.

## 3. Wallet and balance management

The Wallet Balance panel displays the native balance returned by Rialo Devnet.

The connected wallet address is displayed beneath the balance.

The operator can use **Refresh wallet balance** to request an updated balance while connected to the correct network.

The balance display uses the application's native token unit label. Payment amounts entered in payment forms are denominated in RLO.

The payer should maintain sufficient Devnet funds to cover scheduled transfers and applicable network fees when execution occurs.

**Registration is not an escrow deposit or a reservation of funds.** The application registers payment instructions; it does not establish a separate custodial account holding the scheduled payment amount.

## 4. Sending a one-time payment

The Send a Devnet Payment section is used for individual transfers.

Procedure:

1. Connect the payer wallet.
2. Confirm that Rialo Devnet is active.
3. Enter the recipient's Rialo address.
4. Enter the payment amount in RLO.
5. Select **Review payment**.
6. Review the payer, recipient, amount, and network details.
7. Select **Authorize and send**.
8. Review and approve the transaction in the connected wallet.

After submission and confirmation, the application displays the returned transaction signature.

Retain this signature as the transaction reference.

This operation sends an individual transfer. It does not create a recurring payment schedule.

## 5. Creating a recurring payment schedule

The Create Recurring Payment section allows an operator to configure a schedule.

The available fields are:

| Field | Description |
|---|---|
| Recipient address | Destination wallet |
| Amount per payment | Amount in RLO |
| Frequency | Daily, weekly, or monthly |
| Start date | Beginning of the schedule, in UTC |
| End date | End of the schedule, in UTC |
| Maximum number of payments | Upper limit on planned payments |

### Reviewing the schedule

After entering the required information, inspect the Payment Schedule Preview.

The preview displays:

- Number of planned payments.
- Selected frequency.
- Planned payment dates.
- Estimated combined payment amount.

The preview shows up to the first eight scheduled dates. Additional planned dates are included in the schedule count but may not be displayed individually in the preview.

Dates are interpreted using UTC calendar-day boundaries.

### Registering the schedule

Select **Review and register schedule**.

The application prepares the planned payment registrations.

Each scheduled payment is registered as its own native Rialo OneShot subscription.

The wallet must authorize each registration transaction separately.

For each registration:

1. Review the transaction in the wallet.
2. Approve the registration.
3. Allow the application to confirm the transaction.
4. Allow the application to verify the stored subscription record.

The application does not mark a registration as successfully verified merely because a transaction was submitted. It checks the resulting on-chain subscription record.

A schedule may be partially registered if some registration transactions succeed and others do not. Review the individual payment records and their statuses.

**Important distinction:** Registering a payment does not mean that the scheduled transfer has already executed.

## 6. Understanding payment statuses

The payment register provides operational information about each scheduled payment.

| Status | Meaning |
|---|---|
| Verification pending | Registration or execution information still requires verification |
| Verification failed | The relevant verification could not be completed successfully |
| Registered | The subscription registration has been verified |
| Executed | The triggered transfer has passed the application's payment verification |
| Failed | An execution failure has been recorded |

A registered payment is not necessarily an executed payment.

The dashboard separates verified registrations from verified settlements so that operators do not mistake a scheduled instruction for a completed transfer.

## 7. Refreshing payment statuses

The Saved Payment Register includes a **Refresh payment statuses** action.

This requests updated information from Rialo Devnet.

The application attempts to:

- Reverify previously executed payments.
- Check pending subscription registrations.
- Retrieve triggered transactions.
- Verify matching payment transactions.
- Update saved payment records.

The application limits a refresh operation to 50 individual payment checks.

An RPC timeout or temporary network problem does not automatically mean that an on-chain payment failed.

Previously verified execution status is preserved when temporary RPC errors prevent a subsequent verification.

## 8. Subscription Activity and transaction verification

The Subscription Activity section provides a detailed inspection facility.

The operator can supply:

- Subscription nonce.
- Recipient address, when required.
- Expected payment amount in RLO.

The subscriber wallet must be connected to Rialo Devnet.

Select **Check subscription and histories** to retrieve available information.

The activity panel displays four principal areas.

### A. Subscription lookup

Displays the derived subscription address and any active subscription record returned by Rialo.

The stored record can be inspected to review the subscription configuration.

A missing active subscription does not necessarily mean that no payment occurred. OneShot subscriptions may be removed after execution.

### B. Subscription-triggered transactions

Displays transactions returned for the subscription account.

The application can verify a triggered transaction against the expected payment details, including:

- Payer address.
- Recipient address.
- Transfer amount.
- Transaction execution information.
- Matching System Program transfer instruction.

A successful settlement verification requires the transaction to match the expected payment details.

A signature appearing in transaction history by itself is not sufficient proof of the intended payment.

### C. Sender transaction history

Displays transaction signatures associated with the payer account, together with available block information and execution-result information.

### D. Recipient transaction history

Displays transaction signatures associated with the recipient account.

**Important:** General sender and recipient histories are supporting information. They are not, by themselves, proof that a particular scheduled payment was settled. Use the triggered transaction verification result to establish whether a payment matches its expected details.

## 9. Unsubscribing from a registration

An active subscription record can be unsubscribed through the Subscription Activity panel.

The operator must:

1. Retrieve the active subscription.
2. Confirm that the correct registration is being inspected.
3. Select **Unsubscribe this registration**.
4. Review the confirmation message.
5. Approve the unsubscribe transaction through the connected wallet.

Unsubscription affects the active registration.

It does not reverse a transfer that has already executed.

If a OneShot subscription is no longer active, the application cannot use this panel to unsubscribe that registration.

## 10. Local records and data retention

The application's saved payment register is maintained in browser-local storage and scoped to the connected wallet address.

This means:

- Different wallets have separate saved records.
- Records are associated with the browser and application origin.
- Browser data clearing may remove locally saved records.
- Local records are not automatically synchronized across different devices or browsers.

Relevant on-chain subscription and transaction information remains subject to Rialo network availability and the network's own record-retention behavior.

Operators should retain important transaction signatures and payment records independently.

## 11. Troubleshooting

### Wallet disconnected

Reconnect the wallet using the wallet connection control.

### Wrong network

Switch the connected wallet to Rialo Devnet and confirm the network indicator.

### Balance unavailable

Check that:

- The wallet is connected.
- Rialo Devnet is selected.
- The RPC service is reachable.

Use the balance refresh control to retry.

### Subscription registration not verified

Check the transaction submission result and the subscription address.

Retry verification only after checking whether the original registration has already been submitted. Do not create duplicate registrations simply because a temporary RPC error occurred.

### No triggered transactions returned

Confirm the nonce and subscription address.

Check that the scheduled UTC date has been reached and that the network has returned the relevant triggered transaction records.

A lack of returned history is not proof of execution or failure.

### RPC timeout

RPC requests have a 15-second timeout.

A timeout indicates that the application could not obtain a response in time. It does not establish that an on-chain transaction failed.

Retry the relevant read or verification operation after checking the network connection.

### Payment verification failed

Inspect the verification error, transaction signature, expected recipient, payer, and amount.

Do not mark the payment as settled unless the payment verification succeeds.

## 12. Current release scope and limitations

This release provides structured payment scheduling and native Rialo OneShot subscription functionality.

The following distinctions are important:

- The interface uses structured payment fields; a natural-language AI payment-authoring interface is not exposed in this release.
- The current implementation executes scheduled transfer instructions; it does not provide independent custodial escrow, dispute arbitration, or a refund mechanism.
- The application is configured for Rialo Devnet, not Rialo Mainnet.
- Browser-local records are not a shared enterprise database.
- Network availability and successful execution remain dependent on Rialo Devnet and the relevant on-chain execution conditions.

The application should therefore be described as a Rialo Devnet reactive payment and subscription management tool, not as a production escrow custody platform.

## 13. Live acceptance test reference

A real OneShot subscription has already been registered on Rialo Devnet for the project's live execution acceptance test.

The existing registration must be inspected rather than recreated.

| Reference | Value |
|---|---|
| Network | Rialo Devnet |
| Payment amount | 0.001 RLO |
| Scheduled UTC date | 11 November 2026 |
| Subscription type | OneShot |
| Payer | `CtDnA9dNEF5D3nJ2EyUdN1Tvqcjkok5jihrLyuWzZ6Ko` |
| Recipient | `3f6L7jBBdPEKJf7v1rb9fNLhYetSw85Cwv79srGnsWrZ` |
| Subscription nonce | `8abedd28ddfc476fb508cd410000` |
| Subscription address | `DaRawAaujq4hXFAwAGjhdfVWj12gPGiWSZbvzjPJyy1C` |
| Registration transaction | `2LZqpM3kChJdoRWSDHEQfFCYKxL69a1WpaejQ2qVCP5FyZ39TFfBwKG7dH4Bp33y81nySnVhMCTQpeUF6qHvraa` |

### Acceptance-test status as at 9 November 2026

The subscription registration was confirmed through an on-chain subscription record readback.

The scheduled execution date is still in the future as at the preparation date of this document.

Consequently:

- Registration is verified.
- Settlement has not yet been verified.
- No triggered payment signature is being represented as confirmed.
- The existing registration must not be duplicated or cancelled before the acceptance test.

On 11 November 2026, retrieve the triggered transaction history and verify the actual transfer against the expected payer, recipient, and 0.001 RLO amount.

Only after successful transaction verification should the payment be recorded as settled and the live acceptance test be marked complete.

## 14. Technical verification summary

The current development release has passed the following automated checks:

| Verification | Result |
|---|---:|
| Subscription builder tests | 17 passed |
| Subscription verification tests | 20 passed |
| Triggered transaction tests | 16 passed |
| Transaction history and RPC tests | 7 passed |
| Total automated tests | 60 passed |
| Rust/TypeScript serialization comparison | Exact 207-byte match |
| Production build | Passed |
| Lint | 0 warnings, 0 errors |

These results demonstrate that the tested application logic builds and passes its automated test suite. They do not replace the pending live Devnet settlement acceptance test described above.

---

**End of Client Operating Guide**

RialoAutoPay — Rialo Devnet Payment Operations
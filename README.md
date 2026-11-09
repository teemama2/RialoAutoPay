
# RialoAutoPay

RialoAutoPay is a React and TypeScript application for scheduled payments, native subscription registration, and transaction verification on Rialo Devnet.

> **Network status:** This release is configured for Rialo Devnet. It is not a production-mainnet payment service.

## Documentation

- [Client Operating Guide](CLIENT-OPERATING-GUIDE.md) — application access, wallet operations, payment scheduling, transaction verification, troubleshooting, and acceptance testing.

## Current capabilities

- Connect a wallet through Rialo Frost.
- Retrieve the connected wallet's native Devnet balance.
- Prepare and submit individual RLO transfers with wallet approval.
- Configure daily, weekly, and monthly payment schedules.
- Register each scheduled payment as an independent native OneShot subscription.
- Verify stored subscription registrations on-chain.
- Inspect subscription records and triggered transactions.
- Verify triggered transfers against the expected payer, recipient, and amount.
- Inspect payer and recipient transaction histories.
- Refresh saved payment execution statuses.

## Important implementation boundaries

- Registration and settlement are separate states. A successfully registered subscription is not proof that a payment has executed.
- Each scheduled payment requires a separate wallet approval during registration.
- The application does not provide custodial escrow, dispute arbitration, or a refund mechanism.
- Saved payment records use browser-local storage and are not a shared enterprise database.
- The current interface does not expose a natural-language AI payment-authoring feature.
- Production deployment requires an appropriate server-side `/rialo-rpc` proxy. The proxy in `vite.config.ts` is configured for the Vite development server.

## Technology stack

- React 19
- TypeScript 6
- Vite 8
- Rialo TypeScript CDK 0.18.1
- Rialo Frost 0.18.1
- Rust and Cargo for the subscription serialization reference

## Requirements

- Node.js
- npm
- Rust and Cargo for the Rust reference serialization check

## Installation

Clone the repository:

```bash
git clone https://github.com/teemama2/RialoAutoPay.git
cd RialoAutoPay
```

Install dependencies:

```bash
npm install
```

## Run the development server

```bash
npm run dev
```

Open the local URL printed by Vite.

The development server uses the `/rialo-rpc` proxy configured in `vite.config.ts` to communicate with Rialo Devnet.

## Verification commands

Production build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Subscription builder, verification, and serialization tests:

```bash
npm run test:subscriptions
```

Triggered transaction and transaction history tests:

```bash
npm run test:transactions
```

## Project structure

```text
RialoAutoPay/
├── src/
│   ├── App.tsx
│   ├── App.css
│   ├── PaymentRuleForm.tsx
│   ├── RecurringRuleForm.tsx
│   ├── SubscriptionActivityPanel.tsx
│   ├── frost.config.ts
│   ├── lib/
│   │   ├── paymentSchedule.ts
│   │   ├── rialoClient.ts
│   │   ├── subscriptionBuilder.ts
│   │   ├── subscriptionMonitor.ts
│   │   └── subscriptionVerification.ts
│   └── types/
│       └── paymentRule.ts
├── tools/
│   ├── rialo-subscription-reference/
│   ├── test-subscription-builder.ts
│   ├── test-subscription-verification.ts
│   ├── test-subscription-serialization.mjs
│   ├── test-triggered-transaction.ts
│   └── test-transaction-history.ts
├── CLIENT-OPERATING-GUIDE.md
├── package.json
├── vite.config.ts
└── README.md
```

## Security and operational notes

- Never share wallet recovery phrases or private keys.
- Review recipient addresses and payment amounts before approving wallet transactions.
- Confirm Rialo Devnet is active before performing payment operations.
- Retain important transaction signatures independently.
- Do not interpret a temporary RPC error as proof of transaction failure.
- Verify settlement using the transaction verification facility before reporting a payment as completed.

## Current verification baseline

The development release has passed:

- 17 subscription builder tests.
- 20 subscription verification tests.
- 16 triggered transaction tests.
- 7 transaction history and RPC tests.
- Exact 207-byte TypeScript/Rust serialization comparison.
- Production build.
- Lint with zero warnings and errors.

These are development verification results, not a substitute for the live Devnet settlement acceptance test.

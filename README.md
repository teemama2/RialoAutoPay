\# RialoAutoPay



RialoAutoPay is a React and TypeScript application being developed around the Rialo ecosystem for recurring payment rules and subscription management.



\## Technology Stack



\- React 19

\- TypeScript 6

\- Vite 8

\- Rialo TypeScript CDK 0.18.1

\- Rialo Frost 0.18.1

\- Rust

\- Cargo



\## Project Structure



\- `src/` - Main application source code.

\- `src/lib/` - Payment scheduling, Rialo client, subscription builder and monitoring logic.

\- `src/types/` - Application TypeScript types.

\- `tools/rialo-subscription-reference/` - Rust subscription serialization reference.

\- `tools/test-subscription-serialization.mjs` - TypeScript serialization comparison.

\- `test-payment-schedule.ts` - Payment schedule test.



\## Requirements



\- Node.js

\- npm

\- Rust and Cargo (for the Rust reference test)



\## Installation



Clone the repository:



```bash

git clone https://github.com/teemama2/RialoAutoPay.git

cd RialoAutoPay

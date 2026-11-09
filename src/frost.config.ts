
import {
  createConfig,
  getDefaultRialoClientConfig,
} from "@rialo/frost";

const defaultDevnetConfig = getDefaultRialoClientConfig("devnet");

export const frostConfig = createConfig({
  clientConfig: {
    ...defaultDevnetConfig,
    chain: {
      ...defaultDevnetConfig.chain,
      rpcUrl: "/rialo-rpc",
    },
  },
  autoConnect: true,
});

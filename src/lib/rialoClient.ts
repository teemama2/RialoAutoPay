
import {
  createRialoClient,
  RIALO_DEVNET_CHAIN,
} from "@rialo/ts-cdk";

const proxiedDevnetChain = {
  ...RIALO_DEVNET_CHAIN,
  rpcUrl: "/rialo-rpc",
};

export const rialoClient = createRialoClient({
  chain: proxiedDevnetChain,
});

export async function verifyRialoConnection() {
  const configHashPrefix =
    await rialoClient.getConfigHashPrefix();

  return {
    connected: true,
    network: "Rialo Devnet",
    configHashPrefix,
  };
}

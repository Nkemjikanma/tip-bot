import { Alchemy, Network } from "alchemy-sdk";
import { http, createPublicClient, formatEther } from "viem";
import { base, mainnet } from "viem/chains";

export const alchemyApiKey = process.env.ALCHEMY_API_KEY;
export const networkURL = process.env.RPC_URL;

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(networkURL),
});

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export async function getBotUsdcBalance(botAddress: `0x${string}`) {
  const balance = await publicClient.getBalance({
    address: botAddress as `0x${string}`,
    blockTag: "latest",
  });

  return formatEther(BigInt(balance));
}

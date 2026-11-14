// Creates the relayer's Base Sepolia key (testnet only; git-ignored .env.testnet) and prints its address.
// The relayer only submits NEAR-MPC-signed USDC transfers to Base; it pays gas and can't move anyone's USDC.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readDeploy, readEnv, setDeploy, setEnv } from "./lib.ts";
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
if (!readEnv().RELAYER_EVM_KEY) {
  const sk = secp256k1.utils.randomSecretKey();
  setEnv("RELAYER_EVM_KEY", hex(sk));
  setDeploy({ relayer_evm: hex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(12)) });
}
console.log(`relayer: ${readDeploy().relayer_evm}`);
console.log(`payout wallet: ${readDeploy().float_address}`);

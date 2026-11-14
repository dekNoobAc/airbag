// Tops up the testnet root with faucet NEAR: a throwaway account from the public faucet helper is deleted with
// the root as beneficiary, which moves all its NEAR to the root.   pnpm -C scripts exec tsx src/topup-root.ts
import { actions } from "near-api-js";
import { acct, balance, faucetAccount, readDeploy, say, send } from "./lib.ts";
const d = readDeploy();
say(`${d.root}: ${(Number(await balance(d.root)) / 1e24).toFixed(2)} NEAR`);
const id = `airbag-gas-${Date.now().toString(36)}.testnet`;
const key = await faucetAccount(id);
say(`${id}: ${(Number(await balance(id)) / 1e24).toFixed(2)} NEAR from the faucet`);
const r = await send(acct(id, key), id, [actions.deleteAccount(d.root)]);
say(`deleted ${id}, NEAR sent to ${d.root} (${r.tx})`);
say(`${d.root}: ${(Number(await balance(d.root)) / 1e24).toFixed(2)} NEAR`);

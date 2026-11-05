/** npm run keys - fresh wallets for .env. Never reuse these on mainnet without a hardware wallet. */
import { Wallet } from "ethers";

for (const name of ["OPERATOR_PRIVATE_KEY", "ROBOT_PRIVATE_KEY"]) {
  const w = Wallet.createRandom();
  console.log(`${name}=${w.privateKey}   # ${w.address}`);
}
console.log("\nFund the OPERATOR address on Galileo: https://faucet.0g.ai (0.1 0G/day). The robot key needs no funds.");

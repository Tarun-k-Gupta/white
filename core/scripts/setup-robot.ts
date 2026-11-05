/**
 * Register the robot on zerobot's RobotRegistry and make the robot key an operator.
 *   npm run setup:robot
 * Galileo: uses zerobot's deployed registry (0x2911…73bb). Local/mainnet: SimpleRobotRegistry.
 * Idempotent. Prints the ROBOT_ID to put in .env.
 */
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { loadConfig } from "../src/config";
import { ROBOT_REGISTRY_ABI } from "../src/chain/abi";

const cfg = loadConfig();
const c = cfg.chain;
if (!c.enabled) throw new Error("CHAIN=none: nothing to set up");
if (!c.operatorKey) throw new Error("OPERATOR_PRIVATE_KEY is not set");
if (!process.env.ROBOT_PRIVATE_KEY) throw new Error("ROBOT_PRIVATE_KEY is not set (npm run keys)");

const provider = new JsonRpcProvider(c.network.rpc, c.network.chainId, { staticNetwork: true });
const owner = new Wallet(c.operatorKey, provider);
const robot = new Wallet(process.env.ROBOT_PRIVATE_KEY).address;
const name = process.env.ROBOT_NAME ?? "blackbox-drone-1";
const robotId = c.robotId || keccak256(toUtf8Bytes(name));
const reg = new Contract(c.robotRegistry, ROBOT_REGISTRY_ABI, owner);

console.log(`network        ${c.network.name} (${c.network.chainId})`);
console.log(`RobotRegistry  ${c.robotRegistry}`);
console.log(`owner wallet   ${owner.address} (${Number(await provider.getBalance(owner.address)) / 1e18} 0G)`);
console.log(`robot key      ${robot}`);
console.log(`robot id       ${robotId} (${name})`);

const r = await reg.getRobot(robotId);
if (r.owner === "0x0000000000000000000000000000000000000000") {
  const tx = await reg.registerRobot(robotId, name, "blackbox-sim-drone", "0x" + "00".repeat(32));
  await tx.wait();
  console.log(`registerRobot  ${tx.hash}`);
} else if (r.owner.toLowerCase() !== owner.address.toLowerCase()) {
  throw new Error(`robot id is owned by ${r.owner}; set a different ROBOT_NAME or ROBOT_ID`);
} else console.log("registerRobot  already registered");

if (!(await reg.isOperator(robotId, robot))) {
  const tx = await reg.addOperator(robotId, robot);
  await tx.wait();
  console.log(`addOperator    ${tx.hash}`);
} else console.log("addOperator    robot key already an operator");

console.log(`\nAdd to .env:\nROBOT_ID=${robotId}`);

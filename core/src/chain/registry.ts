import { Contract, JsonRpcProvider, Wallet } from "ethers";
import type { Config } from "../config";
import { BLACKBOX_REGISTRY_ABI, ROBOT_REGISTRY_ABI, toChainAnchors, toChainMission } from "./abi";

export class RegistryClient {
  readonly provider: JsonRpcProvider;
  readonly wallet: Wallet | null;
  readonly registry: Contract;
  readonly robots: Contract;

  constructor(private cfg: Config["chain"]) {
    if (!cfg.registry) throw new Error("BLACKBOX_REGISTRY is not set (deploy contracts first, see README)");
    if (!cfg.robotRegistry) throw new Error("ROBOT_REGISTRY is not set");
    this.provider = new JsonRpcProvider(cfg.network.rpc, cfg.network.chainId, { staticNetwork: true });
    this.wallet = cfg.operatorKey ? new Wallet(cfg.operatorKey, this.provider) : null;
    const runner = this.wallet ?? this.provider;
    this.registry = new Contract(cfg.registry, BLACKBOX_REGISTRY_ABI, runner);
    this.robots = new Contract(cfg.robotRegistry, ROBOT_REGISTRY_ABI, runner);
  }

  txUrl(tx: string) {
    return this.cfg.network.explorer ? `${this.cfg.network.explorer}/tx/${tx}` : null;
  }

  addressUrl(a: string) {
    return this.cfg.network.explorer ? `${this.cfg.network.explorer}/address/${a}` : null;
  }

  private async send(fn: string, args: unknown[]): Promise<string> {
    if (!this.wallet) throw new Error("OPERATOR_PRIVATE_KEY is not set");
    const tx = await this.registry[fn](...args);
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error(`${fn} reverted (${tx.hash})`);
    return tx.hash as string;
  }

  registerMission(missionId: string, robotId: string, robot: string, seedHash: string, manifestRoot: string, genesisHash: string) {
    return this.send("registerMission", [missionId, robotId, robot, seedHash, manifestRoot, genesisHash]);
  }

  anchor(missionId: string, count: number, head: string, indexRoot: string, sig: string) {
    return this.send("anchor", [missionId, count, head, indexRoot, sig]);
  }

  close(missionId: string, count: number, head: string, indexRoot: string, trajectoryHash: string, sig: string) {
    return this.send("closeMission", [missionId, count, head, indexRoot, trajectoryHash, sig]);
  }

  async getMission(missionId: string) {
    return toChainMission(await this.registry.getMission(missionId));
  }

  async getAnchors(missionId: string) {
    return toChainAnchors(await this.registry.getAnchors(missionId));
  }

  async isOperator(robotId: string, who: string): Promise<boolean> {
    return this.robots.isOperator(robotId, who);
  }
}

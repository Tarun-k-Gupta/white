/** Human-readable ABIs (browser-safe, shared with the verifier). Matches contracts/src. */
export const BLACKBOX_REGISTRY_ABI = [
  "function registerMission(bytes32 missionId, bytes32 robotId, address robot, bytes32 seedHash, bytes32 manifestRoot, bytes32 genesisHash)",
  "function anchor(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes robotSig)",
  "function closeMission(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes32 trajectoryHash, bytes robotSig)",
  "function getMission(bytes32 missionId) view returns (tuple(bytes32 robotId, address robot, address operator, bytes32 seedHash, bytes32 manifestRoot, bytes32 genesisHash, bytes32 head, bytes32 indexRoot, bytes32 trajectoryHash, uint64 count, uint64 startedAt, uint64 closedAt))",
  "function getAnchors(bytes32 missionId) view returns (tuple(uint64 count, uint64 timestamp, bytes32 head, bytes32 indexRoot)[])",
  "function missionsOf(bytes32 robotId) view returns (bytes32[])",
  "function robotRegistry() view returns (address)",
  "function anchorDigest(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot) view returns (bytes32)",
  "event MissionRegistered(bytes32 indexed missionId, bytes32 indexed robotId, address indexed robot, address operator, bytes32 seedHash, bytes32 manifestRoot, bytes32 genesisHash)",
  "event Anchored(bytes32 indexed missionId, uint256 indexed anchorIndex, uint64 count, bytes32 head, bytes32 indexRoot)",
  "event MissionClosed(bytes32 indexed missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes32 trajectoryHash)",
  "error ZeroAddress()",
  "error MissionExists()",
  "error UnknownMission()",
  "error MissionClosedAlready()",
  "error RobotNotOperator()",
  "error NotRobotOwnerOrOperator()",
  "error StaleCount()",
  "error BadSignature()",
];

/** zerobot RobotRegistry subset (also implemented by contracts/src/SimpleRobotRegistry.sol). */
export const ROBOT_REGISTRY_ABI = [
  "function registerRobot(bytes32 robotId, string name, string robotType, bytes32 storageRoot)",
  "function addOperator(bytes32 robotId, address operator)",
  "function removeOperator(bytes32 robotId, address operator)",
  "function isOperator(bytes32 robotId, address caller) view returns (bool)",
  "function getRobot(bytes32 robotId) view returns (tuple(address owner, string name, string robotType, bytes32 storageRoot, bool active, bool publicCommands, uint256 registeredAt))",
];

export interface ChainMission {
  robotId: string;
  robot: string;
  operator: string;
  seedHash: string;
  manifestRoot: string;
  genesisHash: string;
  head: string;
  indexRoot: string;
  trajectoryHash: string;
  count: number;
  startedAt: number;
  closedAt: number;
}

export interface ChainAnchor {
  count: number;
  timestamp: number;
  head: string;
  indexRoot: string;
}

export function toChainMission(m: any): ChainMission | null {
  if (!m || m.robot === "0x0000000000000000000000000000000000000000") return null;
  return {
    robotId: m.robotId,
    robot: m.robot,
    operator: m.operator,
    seedHash: m.seedHash,
    manifestRoot: m.manifestRoot,
    genesisHash: m.genesisHash,
    head: m.head,
    indexRoot: m.indexRoot,
    trajectoryHash: m.trajectoryHash,
    count: Number(m.count),
    startedAt: Number(m.startedAt),
    closedAt: Number(m.closedAt),
  };
}

export const toChainAnchors = (a: any[]): ChainAnchor[] =>
  a.map((x) => ({ count: Number(x.count), timestamp: Number(x.timestamp), head: x.head, indexRoot: x.indexRoot }));

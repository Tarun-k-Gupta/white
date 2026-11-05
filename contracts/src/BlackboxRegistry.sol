// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IRobotRegistry} from "./interfaces/IRobotRegistry.sol";

/// @title BlackboxRegistry
/// @notice Public index of Blackbox inspection missions. Each mission points at
///         its manifest and episode log on 0G Storage and pins the head of the
///         robot-signed keccak256 hash chain at regular checkpoints.
/// @dev    Robot identity comes from zerobot's RobotRegistry: the robot's signing
///         key must be an operator of its zerobot robot id. Anchors and closes
///         carry an EIP-191 signature by that key, so any wallet may relay them
///         (the robot itself never needs gas), but only the robot can author them.
contract BlackboxRegistry {
    bytes32 public constant ANCHOR_TYPEHASH = keccak256("BLACKBOX_ANCHOR_V1");
    bytes32 public constant CLOSE_TYPEHASH = keccak256("BLACKBOX_CLOSE_V1");

    /// @dev secp256k1n / 2, upper bound for a non-malleable `s`.
    uint256 private constant _HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IRobotRegistry public immutable robotRegistry;

    struct Mission {
        bytes32 robotId; // zerobot robot id
        address robot; // robot signing key (a zerobot operator of robotId)
        address operator; // wallet that registered the mission
        bytes32 seedHash; // keccak256 of the sim seed / mission seed
        bytes32 manifestRoot; // 0G Storage root of the mission manifest
        bytes32 genesisHash; // hash of log entry 0 (mission_start)
        bytes32 head; // latest anchored chain head
        bytes32 indexRoot; // 0G Storage root of the latest log index
        bytes32 trajectoryHash; // set on close
        uint64 count; // number of log entries covered by `head`
        uint64 startedAt;
        uint64 closedAt; // 0 while open
    }

    struct Anchor {
        uint64 count;
        uint64 timestamp;
        bytes32 head;
        bytes32 indexRoot;
    }

    mapping(bytes32 missionId => Mission) private _missions;
    mapping(bytes32 missionId => Anchor[]) private _anchors;
    mapping(bytes32 robotId => bytes32[]) private _robotMissions;

    event MissionRegistered(
        bytes32 indexed missionId,
        bytes32 indexed robotId,
        address indexed robot,
        address operator,
        bytes32 seedHash,
        bytes32 manifestRoot,
        bytes32 genesisHash
    );
    event Anchored(bytes32 indexed missionId, uint256 indexed anchorIndex, uint64 count, bytes32 head, bytes32 indexRoot);
    event MissionClosed(bytes32 indexed missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes32 trajectoryHash);

    error ZeroAddress();
    error MissionExists();
    error UnknownMission();
    error MissionClosedAlready();
    error RobotNotOperator();
    error NotRobotOwnerOrOperator();
    error StaleCount();
    error BadSignature();

    constructor(IRobotRegistry robotRegistry_) {
        if (address(robotRegistry_) == address(0)) revert ZeroAddress();
        robotRegistry = robotRegistry_;
    }

    // ---------------------------------------------------------------------
    // Writes
    // ---------------------------------------------------------------------

    /// @notice Register a mission before takeoff.
    /// @dev    Caller must own `robotId` in zerobot or be one of its operators,
    ///         and `robot` must be an operator of `robotId`.
    function registerMission(
        bytes32 missionId,
        bytes32 robotId,
        address robot,
        bytes32 seedHash,
        bytes32 manifestRoot,
        bytes32 genesisHash
    ) external {
        if (robot == address(0)) revert ZeroAddress();
        if (_missions[missionId].robot != address(0)) revert MissionExists();
        if (!robotRegistry.isOperator(robotId, robot)) revert RobotNotOperator();
        if (!_isOwnerOrOperator(robotId, msg.sender)) revert NotRobotOwnerOrOperator();

        _missions[missionId] = Mission({
            robotId: robotId,
            robot: robot,
            operator: msg.sender,
            seedHash: seedHash,
            manifestRoot: manifestRoot,
            genesisHash: genesisHash,
            head: genesisHash,
            indexRoot: bytes32(0),
            trajectoryHash: bytes32(0),
            count: 1,
            startedAt: uint64(block.timestamp),
            closedAt: 0
        });
        _robotMissions[robotId].push(missionId);

        emit MissionRegistered(missionId, robotId, robot, msg.sender, seedHash, manifestRoot, genesisHash);
    }

    /// @notice Pin the chain head after `count` log entries. Relayable by anyone;
    ///         authorised by the robot's signature over `anchorDigest(...)`.
    function anchor(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes calldata robotSig)
        external
    {
        Mission storage m = _openMission(missionId);
        if (count <= m.count) revert StaleCount();
        _checkRobotSig(m, anchorDigest(missionId, count, head, indexRoot), robotSig);

        m.count = count;
        m.head = head;
        m.indexRoot = indexRoot;
        _anchors[missionId].push(Anchor({count: count, timestamp: uint64(block.timestamp), head: head, indexRoot: indexRoot}));

        emit Anchored(missionId, _anchors[missionId].length - 1, count, head, indexRoot);
    }

    /// @notice Close the mission with its final head and the sim trajectory hash.
    function closeMission(
        bytes32 missionId,
        uint64 count,
        bytes32 head,
        bytes32 indexRoot,
        bytes32 trajectoryHash,
        bytes calldata robotSig
    ) external {
        Mission storage m = _openMission(missionId);
        if (count < m.count) revert StaleCount();
        _checkRobotSig(m, closeDigest(missionId, count, head, indexRoot, trajectoryHash), robotSig);

        m.count = count;
        m.head = head;
        m.indexRoot = indexRoot;
        m.trajectoryHash = trajectoryHash;
        m.closedAt = uint64(block.timestamp);
        _anchors[missionId].push(Anchor({count: count, timestamp: uint64(block.timestamp), head: head, indexRoot: indexRoot}));

        emit Anchored(missionId, _anchors[missionId].length - 1, count, head, indexRoot);
        emit MissionClosed(missionId, count, head, indexRoot, trajectoryHash);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getMission(bytes32 missionId) external view returns (Mission memory) {
        return _missions[missionId];
    }

    function getAnchors(bytes32 missionId) external view returns (Anchor[] memory) {
        return _anchors[missionId];
    }

    function anchorCount(bytes32 missionId) external view returns (uint256) {
        return _anchors[missionId].length;
    }

    function missionsOf(bytes32 robotId) external view returns (bytes32[] memory) {
        return _robotMissions[robotId];
    }

    /// @notice The 32-byte message the robot signs (EIP-191) to anchor.
    function anchorDigest(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(ANCHOR_TYPEHASH, block.chainid, address(this), missionId, count, head, indexRoot));
    }

    /// @notice The 32-byte message the robot signs (EIP-191) to close.
    function closeDigest(bytes32 missionId, uint64 count, bytes32 head, bytes32 indexRoot, bytes32 trajectoryHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(CLOSE_TYPEHASH, block.chainid, address(this), missionId, count, head, indexRoot, trajectoryHash)
        );
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _openMission(bytes32 missionId) private view returns (Mission storage m) {
        m = _missions[missionId];
        if (m.robot == address(0)) revert UnknownMission();
        if (m.closedAt != 0) revert MissionClosedAlready();
    }

    function _isOwnerOrOperator(bytes32 robotId, address who) private view returns (bool) {
        if (robotRegistry.isOperator(robotId, who)) return true;
        return robotRegistry.getRobot(robotId).owner == who;
    }

    /// @dev The robot must still be a zerobot operator: removing it in zerobot
    ///      revokes its ability to extend any open mission.
    function _checkRobotSig(Mission storage m, bytes32 digest, bytes calldata sig) private view {
        if (!robotRegistry.isOperator(m.robotId, m.robot)) revert RobotNotOperator();
        if (_recover(_toEthSigned(digest), sig) != m.robot) revert BadSignature();
    }

    function _toEthSigned(bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _recover(bytes32 hash, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > _HALF_N) revert BadSignature();
        signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}

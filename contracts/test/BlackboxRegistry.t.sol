// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlackboxRegistry} from "../src/BlackboxRegistry.sol";
import {SimpleRobotRegistry} from "../src/SimpleRobotRegistry.sol";

contract BlackboxRegistryTest is Test {
    SimpleRobotRegistry zerobot;
    BlackboxRegistry registry;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    uint256 robotKey = 0xB0B;
    address robot;
    uint256 strangerKey = 0xBAD;

    bytes32 robotId = keccak256("blackbox-drone-1");
    bytes32 missionId = keccak256("mission-1");
    bytes32 genesis = keccak256("entry-0");

    function setUp() public {
        robot = vm.addr(robotKey);
        zerobot = new SimpleRobotRegistry();
        registry = new BlackboxRegistry(zerobot);

        vm.startPrank(owner);
        zerobot.registerRobot(robotId, "drone-1", "sim-drone", bytes32(0));
        zerobot.addOperator(robotId, robot);
        vm.stopPrank();
    }

    function _register() internal {
        vm.prank(owner);
        registry.registerMission(missionId, robotId, robot, keccak256("seed"), keccak256("manifest"), genesis);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, eth);
        return abi.encodePacked(r, s, v);
    }

    function test_registerAnchorClose() public {
        _register();
        BlackboxRegistry.Mission memory m = registry.getMission(missionId);
        assertEq(m.robot, robot);
        assertEq(m.head, genesis);
        assertEq(m.count, 1);

        bytes32 head = keccak256("entry-2");
        bytes32 idx = keccak256("index-3");
        bytes memory sig = _sign(robotKey, registry.anchorDigest(missionId, 3, head, idx));
        vm.prank(relayer); // anyone can relay a robot-signed anchor
        registry.anchor(missionId, 3, head, idx, sig);

        m = registry.getMission(missionId);
        assertEq(m.count, 3);
        assertEq(m.head, head);
        assertEq(registry.anchorCount(missionId), 1);

        bytes32 fin = keccak256("entry-5");
        bytes32 traj = keccak256("trajectory");
        sig = _sign(robotKey, registry.closeDigest(missionId, 6, fin, idx, traj));
        registry.closeMission(missionId, 6, fin, idx, traj, sig);

        m = registry.getMission(missionId);
        assertEq(m.trajectoryHash, traj);
        assertGt(m.closedAt, 0);
        assertEq(registry.getAnchors(missionId).length, 2);
        assertEq(registry.missionsOf(robotId).length, 1);
    }

    function test_anchorSignedByNonOperatorReverts() public {
        _register();
        bytes32 head = keccak256("h");
        bytes memory sig = _sign(strangerKey, registry.anchorDigest(missionId, 2, head, bytes32(0)));
        vm.expectRevert(BlackboxRegistry.BadSignature.selector);
        registry.anchor(missionId, 2, head, bytes32(0), sig);
    }

    function test_anchorForOtherMissionDigestReverts() public {
        _register();
        bytes32 head = keccak256("h");
        // A signature over a different count must not be replayable.
        bytes memory sig = _sign(robotKey, registry.anchorDigest(missionId, 2, head, bytes32(0)));
        vm.expectRevert(BlackboxRegistry.BadSignature.selector);
        registry.anchor(missionId, 4, head, bytes32(0), sig);
    }

    function test_registerRequiresRobotToBeOperator() public {
        address notOperator = vm.addr(strangerKey);
        vm.prank(owner);
        vm.expectRevert(BlackboxRegistry.RobotNotOperator.selector);
        registry.registerMission(missionId, robotId, notOperator, 0, 0, genesis);
    }

    function test_registerRequiresOwnerOrOperatorCaller() public {
        vm.prank(relayer);
        vm.expectRevert(BlackboxRegistry.NotRobotOwnerOrOperator.selector);
        registry.registerMission(missionId, robotId, robot, 0, 0, genesis);
    }

    function test_registerTwiceReverts() public {
        _register();
        vm.prank(owner);
        vm.expectRevert(BlackboxRegistry.MissionExists.selector);
        registry.registerMission(missionId, robotId, robot, 0, 0, genesis);
    }

    function test_staleCountReverts() public {
        _register();
        bytes32 head = keccak256("h");
        bytes memory sig = _sign(robotKey, registry.anchorDigest(missionId, 1, head, bytes32(0)));
        vm.expectRevert(BlackboxRegistry.StaleCount.selector);
        registry.anchor(missionId, 1, head, bytes32(0), sig);
    }

    function test_removedOperatorCannotAnchor() public {
        _register();
        vm.prank(owner);
        zerobot.removeOperator(robotId, robot);
        bytes32 head = keccak256("h");
        bytes memory sig = _sign(robotKey, registry.anchorDigest(missionId, 2, head, bytes32(0)));
        vm.expectRevert(BlackboxRegistry.RobotNotOperator.selector);
        registry.anchor(missionId, 2, head, bytes32(0), sig);
    }

    function test_closedMissionRejectsAnchors() public {
        _register();
        bytes memory sig = _sign(robotKey, registry.closeDigest(missionId, 1, genesis, bytes32(0), bytes32(0)));
        registry.closeMission(missionId, 1, genesis, bytes32(0), bytes32(0), sig);

        bytes32 head = keccak256("h");
        sig = _sign(robotKey, registry.anchorDigest(missionId, 2, head, bytes32(0)));
        vm.expectRevert(BlackboxRegistry.MissionClosedAlready.selector);
        registry.anchor(missionId, 2, head, bytes32(0), sig);
    }

    function test_unknownMissionReverts() public {
        vm.expectRevert(BlackboxRegistry.UnknownMission.selector);
        registry.anchor(missionId, 2, bytes32(0), bytes32(0), new bytes(65));
    }
}

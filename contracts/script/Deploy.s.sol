// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BlackboxRegistry} from "../src/BlackboxRegistry.sol";
import {SimpleRobotRegistry} from "../src/SimpleRobotRegistry.sol";
import {IRobotRegistry} from "../src/interfaces/IRobotRegistry.sol";

/// @notice Deploys BlackboxRegistry.
///   ROBOT_REGISTRY=<zerobot RobotRegistry>  use an existing registry (Galileo: zerobot's proxy)
///   ROBOT_REGISTRY unset                    deploy SimpleRobotRegistry first (local / mainnet)
/// Writes deployments/<chainId>.json for core/.env.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address robotRegistry = vm.envOr("ROBOT_REGISTRY", address(0));

        vm.startBroadcast(pk);
        bool simple = robotRegistry == address(0);
        if (simple) {
            robotRegistry = address(new SimpleRobotRegistry());
        }
        BlackboxRegistry registry = new BlackboxRegistry(IRobotRegistry(robotRegistry));
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("RobotRegistry", robotRegistry, simple ? "(SimpleRobotRegistry, new)" : "(existing)");
        console2.log("BlackboxRegistry", address(registry));

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "robotRegistry", robotRegistry);
        vm.serializeBool(obj, "robotRegistryIsSimple", simple);
        vm.serializeUint(obj, "blockNumber", block.number);
        string memory json = vm.serializeAddress(obj, "blackboxRegistry", address(registry));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IRobotRegistry} from "./interfaces/IRobotRegistry.sol";

/// @title SimpleRobotRegistry
/// @notice A minimal, ABI-compatible stand-in for zerobot's RobotRegistry, for
///         networks where zerobot is not deployed (local anvil, 0G mainnet today).
///         Implements only what Blackbox reads plus the calls needed to set a
///         robot up. On Galileo, use zerobot's deployed registry instead.
contract SimpleRobotRegistry is IRobotRegistry {
    mapping(bytes32 robotId => Robot) private _robots;
    mapping(bytes32 robotId => mapping(address => bool)) private _operators;

    event RobotRegistered(bytes32 indexed robotId, address indexed owner, string name, string robotType);
    event OperatorAdded(bytes32 indexed robotId, address indexed operator);
    event OperatorRemoved(bytes32 indexed robotId, address indexed operator);

    modifier onlyRobotOwner(bytes32 robotId) {
        require(_robots[robotId].owner == msg.sender, "Not robot owner");
        _;
    }

    function registerRobot(bytes32 robotId, string calldata name, string calldata robotType, bytes32 storageRoot)
        external
    {
        require(_robots[robotId].owner == address(0), "Robot already registered");
        _robots[robotId] = Robot({
            owner: msg.sender,
            name: name,
            robotType: robotType,
            storageRoot: storageRoot,
            active: true,
            publicCommands: false,
            registeredAt: block.timestamp
        });
        emit RobotRegistered(robotId, msg.sender, name, robotType);
    }

    function addOperator(bytes32 robotId, address operator) external onlyRobotOwner(robotId) {
        require(operator != address(0), "Invalid operator");
        _operators[robotId][operator] = true;
        emit OperatorAdded(robotId, operator);
    }

    function removeOperator(bytes32 robotId, address operator) external onlyRobotOwner(robotId) {
        _operators[robotId][operator] = false;
        emit OperatorRemoved(robotId, operator);
    }

    function isOperator(bytes32 robotId, address caller) external view returns (bool) {
        return _operators[robotId][caller];
    }

    function getRobot(bytes32 robotId) external view returns (Robot memory) {
        return _robots[robotId];
    }
}

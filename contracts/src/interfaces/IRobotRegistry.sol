// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice The subset of zerobot's IRobotRegistry that Blackbox reads.
/// @dev Struct layout copied verbatim from
///      github.com/0gfoundation/zerobot contracts/contracts/interfaces/IRobotRegistry.sol
///      so that `getRobot` decodes against the deployed zerobot proxy
///      (Galileo: 0x291162e93D7A80Eb8F738882a28a7a8A5FBA73bb).
interface IRobotRegistry {
    struct Robot {
        address owner;
        string name;
        string robotType;
        bytes32 storageRoot;
        bool active;
        bool publicCommands;
        uint256 registeredAt;
    }

    function isOperator(bytes32 robotId, address caller) external view returns (bool);

    function getRobot(bytes32 robotId) external view returns (Robot memory);
}

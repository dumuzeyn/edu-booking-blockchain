// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Fixed-supply educational credits. No public mint, sale or price peg.
contract EduToken is ERC20, ERC20Burnable {
    uint256 public constant INITIAL_SUPPLY = 1_000_000 ether;

    constructor(address treasury) ERC20("Education Credit", "EDU") {
        require(treasury != address(0), "Zero treasury");
        _mint(treasury, INITIAL_SUPPLY);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Escrow booking for a single institution-approved tutor.
/// @dev Use only with the fixed EDU token; fee-on-transfer tokens are unsupported.
contract ConsultationBooking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Status { Open, Booked, Completed, Cancelled }
    struct Slot {
        uint64 startsAt;
        uint128 price;
        address student;
        Status status;
    }

    IERC20 public immutable token;
    address public immutable tutor;
    uint256 public immutable refundDelay;
    uint256 public slotCount;
    mapping(uint256 => Slot) public slots;

    event SlotCreated(uint256 indexed slotId, uint64 startsAt, uint128 price);
    event Booked(uint256 indexed slotId, address indexed student, uint256 price);
    event Cancelled(uint256 indexed slotId, address indexed actor, uint256 refund);
    event Completed(uint256 indexed slotId, address indexed student, uint256 payout);

    constructor(address tokenAddress, address tutorAddress, uint256 delaySeconds) {
        require(tokenAddress.code.length > 0, "Token must be contract");
        require(tutorAddress != address(0), "Zero tutor");
        require(delaySeconds > 0, "Zero refund delay");
        token = IERC20(tokenAddress);
        tutor = tutorAddress;
        refundDelay = delaySeconds;
    }

    modifier onlyTutor() {
        require(msg.sender == tutor, "Only tutor");
        _;
    }

    modifier exists(uint256 slotId) {
        require(slotId < slotCount, "Unknown slot");
        _;
    }

    function createSlot(uint64 startsAt, uint128 price) external onlyTutor {
        require(startsAt > block.timestamp, "Slot in past");
        require(price > 0, "Zero price");
        uint256 slotId = slotCount++;
        slots[slotId] = Slot(startsAt, price, address(0), Status.Open);
        emit SlotCreated(slotId, startsAt, price);
    }

    function book(uint256 slotId) external exists(slotId) nonReentrant {
        Slot storage slot = slots[slotId];
        require(slot.status == Status.Open, "Slot not open");
        require(block.timestamp < slot.startsAt, "Slot started");
        require(msg.sender != tutor, "Tutor cannot book");
        slot.student = msg.sender;
        slot.status = Status.Booked;
        token.safeTransferFrom(msg.sender, address(this), slot.price);
        emit Booked(slotId, msg.sender, slot.price);
    }

    /// @notice Student may cancel strictly before start, with full refund.
    function cancelByStudent(uint256 slotId) external exists(slotId) nonReentrant {
        Slot storage slot = slots[slotId];
        require(slot.status == Status.Booked, "Slot not booked");
        require(msg.sender == slot.student, "Only student");
        require(block.timestamp < slot.startsAt, "Cancellation closed");
        _refund(slotId, slot);
    }

    /// @notice Tutor may cancel an open/booked slot; paid funds return to student.
    function cancelByTutor(uint256 slotId) external onlyTutor exists(slotId) nonReentrant {
        Slot storage slot = slots[slotId];
        require(slot.status == Status.Open || slot.status == Status.Booked, "Slot closed");
        _refund(slotId, slot);
    }

    /// @notice Only the student confirms delivery, after start and before timeout.
    function confirmCompleted(uint256 slotId) external exists(slotId) nonReentrant {
        Slot storage slot = slots[slotId];
        require(slot.status == Status.Booked, "Slot not booked");
        require(msg.sender == slot.student, "Only student");
        require(block.timestamp >= slot.startsAt, "Too early");
        require(block.timestamp < uint256(slot.startsAt) + refundDelay, "Confirmation expired");
        slot.status = Status.Completed;
        token.safeTransfer(tutor, slot.price);
        emit Completed(slotId, msg.sender, slot.price);
    }

    /// @notice Any caller may trigger a refund to the student after timeout.
    function refundExpired(uint256 slotId) external exists(slotId) nonReentrant {
        Slot storage slot = slots[slotId];
        require(slot.status == Status.Booked, "Slot not booked");
        require(block.timestamp >= uint256(slot.startsAt) + refundDelay, "Too early");
        _refund(slotId, slot);
    }

    function _refund(uint256 slotId, Slot storage slot) private {
        bool paid = slot.status == Status.Booked;
        slot.status = Status.Cancelled;
        uint256 amount = paid ? slot.price : 0;
        if (paid) token.safeTransfer(slot.student, amount);
        emit Cancelled(slotId, msg.sender, amount);
    }
}

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const {
  BrowserProvider,
  ContractFactory,
  parseEther,
  ZeroAddress,
} = require("ethers");
const tokenArtifact = require("../build/contracts/EduToken.json");
const bookingArtifact = require("../build/contracts/ConsultationBooking.json");
const amount = parseEther;

async function fixture() {
  const chain = ganache.provider({
    logging: { quiet: true },
    wallet: { deterministic: true },
    chain: { chainId: 1337 },
  });
  const provider = new BrowserProvider(chain, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [treasury, tutor, student, other] = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const token = await new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode,
    treasury,
  ).deploy(await treasury.getAddress());
  await token.waitForDeployment();
  const booking = await new ContractFactory(
    bookingArtifact.abi,
    bookingArtifact.bytecode,
    treasury,
  ).deploy(await token.getAddress(), await tutor.getAddress(), 86400);
  await booking.waitForDeployment();
  await (
    await token.transfer(await student.getAddress(), amount("1000"))
  ).wait();
  await (await token.transfer(await other.getAddress(), amount("1000"))).wait();
  const start = Number((await provider.getBlock("latest")).timestamp) + 3600;
  await (await booking.connect(tutor).createSlot(start, amount("100"))).wait();
  async function book() {
    await (
      await token
        .connect(student)
        .approve(await booking.getAddress(), amount("100"))
    ).wait();
    return (await booking.connect(student).book(0)).wait();
  }
  async function advance(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }
  return {
    chain,
    provider,
    treasury,
    tutor,
    student,
    other,
    token,
    booking,
    start,
    book,
    advance,
  };
}
async function scenario(name, fn) {
  await test(name, async () => {
    const f = await fixture();
    try {
      await fn(f);
    } finally {
      await f.chain.disconnect();
    }
  });
}
async function rejects(promise) {
  await assert.rejects(promise);
}

(async () => {
  await scenario(
    "Fixed initial supply and ERC20 transfer including zero value",
    async (f) => {
      assert.equal(await f.token.totalSupply(), amount("1000000"));
      assert.equal(await f.token.decimals(), 18n);
      await (
        await f.token.connect(f.student).transfer(await f.other.getAddress(), 0)
      ).wait();
      assert.equal(
        await f.token.balanceOf(await f.student.getAddress()),
        amount("1000"),
      );
    },
  );
  await scenario("Burn reduces holder balance and total supply", async (f) => {
    await (await f.token.connect(f.student).burn(amount("10"))).wait();
    assert.equal(await f.token.totalSupply(), amount("999990"));
    assert.equal(
      await f.token.balanceOf(await f.student.getAddress()),
      amount("990"),
    );
  });
  await scenario(
    "Only tutor creates valid future nonzero-priced slots",
    async (f) => {
      await rejects(f.booking.connect(f.student).createSlot(f.start + 10, 1));
      await rejects(f.booking.connect(f.tutor).createSlot(1, 1));
      await rejects(f.booking.connect(f.tutor).createSlot(f.start + 10, 0));
      assert.equal(await f.booking.slotCount(), 1n);
    },
  );
  await scenario(
    "Unknown slot is rejected in all lifecycle methods",
    async (f) => {
      for (const method of [
        "book",
        "cancelByStudent",
        "confirmCompleted",
        "refundExpired",
      ])
        await rejects(f.booking.connect(f.student)[method](999));
      await rejects(f.booking.connect(f.tutor).cancelByTutor(999));
    },
  );
  await scenario(
    "Missing allowance rolls back booking state and balances",
    async (f) => {
      await rejects(f.booking.connect(f.student).book(0));
      assert.equal((await f.booking.slots(0)).status, 0n);
      assert.equal(await f.token.balanceOf(await f.booking.getAddress()), 0n);
    },
  );
  await scenario(
    "Insufficient balance rolls back booking despite approval",
    async (f) => {
      await (
        await f.token
          .connect(f.student)
          .transfer(await f.treasury.getAddress(), amount("1000"))
      ).wait();
      await (
        await f.token
          .connect(f.student)
          .approve(await f.booking.getAddress(), amount("100"))
      ).wait();
      await rejects(f.booking.connect(f.student).book(0));
      assert.equal((await f.booking.slots(0)).status, 0n);
    },
  );
  await scenario(
    "Booking consumes exact allowance and holds escrow with Booked event",
    async (f) => {
      const r = await f.book();
      assert.equal(
        await f.token.balanceOf(await f.booking.getAddress()),
        amount("100"),
      );
      assert.equal(
        await f.token.balanceOf(await f.student.getAddress()),
        amount("900"),
      );
      assert.equal(
        await f.token.allowance(
          await f.student.getAddress(),
          await f.booking.getAddress(),
        ),
        0n,
      );
      assert.equal(
        (await f.booking.slots(0)).student,
        await f.student.getAddress(),
      );
      const events = r.logs.flatMap((l) => {
        try {
          return [f.booking.interface.parseLog(l)?.name];
        } catch {
          return [];
        }
      });
      assert.ok(events.includes("Booked"));
    },
  );
  await scenario(
    "Double booking and tutor self-booking are forbidden",
    async (f) => {
      await rejects(f.booking.connect(f.tutor).book(0));
      await f.book();
      await rejects(f.booking.connect(f.other).book(0));
      assert.equal(
        (await f.booking.slots(0)).student,
        await f.student.getAddress(),
      );
    },
  );
  await scenario(
    "Student cancellation refunds full escrow exactly once",
    async (f) => {
      await f.book();
      await (await f.booking.connect(f.student).cancelByStudent(0)).wait();
      assert.equal(
        await f.token.balanceOf(await f.student.getAddress()),
        amount("1000"),
      );
      assert.equal((await f.booking.slots(0)).status, 3n);
      await rejects(f.booking.connect(f.student).cancelByStudent(0));
      await rejects(f.booking.connect(f.student).book(0));
    },
  );
  await scenario(
    "Other student cannot cancel or confirm another booking",
    async (f) => {
      await f.book();
      await rejects(f.booking.connect(f.other).cancelByStudent(0));
      await rejects(f.booking.connect(f.other).confirmCompleted(0));
      await rejects(f.booking.connect(f.other).cancelByTutor(0));
    },
  );
  await scenario(
    "Tutor cancellation refunds student and cannot redirect payment",
    async (f) => {
      await f.book();
      await (await f.booking.connect(f.tutor).cancelByTutor(0)).wait();
      assert.equal(
        await f.token.balanceOf(await f.student.getAddress()),
        amount("1000"),
      );
      assert.equal(await f.token.balanceOf(await f.tutor.getAddress()), 0n);
    },
  );
  await scenario(
    "Tutor may cancel an unbooked slot without payment",
    async (f) => {
      await (await f.booking.connect(f.tutor).cancelByTutor(0)).wait();
      assert.equal((await f.booking.slots(0)).status, 3n);
      assert.equal(await f.token.balanceOf(await f.booking.getAddress()), 0n);
    },
  );
  await scenario(
    "Completion requires start and student confirmation then pays tutor once",
    async (f) => {
      await f.book();
      await rejects(f.booking.connect(f.student).confirmCompleted(0));
      await f.advance(3601);
      await (await f.booking.connect(f.student).confirmCompleted(0)).wait();
      assert.equal(
        await f.token.balanceOf(await f.tutor.getAddress()),
        amount("100"),
      );
      assert.equal(await f.token.balanceOf(await f.booking.getAddress()), 0n);
      assert.equal((await f.booking.slots(0)).status, 2n);
      await rejects(f.booking.connect(f.student).confirmCompleted(0));
      await rejects(f.booking.connect(f.tutor).cancelByTutor(0));
    },
  );
  await scenario(
    "Student cannot cancel or newly book a started slot",
    async (f) => {
      await f.book();
      await f.advance(3601);
      await rejects(f.booking.connect(f.student).cancelByStudent(0));
      await (
        await f.booking
          .connect(f.tutor)
          .createSlot(f.start + 7200, amount("50"))
      ).wait();
      await f.advance(7201);
      await rejects(f.booking.connect(f.student).book(1));
    },
  );
  await scenario(
    "Expired escrow returns to student with permissionless trigger",
    async (f) => {
      await f.book();
      await rejects(f.booking.connect(f.other).refundExpired(0));
      await f.advance(3600 + 86401);
      await rejects(f.booking.connect(f.student).confirmCompleted(0));
      await (await f.booking.connect(f.other).refundExpired(0)).wait();
      assert.equal(
        await f.token.balanceOf(await f.student.getAddress()),
        amount("1000"),
      );
      assert.equal((await f.booking.slots(0)).status, 3n);
      await rejects(f.booking.connect(f.other).refundExpired(0));
    },
  );
  await scenario(
    "Boundary at start closes cancellation and allows confirmation",
    async (f) => {
      await f.book();
      await f.provider.send("evm_setTime", [f.start * 1000]);
      await f.provider.send("evm_mine", []);
      await rejects(f.booking.connect(f.student).cancelByStudent.staticCall(0));
      await f.booking.connect(f.student).confirmCompleted.staticCall(0);
    },
  );
  await scenario(
    "Boundary at refund deadline forbids completion and allows refund",
    async (f) => {
      await f.book();
      await f.provider.send("evm_setTime", [(f.start + 86400) * 1000]);
      await f.provider.send("evm_mine", []);
      await rejects(
        f.booking.connect(f.student).confirmCompleted.staticCall(0),
      );
      await f.booking.connect(f.other).refundExpired.staticCall(0);
    },
  );
  await scenario(
    "Constructors reject zero treasury and invalid booking dependencies",
    async (f) => {
      const tf = new ContractFactory(
        tokenArtifact.abi,
        tokenArtifact.bytecode,
        f.treasury,
      );
      const bf = new ContractFactory(
        bookingArtifact.abi,
        bookingArtifact.bytecode,
        f.treasury,
      );
      await rejects(tf.deploy(ZeroAddress));
      await rejects(
        bf.deploy(
          await f.student.getAddress(),
          await f.tutor.getAddress(),
          86400,
        ),
      );
      await rejects(bf.deploy(await f.token.getAddress(), ZeroAddress, 86400));
      await rejects(
        bf.deploy(await f.token.getAddress(), await f.tutor.getAddress(), 0),
      );
    },
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

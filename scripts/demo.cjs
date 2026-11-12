const {
  JsonRpcProvider,
  Contract,
  formatEther,
  parseEther,
} = require("ethers");
const fs = require("node:fs");
const config = require("../deployments/local.json");
const tokenAbi = require("../build/contracts/EduToken.json").abi;
const bookingAbi = require("../build/contracts/ConsultationBooking.json").abi;

(async () => {
  const provider = new JsonRpcProvider("http://127.0.0.1:7545", undefined, {
    cacheTimeout: -1,
  });
  provider.pollingInterval = 50;
  if ((await provider.getNetwork()).chainId !== 1337n)
    throw Error("Local chain 1337 required");
  const student = await provider.getSigner(config.student);
  const tutor = await provider.getSigner(config.tutor);
  const token = new Contract(config.token, tokenAbi, student);
  const booking = new Contract(config.booking, bookingAbi, student);
  if ((await booking.slots(0)).status !== 0n)
    throw Error("Run npm run migrate before demo");
  const receipts = [];
  async function record(action, promise) {
    const receipt = await (await promise).wait();
    const tx = await provider.getTransaction(receipt.hash);
    const events = receipt.logs.flatMap((log) => {
      for (const contract of [token, booking]) {
        try {
          const ev = contract.interface.parseLog(log);
          if (ev)
            return [{ name: ev.name, args: ev.args.toArray().map(String) }];
        } catch {}
      }
      return [];
    });
    receipts.push({
      action,
      hash: receipt.hash,
      block: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      from: receipt.from,
      to: receipt.to,
      input: tx.data,
      events,
    });
    console.log(
      `${action}: ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`,
    );
  }
  await record(
    "approve 100 EDU",
    token.approve(config.booking, parseEther("100")),
  );
  await record("book slot 0 for 100 EDU", booking.book(0));
  await record(
    "approve 150 EDU",
    token.approve(config.booking, parseEther("150")),
  );
  await record("book slot 1 for 150 EDU", booking.book(1));
  await record("cancel slot 1 and refund 150 EDU", booking.cancelByStudent(1));
  const now = Number((await provider.getBlock("latest")).timestamp);
  await record(
    "create slot 2 for 50 EDU",
    booking.connect(tutor).createSlot(now + 60, parseEther("50")),
  );
  await record(
    "approve 50 EDU",
    token.approve(config.booking, parseEther("50")),
  );
  await record("book slot 2 for 50 EDU", booking.book(2));
  await provider.send("evm_increaseTime", [61]);
  await provider.send("evm_mine", []);
  await record(
    "confirm slot 2 and pay tutor 50 EDU",
    booking.confirmCompleted(2),
  );
  const balance = async (a) => formatEther(await token.balanceOf(a));
  const slots = [];
  for (let i = 0; i < Number(await booking.slotCount()); i++) {
    const s = await booking.slots(i);
    slots.push({
      id: i,
      startsAt: String(s.startsAt),
      price: formatEther(s.price),
      student: s.student,
      status: Number(s.status),
    });
  }
  const result = {
    runAt: new Date().toISOString(),
    environment: "Ganache local EVM only",
    ...config,
    receipts,
    slots,
    balances: {
      student: await balance(config.student),
      tutor: await balance(config.tutor),
      escrow: await balance(config.booking),
    },
    totalSupply: formatEther(await token.totalSupply()),
    note: "evm_increaseTime used only for the local demonstration",
  };
  fs.mkdirSync("evidence", { recursive: true });
  fs.writeFileSync(
    "evidence/latest-demo.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result.balances, null, 2));
  provider.destroy();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

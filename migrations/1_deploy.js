const EduToken = artifacts.require("EduToken");
const Booking = artifacts.require("ConsultationBooking");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function (deployer, network, accounts) {
  await deployer.deploy(EduToken, accounts[0]);
  await deployer.deploy(Booking, EduToken.address, accounts[1], 86400);
  const token = await EduToken.deployed();
  for (const address of [accounts[2], accounts[3]]) {
    await token.transfer(address, web3.utils.toWei("1000", "ether"));
  }
  const booking = await Booking.deployed();
  const block = await web3.eth.getBlock("latest");
  const startsAt = Number(block.timestamp) + 86400;
  await booking.createSlot(startsAt, web3.utils.toWei("100", "ether"), {
    from: accounts[1],
  });
  await booking.createSlot(startsAt + 3600, web3.utils.toWei("150", "ether"), {
    from: accounts[1],
  });
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "../deployments/local.json"),
    JSON.stringify(
      {
        chainId: Number(await web3.eth.getChainId()),
        networkId: String(await web3.eth.net.getId()),
        token: EduToken.address,
        booking: Booking.address,
        treasury: accounts[0],
        tutor: accounts[1],
        student: accounts[2],
        otherStudent: accounts[3],
        refundDelay: 86400,
      },
      null,
      2,
    ),
  );
};

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Wallet, id } = require("ethers");
const { createMeetingService } = require("../scripts/meeting-info.cjs");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edu-meeting-test-"));
  const file = path.join(dir, "meeting.json");
  const tutor = Wallet.createRandom(), student = Wallet.createRandom(), other = Wallet.createRandom();
  let status = 0, clock = 0;
  const context = { chainId: 1337, booking: Wallet.createRandom().address, tutor: tutor.address,
    async readSlot(slotId) {
      if (slotId !== 0) throw Error("Консультация не найдена");
      return { status, student: student.address };
    } };
  const options = { file, getContext: async () => context, now: () => clock };
  const service = createMeetingService(options);
  async function proof(wallet, action, payload) {
    const challenge = await service.challenge({ address: wallet.address, action, payloadHash: id(JSON.stringify(payload)) });
    return { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message), payload };
  }
  async function save() { return service.write(await proof(tutor, "write", { slotId: 0, text: "Аудитория Б-305. Вход со двора." })); }
  return { tutor, student, other, context, service, options, proof, save,
    setStatus: v => { status = v; }, advance: n => { clock += n; },
    cleanup() { for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); } };
}

test("Meeting text survives restart and public response contains no text", async () => {
  const f = fixture(); try {
    await f.save();
    assert.deepEqual(await f.service.availability(), { configured: [0] });
    const restarted = createMeetingService(f.options);
    assert.equal((await restarted.availability()).configured[0], 0);
    assert.equal((await f.service.read(await f.proof(f.tutor, "read", { slotId: 0 }))).text, "Аудитория Б-305. Вход со двора.");
  } finally { f.cleanup(); }
});
test("Only tutor can save meeting text and whitespace is rejected", async () => {
  const f = fixture(); try {
    await assert.rejects(f.service.write(await f.proof(f.student, "write", { slotId: 0, text: "Чужой текст" })), /только преподаватель/);
    await assert.rejects(f.service.write(await f.proof(f.tutor, "write", { slotId: 0, text: "   " })), /Укажите место/);
    assert.deepEqual(await f.service.availability(), { configured: [] });
  } finally { f.cleanup(); }
});
test("Only booked owner reads details, cancellation revokes access", async () => {
  const f = fixture(); try {
    await f.save();
    await assert.rejects(f.service.read(await f.proof(f.student, "read", { slotId: 0 })), /действующей бронью/);
    f.setStatus(1);
    assert.match((await f.service.read(await f.proof(f.student, "read", { slotId: 0 }))).text, /Аудитория/);
    await assert.rejects(f.service.read(await f.proof(f.other, "read", { slotId: 0 })), /действующей бронью/);
    f.setStatus(2);
    assert.match((await f.service.read(await f.proof(f.student, "read", { slotId: 0 }))).text, /Аудитория/);
    f.setStatus(3);
    await assert.rejects(f.service.read(await f.proof(f.student, "read", { slotId: 0 })), /действующей бронью/);
  } finally { f.cleanup(); }
});
test("Access proof cannot be replayed, changed or forged", async () => {
  const f = fixture(); try {
    await f.save(); f.setStatus(1);
    const p = await f.proof(f.student, "read", { slotId: 0 });
    await assert.rejects(f.service.read({ ...p, payload: { slotId: 1 } }), /Подпись/);
    await f.service.read(p);
    await assert.rejects(f.service.read(p), /истекло/);
    const c = await f.service.challenge({ address: f.student.address, action: "read", payloadHash: id(JSON.stringify({ slotId: 0 })) });
    await assert.rejects(f.service.read({ nonce: c.nonce, signature: await f.other.signMessage(c.message), payload: { slotId: 0 } }), /Подпись/);
  } finally { f.cleanup(); }
});
test("Expired proofs and proofs for previous deployment are rejected", async () => {
  const f = fixture(); try {
    await f.save();
    const expired = await f.proof(f.tutor, "read", { slotId: 0 }); f.advance(120001);
    await assert.rejects(f.service.read(expired), /истекло/);
    const old = await f.proof(f.tutor, "read", { slotId: 0 }); f.context.booking = Wallet.createRandom().address;
    await assert.rejects(f.service.read(old), /Контракт изменился/);
    assert.deepEqual(await f.service.availability(), { configured: [] });
  } finally { f.cleanup(); }
});
test("Meeting text cannot be replaced or attached to unknown or closed slot", async () => {
  const f = fixture(); try {
    await f.save();
    await assert.rejects(f.service.write(await f.proof(f.tutor, "write", { slotId: 0, text: "Другое место" })), /уже сохранено/);
    await assert.rejects(f.service.write(await f.proof(f.tutor, "write", { slotId: 999, text: "Место" })), /не найдена/);
    f.setStatus(3);
    await assert.rejects(f.service.write(await f.proof(f.tutor, "write", { slotId: 0, text: "Место" })), /закрыта/);
  } finally { f.cleanup(); }
});

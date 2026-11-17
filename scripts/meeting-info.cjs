const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { getAddress, id, verifyMessage } = require("ethers");

// Meeting text is kept off-chain. Every read checks the current booking owner.
function createMeetingService({ file, getContext, now = Date.now }) {
  const records = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const challenges = new Map();
  function slotId(value) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error("Некорректный номер консультации");
    return value;
  }
  function key(context, value) {
    return `${context.chainId}:${context.booking.toLowerCase()}:${value}`;
  }
  async function challenge({ address, action, payloadHash }) {
    if (!["read", "write"].includes(action) || !/^0x[\da-f]{64}$/i.test(payloadHash))
      throw Error("Некорректный запрос");
    address = getAddress(address);
    for (const [nonce, item] of challenges)
      if (item.expires <= now()) challenges.delete(nonce);
    if (challenges.size >= 512) throw Error("Слишком много запросов");
    const context = await getContext();
    const nonce = randomBytes(24).toString("hex");
    const expires = now() + 120000;
    const message = [
      "EDU Booking: доступ к месту консультации",
      `Действие: ${action}`, `Адрес: ${address}`,
      `Сеть: ${context.chainId}`, `Контракт: ${context.booking}`,
      `Запрос: ${payloadHash}`, `Срок: ${expires}`, `Код: ${nonce}`,
    ].join("\n");
    challenges.set(nonce, { address, action, payloadHash, expires, message,
      booking: context.booking, chainId: context.chainId });
    return { nonce, message };
  }
  async function authenticate({ nonce, signature, payload }, action) {
    const item = challenges.get(nonce);
    if (!item || item.expires <= now() || item.action !== action)
      throw Error("Подтверждение истекло. Повторите действие");
    if (id(JSON.stringify(payload)) !== item.payloadHash ||
        verifyMessage(item.message, signature) !== item.address)
      throw Error("Подпись не соответствует запросу");
    challenges.delete(nonce);
    const context = await getContext();
    if (context.booking.toLowerCase() !== item.booking.toLowerCase() ||
        context.chainId !== item.chainId)
      throw Error("Контракт изменился. Обновите страницу");
    return { context, address: item.address.toLowerCase() };
  }
  async function write(request) {
    const { context, address } = await authenticate(request, "write");
    if (address !== context.tutor.toLowerCase())
      throw Error("Место может указать только преподаватель");
    const value = slotId(request.payload.slotId);
    const slot = await context.readSlot(value);
    if (![0, 1].includes(Number(slot.status)))
      throw Error("Консультация уже закрыта");
    const text = typeof request.payload.text === "string" ? request.payload.text.trim() : "";
    if (!text || text.length > 1000)
      throw Error("Укажите место проведения: от 1 до 1000 символов");
    const recordKey = key(context, value);
    if (records[recordKey] && records[recordKey].text !== text)
      throw Error("Место уже сохранено. Для другой консультации создайте новую запись");
    const next = { ...records, [recordKey]: { text } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(next, null, 2));
    fs.renameSync(file + ".tmp", file);
    records[recordKey] = next[recordKey];
    return { saved: true };
  }
  async function read(request) {
    const { context, address } = await authenticate(request, "read");
    const value = slotId(request.payload.slotId);
    const slot = await context.readSlot(value);
    const isTutor = address === context.tutor.toLowerCase();
    const isOwner = address === slot.student.toLowerCase() &&
      [1, 2].includes(Number(slot.status));
    if (!isTutor && !isOwner)
      throw Error("Место доступно преподавателю и студенту с действующей бронью");
    const record = records[key(context, value)];
    if (!record) throw Error("Преподаватель ещё не указал место");
    return { text: record.text };
  }
  async function availability() {
    const context = await getContext();
    const prefix = `${context.chainId}:${context.booking.toLowerCase()}:`;
    return { configured: Object.keys(records).filter(k => k.startsWith(prefix))
      .map(k => Number(k.slice(prefix.length))) };
  }
  return { challenge, write, read, availability };
}
module.exports = { createMeetingService };

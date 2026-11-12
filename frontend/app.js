/* global ethers */
let provider,
  config,
  token,
  booking,
  signer,
  busy = false;
const $ = (id) => document.getElementById(id);
const fmt = (v) =>
  Number(ethers.formatEther(v)).toLocaleString("ru-RU", {
    maximumFractionDigits: 6,
  });
const names = ["Открыта", "Забронирована", "Завершена", "Отменена"];
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
async function refresh() {
  if (!provider) return;
  const address = config[$("role").value];
  signer = await provider.getSigner(address);
  token = token.connect(signer);
  booking = booking.connect(signer);
  $("address").textContent = address;
  const [balance, escrow, tutorBalance, supply, count, block] =
    await Promise.all([
      token.balanceOf(address),
      token.balanceOf(config.booking),
      token.balanceOf(config.tutor),
      token.totalSupply(),
      booking.slotCount(),
      provider.getBlock("latest"),
    ]);
  $("balance").textContent = fmt(balance);
  $("escrow").textContent = fmt(escrow) + " EDU";
  $("tutorBalance").textContent = fmt(tutorBalance) + " EDU";
  $("supply").textContent = fmt(supply) + " EDU";
  $("create").hidden = $("role").value !== "tutor";
  $("slots").replaceChildren();
  for (let id = 0; id < Number(count); id++) {
    const s = await booking.slots(id);
    const card = document.createElement("tr");
    card.className = "slot";
    const number = document.createElement("td");
    number.textContent = id + 1;
    card.append(number);
    const date = document.createElement("td");
    date.textContent = new Date(Number(s.startsAt) * 1000).toLocaleString(
      "ru-RU",
    );
    card.append(date);
    const price = document.createElement("td");
    price.textContent = fmt(s.price) + " EDU";
    card.append(price);
    const status = document.createElement("td");
    const statusLabel = document.createElement("span");
    statusLabel.className = "status status-" + s.status;
    statusLabel.textContent = names[Number(s.status)];
    status.append(statusLabel);
    card.append(status);
    const actions = document.createElement("td");
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    actions.append(buttons);
    card.append(actions);
    function button(text, fn, secondary = false) {
      const b = document.createElement("button");
      b.textContent = text;
      b.disabled = busy;
      if (secondary) b.className = "secondary";
      b.onclick = () => run(fn);
      buttons.append(b);
    }
    const isTutor = address.toLowerCase() === config.tutor.toLowerCase();
    const isStudent = address.toLowerCase() === s.student.toLowerCase();
    const now = BigInt(block.timestamp);
    if (s.status === 0n && now < s.startsAt && !isTutor)
      button("Забронировать", async () => {
        await transact(
          "Разрешение на " + fmt(s.price) + " EDU",
          token.approve(config.booking, s.price),
        );
        await transact("Бронирование №" + (id + 1), booking.book(id));
      });
    if (isTutor && (s.status === 0n || s.status === 1n))
      button(
        "Отменить слот",
        () => transact("Отмена преподавателем", booking.cancelByTutor(id)),
        true,
      );
    if (s.status === 1n && isStudent && now < s.startsAt)
      button(
        "Отменить и вернуть EDU",
        () => transact("Отмена с возвратом", booking.cancelByStudent(id)),
        true,
      );
    if (
      s.status === 1n &&
      isStudent &&
      now >= s.startsAt &&
      now < s.startsAt + BigInt(config.refundDelay)
    )
      button("Подтвердить проведение", () =>
        transact("Оплата преподавателю", booking.confirmCompleted(id)),
      );
    if (s.status === 1n && now >= s.startsAt + BigInt(config.refundDelay))
      button(
        "Вернуть по таймауту",
        () => transact("Возврат по таймауту", booking.refundExpired(id)),
        true,
      );
    if (!buttons.children.length) {
      buttons.textContent = "—";
      buttons.classList.add("empty");
    }
    $("slots").append(card);
  }
}
async function transact(label, promise) {
  message(label + " — ожидается подтверждение…");
  const r = await (await promise).wait();
  const row = document.createElement("div");
  row.className = "operation";
  const h = document.createElement("b");
  h.textContent = label + " · блок " + r.blockNumber;
  const code = document.createElement("code");
  code.textContent = r.hash;
  row.append(h, code);
  $("activity").prepend(row);
  message(label + " выполнено. Хеш: " + r.hash);
}
async function run(fn) {
  if (busy) return;
  busy = true;
  document
    .querySelectorAll("button,select")
    .forEach((b) => (b.disabled = true));
  try {
    if ((await provider.getNetwork()).chainId !== 1337n)
      throw Error("Выбрана неподдерживаемая сеть");
    await fn();
  } catch (e) {
    message(e.shortMessage || e.message, true);
  } finally {
    busy = false;
    document
      .querySelectorAll("button,select")
      .forEach((b) => (b.disabled = false));
    try {
      await refresh();
    } catch (e) {
      message(e.message, true);
    }
  }
}
$("role").onchange = () => refresh().catch((e) => message(e.message, true));
$("refresh").onclick = () => refresh().catch((e) => message(e.message, true));
$("create-form").onsubmit = (e) => {
  e.preventDefault();
  run(() =>
    transact(
      "Создание консультации",
      booking.createSlot(
        Math.floor(new Date($("start").value).getTime() / 1000),
        ethers.parseEther($("price").value),
      ),
    ),
  );
};
(async () => {
  try {
    const [c, t, b] = await Promise.all(
      ["/config.json", "/token.json", "/booking.json"].map((u) =>
        fetch(u).then((r) => {
          if (!r.ok) throw Error("Не удалось загрузить настройки сервиса");
          return r.json();
        }),
      ),
    );
    config = c;
    provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, {
      cacheTimeout: -1,
    });
    provider.pollingInterval = 100;
    if ((await provider.getNetwork()).chainId !== 1337n)
      throw Error("Выбрана неподдерживаемая сеть");
    token = new ethers.Contract(c.token, t.abi, provider);
    booking = new ethers.Contract(c.booking, b.abi, provider);
    const tomorrow = new Date(Date.now() + 86400000);
    $("start").value = new Date(
      tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
    await refresh();
    message("Расписание обновлено.");
  } catch (e) {
    message(e.message, true);
  }
})();

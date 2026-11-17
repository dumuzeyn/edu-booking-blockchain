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
const revealedMeetings = new Map();
let editingMeetingId = null;
async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Не удалось получить место проведения");
  return data;
}
async function meetingRequest(action, payload) {
  const address = await signer.getAddress();
  const challenge = await api("/meeting/challenge", { address, action,
    payloadHash: ethers.id(JSON.stringify(payload)) });
  const signature = await provider.send("eth_sign", [address, ethers.hexlify(ethers.toUtf8Bytes(challenge.message))]);
  return api("/meeting/" + action, { nonce: challenge.nonce, signature, payload });
}
function openMeetingEditor(id) {
  editingMeetingId = id;
  $("meeting-editor-title").textContent = "Место проведения консультации №" + (id + 1);
  $("existing-meeting-text").value = "";
  $("meeting-editor").hidden = false;
  $("existing-meeting-text").focus();
  $("meeting-editor").scrollIntoView({ behavior: "smooth", block: "center" });
}
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
  const [balance, escrow, tutorBalance, supply, count, block, meetingInfo] =
    await Promise.all([
      token.balanceOf(address),
      token.balanceOf(config.booking),
      token.balanceOf(config.tutor),
      token.totalSupply(),
      booking.slotCount(),
      provider.getBlock("latest"),
      api("/meeting/availability"),
    ]);
  $("balance").textContent = fmt(balance);
  $("escrow").textContent = fmt(escrow) + " EDU";
  $("tutorBalance").textContent = fmt(tutorBalance) + " EDU";
  $("supply").textContent = fmt(supply) + " EDU";
  $("create").hidden = $("role").value !== "tutor";
  if ($("role").value !== "tutor") $("meeting-editor").hidden = true;
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
    const place = document.createElement("td");
    place.className = "meeting-place";
    const isTutor = address.toLowerCase() === config.tutor.toLowerCase();
    const isStudent = address.toLowerCase() === s.student.toLowerCase();
    const canReadMeeting = isTutor || (isStudent && [1, 2].includes(Number(s.status)));
    if (meetingInfo.configured.includes(id) && canReadMeeting) {
      const savedText = revealedMeetings.get(address.toLowerCase() + ":" + id);
      if (savedText !== undefined) {
        const text = document.createElement("p"); text.textContent = savedText; place.append(text);
      } else {
        const show = document.createElement("button"); show.className = "secondary";
        show.textContent = "Показать место"; show.disabled = busy;
        show.onclick = () => run(async () => {
          const result = await meetingRequest("read", { slotId: id });
          revealedMeetings.set(address.toLowerCase() + ":" + id, result.text);
        });
        place.append(show);
      }
    } else if (!meetingInfo.configured.includes(id) && isTutor && [0, 1].includes(Number(s.status))) {
      const edit = document.createElement("button"); edit.className = "secondary";
      edit.textContent = "Указать место"; edit.disabled = busy; edit.onclick = () => openMeetingEditor(id);
      place.append(edit);
    } else {
      const hint = document.createElement("span");
      hint.textContent = meetingInfo.configured.includes(id) ? "Доступно владельцу брони" : "Место пока не указано";
      place.append(hint);
    }
    card.append(place);
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
  return r;
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
$("role").onchange = () => {
  revealedMeetings.clear();
  $("meeting-editor").hidden = true;
  refresh().catch((e) => message(e.message, true));
};
$("refresh").onclick = () => refresh().catch((e) => message(e.message, true));
$("create-form").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const text = $("meeting-text").value.trim();
    if (!text) throw Error("Укажите место проведения");
    const receipt = await transact(
      "Создание консультации",
      booking.createSlot(
        Math.floor(new Date($("start").value).getTime() / 1000),
        ethers.parseEther($("price").value),
      ),
    );
    const created = receipt.logs.map(log => {
      try { return booking.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === "SlotCreated");
    const slotId = Number(created.args.slotId);
    try {
      await meetingRequest("write", { slotId, text });
      message("Консультация №" + (slotId + 1) + " создана, место проведения сохранено.");
    } catch (error) {
      throw Error("Консультация создана. Место не сохранено: " + error.message + ". Нажмите «Указать место» в её строке.");
    }
  });
};
$("close-meeting-editor").onclick = () => { $("meeting-editor").hidden = true; };
$("meeting-form").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    await meetingRequest("write", { slotId: editingMeetingId, text: $("existing-meeting-text").value.trim() });
    $("meeting-editor").hidden = true;
    message("Место проведения сохранено.");
  });
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

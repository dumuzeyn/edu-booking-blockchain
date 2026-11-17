const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { JsonRpcProvider, Contract } = require("ethers");
const { createMeetingService } = require("./meeting-info.cjs");
const root = path.resolve(__dirname, "..");
const provider = new JsonRpcProvider("http://127.0.0.1:7545", undefined, { cacheTimeout: -1 });
const meeting = createMeetingService({
  file: path.join(root, "data/meeting-info.json"),
  async getContext() {
    const config = JSON.parse(fs.readFileSync(path.join(root, "deployments/local.json"), "utf8"));
    const abi = JSON.parse(fs.readFileSync(path.join(root, "build/contracts/ConsultationBooking.json"), "utf8")).abi;
    const booking = new Contract(config.booking, abi, provider);
    return { chainId: config.chainId, booking: config.booking, tutor: await booking.tutor(),
      async readSlot(slotId) {
        if (BigInt(slotId) >= await booking.slotCount()) throw Error("Консультация не найдена");
        return booking.slots(slotId);
      } };
  },
});
const routes = {
  "/": ["frontend/index.html", "text/html; charset=utf-8"],
  "/app.js": ["frontend/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["frontend/style.css", "text/css; charset=utf-8"],
  "/ethers.js": [
    "node_modules/ethers/dist/ethers.umd.min.js",
    "text/javascript",
  ],
  "/config.json": ["deployments/local.json", "application/json"],
  "/token.json": ["build/contracts/EduToken.json", "application/json"],
  "/booking.json": [
    "build/contracts/ConsultationBooking.json",
    "application/json",
  ],
};
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/meeting/")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      try {
        if (req.headers.origin && req.headers.origin !== "http://127.0.0.1:8080")
          throw Error("Недопустимый источник запроса");
        if (req.method === "GET" && url.pathname === "/meeting/availability")
          return res.end(JSON.stringify(await meeting.availability()));
        const actions = { "/meeting/challenge": "challenge", "/meeting/read": "read", "/meeting/write": "write" };
        if (req.method !== "POST" || !actions[url.pathname]) {
          res.writeHead(404); return res.end(JSON.stringify({ error: "Не найдено" }));
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16000) throw Error("Слишком большой запрос");
        }
        const result = await meeting[actions[url.pathname]](JSON.parse(body));
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      // Development only: same-origin requests; no remote listening or CORS.
      if (
        req.headers.origin &&
        req.headers.origin !== "http://127.0.0.1:8080"
      ) {
        res.writeHead(403);
        return res.end();
      }
      let body = "";
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 100000) throw Error("Request too large");
        }
        const data = JSON.parse(body);
        const batch = Array.isArray(data) ? data : [data];
        const methods = new Set([
          "eth_chainId",
          "net_version",
          "eth_accounts",
          "eth_sign",
          "eth_blockNumber",
          "eth_getBlockByNumber",
          "eth_getBalance",
          "eth_call",
          "eth_estimateGas",
          "eth_sendTransaction",
          "eth_getTransactionReceipt",
          "eth_getTransactionByHash",
          "eth_getTransactionCount",
          "eth_gasPrice",
          "eth_maxPriorityFeePerGas",
          "eth_feeHistory",
          "eth_getLogs",
          "eth_getCode",
        ]);
        if (!batch.every((x) => methods.has(x.method)))
          throw Error("Method blocked");
        const upstream = await fetch("http://127.0.0.1:7545", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(await upstream.text());
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    const route = routes[url.pathname];
    if (req.method !== "GET" || !route) {
      res.writeHead(404);
      return res.end("Not found");
    }
    try {
      res.writeHead(200, {
        "content-type": route[1],
        "cache-control": "no-store",
      });
      res.end(fs.readFileSync(path.join(root, route[0])));
    } catch {
      res.writeHead(503);
      res.end("Run npm run compile and npm run migrate first");
    }
  })
  .listen(8080, "127.0.0.1", () =>
    console.log(
      "EDU Booking: http://127.0.0.1:8080 — local demo accounts only",
    ),
  );

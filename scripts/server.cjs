const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
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

const https  = require("https");
const crypto = require("crypto");

const BYBIT_KEY      = process.env.BYBIT_KEY;
const BYBIT_SECRET   = process.env.BYBIT_SECRET;
const BINANCE_KEY    = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

const server = require("http").createServer((req, res) => {

  // ── BYBIT ──────────────────────────────────────────────────────
  if (req.url === "/bybit") {
    const ts         = Date.now().toString();
    const recvWindow = "5000";
    const paramStr   = ts + BYBIT_KEY + recvWindow;
    const signature  = crypto.createHmac("sha256", BYBIT_SECRET).update(paramStr).digest("hex");

    const options = {
      hostname: "api.bybit.com",
      path: "/v5/asset/coin/query-info",
      method: "GET",
      headers: {
        "X-BAPI-API-KEY":     BYBIT_KEY,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-SIGN":        signature,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "Accept":             "application/json"
      }
    };

    const proxy = https.request(options, bybitRes => {
      let data = "";
      bybitRes.on("data", chunk => data += chunk);
      bybitRes.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── BINANCE ────────────────────────────────────────────────────
  if (req.url === "/binance") {
    const ts  = Date.now().toString();
    const qs  = "timestamp=" + ts;
    const sig = crypto.createHmac("sha256", BINANCE_SECRET).update(qs).digest("hex");

    const options = {
      hostname: "api.binance.com",
      path: `/sapi/v1/capital/config/getall?${qs}&signature=${sig}`,
      method: "GET",
      headers: {
        "X-MBX-APIKEY": BINANCE_KEY,
        "Accept":       "application/json"
      }
    };

    const proxy = https.request(options, binRes => {
      let data = "";
      binRes.on("data", chunk => data += chunk);
      binRes.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── KRAKEN (public endpoint — no API key needed) ───────────────
  if (req.url === "/kraken") {
    const options = {
      hostname: "api.kraken.com",
      path: "/0/public/Assets",
      method: "GET",
      headers: { "Accept": "application/json" }
    };
      let pubData = "";
      pubRes.on("data", chunk => pubData += chunk);
      pubRes.on("end", () => {
        try {
          const parsed = JSON.parse(pubData);
          // Return asset list with status flags
          // Kraken public assets include status field: enabled/deposit_only/withdrawal_only/funding_temporarily_disabled
          const assets = parsed.result || {};
          const output = Object.entries(assets).map(([id, info]) => ({
            id,
            altname:  info.altname,
            status:   info.status  // "enabled" | "deposit_only" | "withdrawal_only" | "funding_temporarily_disabled"
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(output));
        } catch(e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    pubReq.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    pubReq.end();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Proxy running on port " + PORT));

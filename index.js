const https  = require("https");
const crypto = require("crypto");

const BYBIT_KEY      = process.env.BYBIT_KEY;
const BYBIT_SECRET   = process.env.BYBIT_SECRET;
const BINANCE_KEY    = process.env.BINANCE_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;
const KRAKEN_KEY     = process.env.KRAKEN_KEY;
const KRAKEN_SECRET  = process.env.KRAKEN_SECRET;

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

  // ── KRAKEN ─────────────────────────────────────────────────────
  if (req.url === "/kraken") {
    const path    = "/0/private/DepositMethods";
    const nonce   = Date.now().toString();
    const postData = "nonce=" + nonce;

    // Kraken signature: SHA256(nonce + postData) then HMAC-SHA512 with base64-decoded secret
    const secret     = Buffer.from(KRAKEN_SECRET, "base64");
    const hash       = crypto.createHash("sha256").update(nonce + postData).digest();
    const hmac       = crypto.createHmac("sha512", secret).update(Buffer.concat([Buffer.from(path), hash])).digest("base64");

    const options = {
      hostname: "api.kraken.com",
      path,
      method: "POST",
      headers: {
        "API-Key":      KRAKEN_KEY,
        "API-Sign":     hmac,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const proxy = https.request(options, krakenRes => {
      let data = "";
      krakenRes.on("data", chunk => data += chunk);
      krakenRes.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.write(postData);
    proxy.end();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Proxy running on port " + PORT));

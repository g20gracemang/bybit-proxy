const https = require("https");
const crypto = require("crypto");

const BYBIT_KEY    = process.env.BYBIT_KEY;
const BYBIT_SECRET = process.env.BYBIT_SECRET;

const server = require("http").createServer((req, res) => {
  if (req.url !== "/bybit") {
    res.writeHead(404);
    return res.end("Not found");
  }

  const ts        = Date.now().toString();
  const recvWindow = "5000";
  const paramStr  = ts + BYBIT_KEY + recvWindow;
  const signature = crypto.createHmac("sha256", BYBIT_SECRET).update(paramStr).digest("hex");

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

  const proxy = https.request(options, (bybitRes) => {
    let data = "";
    bybitRes.on("data", chunk => data += chunk);
    bybitRes.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    });
  });

  proxy.on("error", (e) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });

  proxy.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Bybit proxy running on port " + PORT));

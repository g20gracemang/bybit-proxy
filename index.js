const https  = require("https");
const crypto = require("crypto");

const BYBIT_KEY           = process.env.BYBIT_KEY;
const BYBIT_SECRET        = process.env.BYBIT_SECRET;
const BINANCE_KEY         = process.env.BINANCE_KEY;
const BINANCE_SECRET      = process.env.BINANCE_SECRET;
const COINBASE_KEY        = process.env.COINBASE_KEY;
const COINBASE_SECRET     = process.env.COINBASE_SECRET;
const COINBASE_PASSPHRASE = process.env.COINBASE_PASSPHRASE;
const KRAKEN_KEY          = process.env.KRAKEN_KEY;
const KRAKEN_SECRET       = process.env.KRAKEN_SECRET;

// ── KRAKEN SIGNATURE ───────────────────────────────────────────
function krakenSign(path, nonce, postData) {
  const secret = Buffer.from(KRAKEN_SECRET, "base64");
  const hash   = crypto.createHash("sha256").update(nonce + postData).digest();
  return crypto.createHmac("sha512", secret)
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest("base64");
}

function krakenPost(path, params) {
  return new Promise((resolve, reject) => {
    const nonce    = Date.now().toString();
    const postData = "nonce=" + nonce + (params ? "&" + params : "");
    const sign     = krakenSign(path, nonce, postData);
    const options  = {
      hostname: "api.kraken.com",
      path, method: "POST",
      headers: {
        "API-Key": KRAKEN_KEY, "API-Sign": sign,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, r => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

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

  // ── COINBASE (Exchange /currencies, network inferred from tx link) ──
  if (req.url === "/coinbase") {

    // Infer blockchain network from Coinbase's crypto_transaction_link
    function inferNetwork(txLink) {
      if (!txLink) return null;
      if (txLink.includes("etherscan.io"))          return "ETH";
      if (txLink.includes("explorer.solana.com"))   return "SOL";
      if (txLink.includes("explorer.cardano.org") ||
          txLink.includes("cardanoscan.io"))         return "ADA";
      if (txLink.includes("blockchain.com/btc") ||
          txLink.includes("blockstream.info"))       return "BTC";
      if (txLink.includes("tronscan.org"))           return "TRX";
      if (txLink.includes("bscscan.com"))            return "BSC";
      if (txLink.includes("polygonscan.com"))        return "MATIC";
      if (txLink.includes("arbiscan.io"))            return "ARB";
      if (txLink.includes("optimistic.etherscan") ||
          txLink.includes("optimism.io"))            return "OP";
      if (txLink.includes("basescan.org"))           return "BASE";
      if (txLink.includes("explorer.avax") ||
          txLink.includes("snowtrace.io"))           return "AVAX";
      if (txLink.includes("ftmscan.com"))            return "FTM";
      if (txLink.includes("nearblocks.io") ||
          txLink.includes("explorer.near.org"))      return "NEAR";
      if (txLink.includes("explorer.aptoslabs.com"))return "APT";
      if (txLink.includes("suiscan.xyz") ||
          txLink.includes("explorer.sui.io"))        return "SUI";
      if (txLink.includes("atomscan.com") ||
          txLink.includes("cosmos.bigdipper.live"))  return "ATOM";
      if (txLink.includes("minascan.io") ||
          txLink.includes("minaexplorer.com"))       return "MINA";
      if (txLink.includes("explorer.icp") ||
          txLink.includes("dashboard.internetcomputer.org")) return "ICP";
      if (txLink.includes("xrpscan.com") ||
          txLink.includes("livenet.xrpl.org"))       return "XRP";
      if (txLink.includes("explorer.helium.com"))   return "HNT";
      if (txLink.includes("elamainscan.io") ||
          txLink.includes("blockchain.elastos.org"))return "ELA";
      if (txLink.includes("zenscan.io") ||
          txLink.includes("explorer.horizen.io"))   return "ZEN";
      if (txLink.includes("vechainstats.com") ||
          txLink.includes("explore.vechain.org"))   return "VET";
      if (txLink.includes("algoexplorer.io") ||
          txLink.includes("explorer.perawallet.app")) return "ALGO";
      if (txLink.includes("explorer.celo.org"))     return "CELO";
      if (txLink.includes("stellarchain.io") ||
          txLink.includes("stellar.expert"))        return "XLM";
      if (txLink.includes("tzstats.com") ||
          txLink.includes("tzkt.io"))               return "XTZ";
      if (txLink.includes("flowscan.org") ||
          txLink.includes("flowdiver.io"))          return "FLOW";
      if (txLink.includes("basescan.org"))          return "BASE";
      if (txLink.includes("lineascan.build"))       return "LINEA";
      return null;
    }

    const ts     = Math.floor(Date.now() / 1000).toString();
    const secret = Buffer.from(COINBASE_SECRET, "base64");
    const sig    = crypto.createHmac("sha256", secret).update(ts + "GET/currencies").digest("base64");

    const opts = {
      hostname: "api.exchange.coinbase.com",
      path: "/currencies", method: "GET",
      headers: {
        "CB-ACCESS-KEY":        COINBASE_KEY,
        "CB-ACCESS-SIGN":       sig,
        "CB-ACCESS-TIMESTAMP":  ts,
        "CB-ACCESS-PASSPHRASE": COINBASE_PASSPHRASE,
        "User-Agent": "sexta-tracker/1.0",
        "Accept": "application/json"
      }
    };

    const proxy = https.request(opts, cbRes => {
      let data = "";
      cbRes.on("data", c => data += c);
      cbRes.on("end", () => {
        try {
          const currencies = JSON.parse(data);
          const result = currencies.map(c => {
            const id      = c.id.toUpperCase();
            const details = c.details || {};
            const network = inferNetwork(details.crypto_transaction_link) || id;
            return {
              id:              c.id,
              status:          c.status,
              network,
              deposit_enabled:  c.status === "online",
              withdraw_enabled: c.status === "online"
            };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch(e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── KRAKEN (hybrid: per-network deposit + public withdrawal status) ──
  if (req.url === "/kraken") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const tickers = body.split(",").map(t => t.trim()).filter(Boolean);
      if (!tickers.length) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No tickers provided" }));
        return;
      }

      const pubReq = https.request({
        hostname: "api.kraken.com", path: "/0/public/Assets",
        method: "GET", headers: { "Accept": "application/json" }
      }, pubRes => {
        let pubData = "";
        pubRes.on("data", c => pubData += c);
        pubRes.on("end", () => {
          let altToId = {}, wdStatus = {};
          try {
            const assets = JSON.parse(pubData).result || {};
            Object.entries(assets).forEach(([id, info]) => {
              const alt = info.altname.toUpperCase();
              altToId[alt] = id;
              altToId[id.toUpperCase()] = id;
              const wdOk = info.status === "enabled" || info.status === "withdrawal_only";
              wdStatus[id]  = wdOk;
              wdStatus[alt] = wdOk;
            });
          } catch(e) {}

          const promises = tickers.map((coin, i) =>
            new Promise(resolve => setTimeout(() => {
              const krakenId = altToId[coin.toUpperCase()] || coin;
              const wdOk     = wdStatus[coin.toUpperCase()] !== undefined
                                 ? wdStatus[coin.toUpperCase()]
                                 : true;

              krakenPost("/0/private/DepositMethods", "asset=" + krakenId)
                .then(depData => {
                  const depMethods = (depData.result || []).map(m => m.method);
                  if (depMethods.length === 0) {
                    const coinStatus = wdStatus[coin.toUpperCase()];
                    resolve([{
                      coin,
                      network: "ALL NETWORKS",
                      depositEnable:  coinStatus !== undefined ? coinStatus : true,
                      withdrawEnable: wdOk
                    }]);
                    return;
                  }
                  const rows = depMethods.map(network => ({
                    coin,
                    network,
                    depositEnable:  true,
                    withdrawEnable: wdOk
                  }));
                  resolve(rows);
                })
                .catch(() => resolve([]));
            }, i * 150))
          );

          Promise.all(promises).then(arrays => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(arrays.flat()));
          }).catch(e => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          });
        });
      });
      pubReq.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      pubReq.end();
    });
    return;
  }

  // ── COINBASE DEBUG (shows raw details for first 3 coins) ──────
  if (req.url === "/coinbase-debug") {
    const ts     = Math.floor(Date.now() / 1000).toString();
    const secret = Buffer.from(COINBASE_SECRET, "base64");
    const sig    = crypto.createHmac("sha256", secret).update(ts + "GET/currencies").digest("base64");
    const opts   = {
      hostname: "api.exchange.coinbase.com",
      path: "/currencies", method: "GET",
      headers: {
        "CB-ACCESS-KEY": COINBASE_KEY, "CB-ACCESS-SIGN": sig,
        "CB-ACCESS-TIMESTAMP": ts, "CB-ACCESS-PASSPHRASE": COINBASE_PASSPHRASE,
        "User-Agent": "sexta-tracker/1.0", "Accept": "application/json"
      }
    };
    const r = https.request(opts, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => {
        try {
          const all    = JSON.parse(d);
          // Return first 3 coins with full details intact so we can inspect structure
          const sample = all.slice(0, 3).map(c => ({ id: c.id, status: c.status, details: c.details }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sample, null, 2));
        } catch(e) { res.writeHead(500); res.end(d); }
      });
    });
    r.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    r.end();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Proxy running on port " + PORT));

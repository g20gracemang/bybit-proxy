const https   = require("https");
const http    = require("http");
const crypto  = require("crypto");

const BYBIT_KEY           = process.env.BYBIT_KEY;
const BYBIT_SECRET        = process.env.BYBIT_SECRET;
const BINANCE_KEY         = process.env.BINANCE_KEY;
const BINANCE_SECRET      = process.env.BINANCE_SECRET;
const COINBASE_KEY        = process.env.COINBASE_KEY;
const COINBASE_SECRET     = process.env.COINBASE_SECRET;
const COINBASE_PASSPHRASE = process.env.COINBASE_PASSPHRASE;
const KRAKEN_KEY          = process.env.KRAKEN_KEY;
const KRAKEN_SECRET       = process.env.KRAKEN_SECRET;
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;

// ── IN-MEMORY DATA STORE ───────────────────────────────────────
// Stores latest DP/WD data pushed from Apps Script
let dpwdData    = [];  // [{ exchange, symbol, network, dep, wd, timestamp }]
let lastSync    = "";
// Stores per-user conversation state
const userState = {};  // { chatId: { step, token } }

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

// ── TELEGRAM HELPERS ──────────────────────────────────────────
function tgRequest(method, payload) {
  return new Promise((resolve) => {
    const body    = JSON.stringify(payload);
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

function answerCallback(callbackQueryId) {
  return tgRequest("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

// ── KEYBOARD BUILDERS ─────────────────────────────────────────
const EXCHANGES = ["OKX", "KuCoin", "Gate.io", "MEXC", "Bitget", "Bybit", "Binance", "Coinbase", "Kraken"];

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔍 Search Token",    callback_data: "menu_search"  },
       { text: "📊 Health Scores",   callback_data: "menu_health"  }],
      [{ text: "🚨 Suspensions",     callback_data: "menu_suspend" },
       { text: "✅ All Open Tokens", callback_data: "menu_open"    }],
      [{ text: "❓ Help",            callback_data: "menu_help"    }]
    ]
  };
}

function exchangeKeyboard(prefix) {
  const rows = [];
  const btns = [{ text: "🏢 All Exchanges", callback_data: `${prefix}_ALL` }];
  rows.push(btns);
  const exchBtns = EXCHANGES.map(e => ({ text: e, callback_data: `${prefix}_${e}` }));
  for (let i = 0; i < exchBtns.length; i += 3)
    rows.push(exchBtns.slice(i, i + 3));
  rows.push([{ text: "🔙 Back", callback_data: "menu_back" }]);
  return { inline_keyboard: rows };
}

function filterKeyboard(token, exchange) {
  const enc = encodeURIComponent(exchange);
  return {
    inline_keyboard: [
      [{ text: "✅ Open Only",      callback_data: `filter_open_${token}_${enc}`      },
       { text: "❌ Suspended Only", callback_data: `filter_suspended_${token}_${enc}` },
       { text: "📋 All",           callback_data: `filter_all_${token}_${enc}`        }],
      [{ text: "🔙 Back", callback_data: "menu_back" }]
    ]
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu_back" }]] };
}

// ── BOT RESPONSE BUILDERS ─────────────────────────────────────
function buildHealthScores() {
  if (dpwdData.length === 0) return "⚠️ No data available yet. Please wait for the next sync.";
  const exchData = {};
  EXCHANGES.forEach(e => exchData[e] = { total: 0, healthy: 0 });
  dpwdData.forEach(r => {
    if (!exchData[r.exchange]) return;
    exchData[r.exchange].total++;
    if (r.dep === "✅" && r.wd === "✅") exchData[r.exchange].healthy++;
  });
  const sorted = EXCHANGES.map(e => {
    const d     = exchData[e];
    const score = d.total > 0 ? Math.round((d.healthy / d.total) * 100) : 100;
    const emoji = score >= 90 ? "🟢" : score >= 70 ? "🟡" : "🔴";
    return { e, score, d, emoji };
  }).sort((a, b) => b.score - a.score);

  let msg = `📊 <b>EXCHANGE HEALTH SCORES</b>\n🕙 Last sync: ${lastSync}\n\n`;
  sorted.forEach(({ e, score, d, emoji }) => {
    msg += `${emoji} <b>${e}</b>: ${score}% (${d.healthy}/${d.total})\n`;
  });
  return msg;
}

function buildSuspensions(exchange) {
  if (dpwdData.length === 0) return "⚠️ No data available yet. Please wait for the next sync.";
  const rows = dpwdData.filter(r =>
    (exchange === "ALL" || r.exchange === exchange) &&
    (r.dep === "❌" || r.wd === "❌")
  );
  if (rows.length === 0)
    return exchange === "ALL"
      ? "✅ <b>ALL SYSTEMS CLEAR</b>\nNo suspensions detected across all exchanges."
      : `✅ <b>No suspensions</b> on ${exchange}.`;

  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.exchange]) grouped[r.exchange] = [];
    const label = r.dep === "❌" && r.wd === "❌" ? "DP & WD ❌" : r.dep === "❌" ? "DP ❌" : "WD ❌";
    grouped[r.exchange].push(`• ${r.symbol} (${r.network}) | ${label}`);
  });

  let msg = `🚨 <b>SUSPENSIONS${exchange !== "ALL" ? " — " + exchange : ""}</b>\n🕙 Last sync: ${lastSync}\n\n`;
  Object.entries(grouped).forEach(([exch, lines]) => {
    msg += `🏢 <b>${exch}</b>\n${lines.join("\n")}\n\n`;
  });
  return msg.trim();
}

function buildTokenResult(token, exchange, filter) {
  if (dpwdData.length === 0) return "⚠️ No data available yet. Please wait for the next sync.";
  let rows = dpwdData.filter(r =>
    r.symbol === token.toUpperCase() &&
    (exchange === "ALL" || r.exchange === exchange)
  );
  if (rows.length === 0)
    return `❌ <b>${token.toUpperCase()}</b> not found${exchange !== "ALL" ? " on " + exchange : ""}.\n\nMake sure the token is in your Tickers sheet.`;

  if (filter === "open")      rows = rows.filter(r => r.dep === "✅" && r.wd === "✅");
  if (filter === "suspended") rows = rows.filter(r => r.dep === "❌" || r.wd === "❌");

  if (rows.length === 0)
    return filter === "open"
      ? `❌ No open networks for <b>${token.toUpperCase()}</b>${exchange !== "ALL" ? " on " + exchange : ""}.`
      : `✅ No suspensions for <b>${token.toUpperCase()}</b>${exchange !== "ALL" ? " on " + exchange : ""}.`;

  let msg = `🔍 <b>${token.toUpperCase()}</b>${exchange !== "ALL" ? " on " + exchange : " — All Exchanges"}\n🕙 Last sync: ${lastSync}\n\n`;
  rows.forEach(r => {
    const depIcon = r.dep === "✅" ? "✅" : "❌";
    const wdIcon  = r.wd  === "✅" ? "✅" : "❌";
    msg += `🏢 <b>${r.exchange}</b> | ${r.network}\n   DP ${depIcon}  WD ${wdIcon}\n`;
  });
  return msg.trim();
}

function buildAllOpen(exchange) {
  if (dpwdData.length === 0) return "⚠️ No data available yet. Please wait for the next sync.";
  const rows = dpwdData.filter(r =>
    (exchange === "ALL" || r.exchange === exchange) &&
    r.dep === "✅" && r.wd === "✅"
  );
  if (rows.length === 0) return `❌ No open tokens found${exchange !== "ALL" ? " on " + exchange : ""}.`;

  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.exchange]) grouped[r.exchange] = [];
    grouped[r.exchange].push(`• ${r.symbol} (${r.network})`);
  });

  let msg = `✅ <b>ALL OPEN TOKENS${exchange !== "ALL" ? " — " + exchange : ""}</b>\n🕙 Last sync: ${lastSync}\n\n`;
  Object.entries(grouped).forEach(([exch, lines]) => {
    msg += `🏢 <b>${exch}</b>\n${lines.join("\n")}\n\n`;
  });
  return msg.trim();
}

const HELP_TEXT = `❓ <b>SEXTA-TRACKER BOT GUIDE</b>

<b>How to search:</b>
Type any token symbol directly (e.g. <code>SOL</code>, <code>BTC</code>) and the bot will guide you step by step.

<b>Main Menu buttons:</b>
🔍 <b>Search Token</b> — Check deposit & withdrawal status for any token across exchanges
📊 <b>Health Scores</b> — See overall health % for all exchanges
🚨 <b>Suspensions</b> — See all currently suspended deposits or withdrawals
✅ <b>All Open Tokens</b> — See all tokens with open DP & WD
❓ <b>Help</b> — Show this guide

<b>Search filters:</b>
✅ Open Only — show only open networks
❌ Suspended Only — show only suspended networks
📋 All — show everything

<b>Tips:</b>
• You can skip the menu and just type a token name anytime
• Say <b>hi</b> or <b>hello</b> to show the main menu
• Data refreshes every 10 minutes`;

// ── HANDLE TELEGRAM UPDATE ────────────────────────────────────
async function handleUpdate(update) {
  // ── Callback query (button press) ──
  if (update.callback_query) {
    const cb     = update.callback_query;
    const chatId = cb.message.chat.id;
    const data   = cb.data;
    await answerCallback(cb.id);

    if (data === "menu_back" || data === "menu_start") {
      userState[chatId] = {};
      return sendMessage(chatId, "👋 Hello, what would you like to do?", { reply_markup: mainMenuKeyboard() });
    }
    if (data === "menu_search") {
      userState[chatId] = { step: "awaiting_token" };
      return sendMessage(chatId, "🔍 Please type the token symbol:\n<i>e.g. SOL, BTC, ETH</i>", { reply_markup: backKeyboard() });
    }
    if (data === "menu_health") {
      return sendMessage(chatId, buildHealthScores(), { reply_markup: backKeyboard() });
    }
    if (data === "menu_suspend") {
      userState[chatId] = { step: "suspensions" };
      return sendMessage(chatId, "🚨 Choose an exchange:", { reply_markup: exchangeKeyboard("suspend") });
    }
    if (data === "menu_open") {
      userState[chatId] = { step: "open" };
      return sendMessage(chatId, "✅ Choose an exchange:", { reply_markup: exchangeKeyboard("open") });
    }
    if (data === "menu_help") {
      return sendMessage(chatId, HELP_TEXT, { reply_markup: backKeyboard() });
    }

    // Suspension exchange selected
    if (data.startsWith("suspend_")) {
      const exchange = decodeURIComponent(data.replace("suspend_", ""));
      return sendMessage(chatId, buildSuspensions(exchange), { reply_markup: backKeyboard() });
    }

    // All open exchange selected
    if (data.startsWith("open_")) {
      const exchange = decodeURIComponent(data.replace("open_", ""));
      return sendMessage(chatId, buildAllOpen(exchange), { reply_markup: backKeyboard() });
    }

    // Token exchange selected — show filter
    if (data.startsWith("token_")) {
      const exchange = decodeURIComponent(data.replace("token_", ""));
      const token    = (userState[chatId] && userState[chatId].token) || "";
      if (!token) return sendMessage(chatId, "⚠️ Session expired. Please search again.", { reply_markup: mainMenuKeyboard() });
      return sendMessage(chatId, `🔍 <b>${token}</b> on <b>${exchange === "ALL" ? "All Exchanges" : exchange}</b>\nFilter results:`,
        { reply_markup: filterKeyboard(token, exchange) });
    }

    // Filter selected
    if (data.startsWith("filter_")) {
      const parts    = data.split("_");
      const filter   = parts[1];
      const token    = parts[2];
      const exchange = decodeURIComponent(parts.slice(3).join("_"));
      return sendMessage(chatId, buildTokenResult(token, exchange, filter), { reply_markup: backKeyboard() });
    }

    return;
  }

  // ── Text message ──
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text   = update.message.text.trim();
    const lower  = text.toLowerCase();
    const state  = userState[chatId] || {};

    // Greetings or /start
    if (lower === "/start" || lower === "hi" || lower === "hello" || lower === "hey") {
      userState[chatId] = {};
      return sendMessage(chatId, "👋 Hello, what would you like to do?", { reply_markup: mainMenuKeyboard() });
    }

    // Awaiting token input after pressing Search Token button
    if (state.step === "awaiting_token") {
      const token = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!token) return sendMessage(chatId, "⚠️ Please enter a valid token symbol.", { reply_markup: backKeyboard() });
      const exists = dpwdData.some(r => r.symbol === token);
      if (!exists) return sendMessage(chatId,
        `❌ <b>${token}</b> not found in tracked tokens.\n\nMake sure it is added to your Tickers sheet.`,
        { reply_markup: backKeyboard() });
      userState[chatId] = { step: "awaiting_exchange", token };
      return sendMessage(chatId, `🔍 <b>${token}</b> found! Choose an exchange:`,
        { reply_markup: exchangeKeyboard("token") });
    }

    // Direct token input — skip menu
    const token = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (token.length >= 2 && token.length <= 10) {
      const exists = dpwdData.some(r => r.symbol === token);
      if (exists) {
        userState[chatId] = { step: "awaiting_exchange", token };
        return sendMessage(chatId, `🔍 <b>${token}</b> found! Choose an exchange:`,
          { reply_markup: exchangeKeyboard("token") });
      }
    }

    // Fallback
    userState[chatId] = {};
    return sendMessage(chatId, "👋 Hello, what would you like to do?", { reply_markup: mainMenuKeyboard() });
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // ── BYBIT ──────────────────────────────────────────────────
  if (req.url === "/bybit") {
    const ts         = Date.now().toString();
    const recvWindow = "5000";
    const paramStr   = ts + BYBIT_KEY + recvWindow;
    const signature  = crypto.createHmac("sha256", BYBIT_SECRET).update(paramStr).digest("hex");
    const options = {
      hostname: "api.bybit.com", path: "/v5/asset/coin/query-info", method: "GET",
      headers: { "X-BAPI-API-KEY": BYBIT_KEY, "X-BAPI-TIMESTAMP": ts, "X-BAPI-SIGN": signature, "X-BAPI-RECV-WINDOW": recvWindow, "Accept": "application/json" }
    };
    const proxy = https.request(options, bybitRes => {
      let data = "";
      bybitRes.on("data", chunk => data += chunk);
      bybitRes.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(data); });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── BINANCE ────────────────────────────────────────────────
  if (req.url === "/binance") {
    const ts  = Date.now().toString();
    const qs  = "timestamp=" + ts;
    const sig = crypto.createHmac("sha256", BINANCE_SECRET).update(qs).digest("hex");
    const options = {
      hostname: "api.binance.com", path: `/sapi/v1/capital/config/getall?${qs}&signature=${sig}`, method: "GET",
      headers: { "X-MBX-APIKEY": BINANCE_KEY, "Accept": "application/json" }
    };
    const proxy = https.request(options, binRes => {
      let data = "";
      binRes.on("data", chunk => data += chunk);
      binRes.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(data); });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── COINBASE ───────────────────────────────────────────────
  if (req.url === "/coinbase") {
    function inferNetwork(txLink) {
      if (!txLink) return null;
      if (txLink.includes("etherscan.io"))           return "ETH";
      if (txLink.includes("explorer.solana.com"))    return "SOL";
      if (txLink.includes("explorer.cardano.org") ||
          txLink.includes("cardanoscan.io"))          return "ADA";
      if (txLink.includes("live.blockcypher.com/btc") ||
          txLink.includes("blockstream.info"))        return "BTC";
      if (txLink.includes("tronscan.org"))            return "TRX";
      if (txLink.includes("bscscan.com"))             return "BSC";
      if (txLink.includes("polygonscan.com"))         return "MATIC";
      if (txLink.includes("arbiscan.io"))             return "ARB";
      if (txLink.includes("optimistic.etherscan") ||
          txLink.includes("optimism.io"))             return "OP";
      if (txLink.includes("basescan.org") ||
          txLink.includes("basescan.io"))             return "BASE";
      if (txLink.includes("snowscan.xyz") ||
          txLink.includes("snowtrace.io") ||
          txLink.includes("cchain.explorer.avax"))    return "AVAX";
      if (txLink.includes("blastscan.io"))            return "BLAST";
      if (txLink.includes("tonscan.org"))             return "TON";
      if (txLink.includes("explorer.sui.io") ||
          txLink.includes("suiscan.xyz"))             return "SUI";
      if (txLink.includes("taostats.io"))             return "TAO";
      if (txLink.includes("sonicscan.org"))           return "SONIC";
      if (txLink.includes("monadexplorer.com"))       return "MONAD";
      if (txLink.includes("explorer.zksync.io"))      return "ZKSYNC";
      if (txLink.includes("hashscan.io"))             return "HBAR";
      if (txLink.includes("minaexplorer.com"))        return "MINA";
      if (txLink.includes("assethub-polkadot") ||
          txLink.includes("assethub-kusama"))         return "DOT";
      if (txLink.includes("explore.vechain.org"))     return "VET";
      if (txLink.includes("explorer.near.org") ||
          txLink.includes("wallet.near.org"))         return "NEAR";
      if (txLink.includes("bithomp.com"))             return "XRP";
      if (txLink.includes("stellar.expert"))          return "XLM";
      if (txLink.includes("tzstats.com"))             return "XTZ";
      if (txLink.includes("flowscan.org"))            return "FLOW";
      if (txLink.includes("mintscan.io"))             return "COSMOS";
      if (txLink.includes("filfox.info"))             return "FIL";
      if (txLink.includes("explorer.stacks.co"))      return "STX";
      if (txLink.includes("scan.coredao.org"))        return "CORE";
      if (txLink.includes("axelarscan.io"))           return "AXL";
      if (txLink.includes("oasisscan.com"))           return "ROSE";
      if (txLink.includes("hyperscan.com"))           return "HYPE";
      if (txLink.includes("routescan.io"))            return "BERA";
      if (txLink.includes("dogechain.info"))          return "DOGE";
      if (txLink.includes("live.blockcypher.com/ltc")) return "LTC";
      if (txLink.includes("blockchair.com/bitcoin-cash")) return "BCH";
      if (txLink.includes("algoexplorer.io"))         return "ALGO";
      if (txLink.includes("explorer.celo.org"))       return "CELO";
      if (txLink.includes("explorer.aptoslabs.com"))  return "APT";
      if (txLink.includes("explorer.provable.com"))   return "ALEO";
      if (txLink.includes("explorer.elrond.com"))     return "EGLD";
      if (txLink.includes("flare-explorer.flare"))    return "FLR";
      if (txLink.includes("lineascan.build"))         return "LINEA";
      return null;
    }

    const ts     = Math.floor(Date.now() / 1000).toString();
    const secret = Buffer.from(COINBASE_SECRET, "base64");
    const sig    = crypto.createHmac("sha256", secret).update(ts + "GET/currencies").digest("base64");
    const opts   = {
      hostname: "api.exchange.coinbase.com", path: "/currencies", method: "GET",
      headers: { "CB-ACCESS-KEY": COINBASE_KEY, "CB-ACCESS-SIGN": sig, "CB-ACCESS-TIMESTAMP": ts, "CB-ACCESS-PASSPHRASE": COINBASE_PASSPHRASE, "User-Agent": "sexta-tracker/1.0", "Accept": "application/json" }
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
            return { id: c.id, status: c.status, network, deposit_enabled: c.status === "online", withdraw_enabled: c.status === "online" };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
    });
    proxy.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxy.end();
    return;
  }

  // ── KRAKEN ─────────────────────────────────────────────────
  if (req.url === "/kraken") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const tickers = body.split(",").map(t => t.trim()).filter(Boolean);
      if (!tickers.length) { res.writeHead(400); res.end(JSON.stringify({ error: "No tickers provided" })); return; }
      const pubReq = https.request({
        hostname: "api.kraken.com", path: "/0/public/Assets", method: "GET", headers: { "Accept": "application/json" }
      }, pubRes => {
        let pubData = "";
        pubRes.on("data", c => pubData += c);
        pubRes.on("end", () => {
          let altToId = {}, wdStatus = {};
          try {
            const assets = JSON.parse(pubData).result || {};
            Object.entries(assets).forEach(([id, info]) => {
              const alt = info.altname.toUpperCase();
              altToId[alt] = id; altToId[id.toUpperCase()] = id;
              const wdOk = info.status === "enabled" || info.status === "withdrawal_only";
              wdStatus[id] = wdOk; wdStatus[alt] = wdOk;
            });
          } catch(e) {}
          const promises = tickers.map((coin, i) =>
            new Promise(resolve => setTimeout(() => {
              const krakenId = altToId[coin.toUpperCase()] || coin;
              const wdOk     = wdStatus[coin.toUpperCase()] !== undefined ? wdStatus[coin.toUpperCase()] : true;
              krakenPost("/0/private/DepositMethods", "asset=" + krakenId)
                .then(depData => {
                  const depMethods = (depData.result || []).map(m => m.method);
                  if (depMethods.length === 0) {
                    resolve([{ coin, network: "ALL NETWORKS", depositEnable: wdStatus[coin.toUpperCase()] !== undefined ? wdStatus[coin.toUpperCase()] : true, withdrawEnable: wdOk }]);
                    return;
                  }
                  resolve(depMethods.map(network => ({ coin, network, depositEnable: true, withdrawEnable: wdOk })));
                })
                .catch(() => resolve([]));
            }, i * 150))
          );
          Promise.all(promises).then(arrays => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(arrays.flat()));
          }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        });
      });
      pubReq.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      pubReq.end();
    });
    return;
  }

  // ── COINBASE DEBUG ─────────────────────────────────────────
  if (req.url.startsWith("/coinbase-debug")) {
    const qs     = req.url.includes("?") ? req.url.split("?")[1] : "";
    const param  = new URLSearchParams(qs).get("coins");
    const filter = param ? param.toUpperCase().split(",").map(s => s.trim()) : [];
    const ts     = Math.floor(Date.now() / 1000).toString();
    const secret = Buffer.from(COINBASE_SECRET, "base64");
    const sig    = crypto.createHmac("sha256", secret).update(ts + "GET/currencies").digest("base64");
    const opts   = {
      hostname: "api.exchange.coinbase.com", path: "/currencies", method: "GET",
      headers: { "CB-ACCESS-KEY": COINBASE_KEY, "CB-ACCESS-SIGN": sig, "CB-ACCESS-TIMESTAMP": ts, "CB-ACCESS-PASSPHRASE": COINBASE_PASSPHRASE, "User-Agent": "sexta-tracker/1.0", "Accept": "application/json" }
    };
    const r = https.request(opts, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => {
        try {
          const all    = JSON.parse(d);
          const sample = all.filter(c => filter.length === 0 || filter.includes(c.id.toUpperCase()))
                            .map(c => ({ id: c.id, status: c.status, details: c.details }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sample, null, 2));
        } catch(e) { res.writeHead(500); res.end(d); }
      });
    });
    r.on("error", e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    r.end();
    return;
  }

  // ── DATA PUSH (from Apps Script) ──────────────────────────
  if (req.url === "/data" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (payload.data && Array.isArray(payload.data)) {
          dpwdData = payload.data;
          lastSync = payload.lastSync || "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, rows: dpwdData.length }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: "Invalid payload" }));
        }
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // ── TELEGRAM WEBHOOK ──────────────────────────────────────
  if (req.url === "/webhook") {
    if (req.method !== "POST") {
      res.writeHead(200); res.end("webhook ok - awaiting POST");
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      console.log("📩 Webhook received:", body.slice(0, 200));
      try {
        const update = JSON.parse(body);
        handleUpdate(update).catch(e => console.log("❌ handleUpdate error:", e));
      } catch(e) {
        console.log("❌ Webhook parse error:", e.message);
      }
      res.writeHead(200); res.end("ok");
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Proxy running on port " + PORT));

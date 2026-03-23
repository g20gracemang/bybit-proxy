const https = require("https");

const server = require("http").createServer((req, res) => {
  if (req.url !== "/bybit") {
    res.writeHead(404);
    return res.end("Not found");
  }

  const options = {
    hostname: "api.bybit.com",
    path: "/v5/asset/coin/query-info",
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0"
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
server.listen(PORT, () => console.log("Proxy running on port " + PORT));

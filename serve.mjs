// Minimal production-ish static server in JS (Node 18+)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import https from "https";
import express from "express";
import compression from "compression";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Gzip/deflate
app.use(compression());

// Static files with sensible caching
app.use(express.static(__dirname, {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("manifest.webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json");
      res.setHeader("Cache-Control", "no-cache");
      return;
    }
    if (filePath.endsWith("sw.js")) {
      // service worker should be revalidated
      res.setHeader("Cache-Control", "no-cache");
    } else if (/\.(css|js|png|jpg|svg|webp|ico|json)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }
}));

app.use((req, res, next) => {
  // only fall back for GET requests that weren’t served (SPA-style)
  if (req.method !== "GET") return next();
  res.sendFile(path.join(__dirname, "index.html"));
});
function start() {
  const keyPath = process.env.SSL_KEY;
  const certPath = process.env.SSL_CERT;

  if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    https.createServer({ key, cert }, app).listen(PORT, () => {
      console.log(`HTTPS on https://localhost:${PORT}`);
    });
  } else {
    http.createServer(app).listen(PORT, () => {
      console.log(`HTTP on  http://localhost:${PORT}`);
      console.log("Tip: set SSL_KEY & SSL_CERT env vars for HTTPS (PWA on mobile over LAN).");
    });
  }
}
start();


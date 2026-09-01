import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppConfig } from "../types.js";
import { PUBLIC_DIR, STREAMS_DIR } from "../config.js";
import { isValidIpv4 } from "../scanner/cidr.js";
import type { ScanOrchestrator } from "../scanner/scanOrchestrator.js";
import type { StreamManager } from "./streams.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function safeJoin(root: string, reqPath: string): string | null {
  const decoded = decodeURIComponent(reqPath.split("?")[0] ?? "");
  const cleaned = decoded.replace(/^\/+/, "");
  const rootResolved = resolve(root);
  const full = resolve(join(rootResolved, cleaned));
  const rel = relative(rootResolved, full);
  if (rel.startsWith("..") || rel === ".." || normalize(rel).startsWith(`..${sep}`)) {
    return null;
  }
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    return null;
  }
  return full;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveFile(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": ext === ".m3u8" || ext === ".ts" ? "no-cache" : "public, max-age=60",
  });
  createReadStream(filePath).pipe(res);
}

export interface ApiDeps {
  getConfig: () => AppConfig;
  orchestrator: ScanOrchestrator;
  streams: StreamManager;
}

export function createApiServer(deps: ApiDeps): Server {
  const { getConfig, orchestrator, streams } = deps;
  const sseClients = new Set<ServerResponse>();

  const unsubscribe = orchestrator.onProgress((progress) => {
    const payload = `data: ${JSON.stringify(progress)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const host = req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;

      if (method === "GET" && path === "/api/cameras") {
        const cameras = await orchestrator.loadCameras();
        sendJson(res, 200, cameras);
        return;
      }

      if (method === "GET" && path === "/api/scan/status") {
        sendJson(res, 200, orchestrator.getProgress());
        return;
      }

      if (method === "GET" && path === "/api/scan/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(orchestrator.getProgress())}\n\n`);
        sseClients.add(res);
        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === "POST" && path === "/api/scan") {
        if (orchestrator.isRunning()) {
          sendJson(res, 409, { error: "Scan already running", progress: orchestrator.getProgress() });
          return;
        }
        const bodyText = await readBody(req).catch(() => "");
        let fresh = url.searchParams.get("fresh") === "1";
        if (bodyText) {
          try {
            const body = JSON.parse(bodyText) as { fresh?: boolean };
            if (body.fresh) fresh = true;
          } catch {
            /* ignore */
          }
        }
        void orchestrator.start({ fresh }).catch((err) => {
          console.error("[scan] failed:", err);
        });
        sendJson(res, 202, {
          ok: true,
          message: fresh ? "Scan started (fresh)" : "Scan started (resumes if checkpoint exists)",
          progress: orchestrator.getProgress(),
        });
        return;
      }

      if (method === "POST" && path === "/api/scan/stop") {
        void readBody(req).catch(() => "");
        if (!orchestrator.isRunning()) {
          sendJson(res, 200, { ok: true, message: "No scan running", progress: orchestrator.getProgress() });
          return;
        }
        const progress = await orchestrator.stop();
        sendJson(res, 200, { ok: true, message: "Scan stopped — progress saved", progress });
        return;
      }

      const favoriteMatch = /^\/api\/cameras\/([^/]+)\/favorite$/.exec(path);
      if (favoriteMatch && method === "POST") {
        const ip = decodeURIComponent(favoriteMatch[1] ?? "");
        if (!isValidIpv4(ip)) {
          sendJson(res, 400, { error: "Invalid IP" });
          return;
        }
        const bodyText = await readBody(req).catch(() => "");
        let favorite = true;
        if (bodyText) {
          try {
            const body = JSON.parse(bodyText) as { favorite?: boolean };
            if (typeof body.favorite === "boolean") favorite = body.favorite;
          } catch {
            /* ignore */
          }
        }
        try {
          const camera = await orchestrator.setFavorite(ip, favorite);
          sendJson(res, 200, { ok: true, camera });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      const streamMatch = /^\/api\/cameras\/([^/]+)\/stream$/.exec(path);
      if (streamMatch) {
        const ip = decodeURIComponent(streamMatch[1] ?? "");
        if (!isValidIpv4(ip)) {
          sendJson(res, 400, { error: "Invalid IP" });
          return;
        }

        if (method === "GET") {
          const cameras = await orchestrator.loadCameras();
          const camera = cameras.find((c) => c.ip === ip);
          if (!camera) {
            sendJson(res, 404, { error: "Camera not found. Run a scan first." });
            return;
          }
          try {
            const result = await streams.start(camera);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (method === "DELETE") {
          const stopped = await streams.stop(ip);
          sendJson(res, 200, { ok: true, stopped });
          return;
        }
      }

      if (method === "GET" && path.startsWith("/streams/")) {
        const rest = path.slice("/streams/".length);
        const filePath = safeJoin(STREAMS_DIR, rest);
        if (!filePath) {
          sendText(res, 400, "Bad path");
          return;
        }
        const ip = rest.split("/")[0] ?? "";
        if (isValidIpv4(ip)) streams.touch(ip);
        serveFile(res, filePath);
        return;
      }

      if (method === "GET") {
        const rel = path === "/" ? "index.html" : path.slice(1);
        const filePath = safeJoin(PUBLIC_DIR, rel);
        if (!filePath) {
          sendText(res, 400, "Bad path");
          return;
        }
        serveFile(res, filePath);
        return;
      }

      sendText(res, 405, "Method not allowed");
    } catch (err) {
      console.error("[http]", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  server.on("close", () => {
    unsubscribe();
    for (const client of sseClients) client.end();
    sseClients.clear();
  });

  void mkdir(STREAMS_DIR, { recursive: true });
  void getConfig;

  return server;
}

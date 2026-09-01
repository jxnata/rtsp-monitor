import { createConnection, type Socket } from "node:net";
import type { CameraStatus, RtspProbeResult, TrackInfo } from "../types.js";

const RTSP_VERSION = "RTSP/1.0";

interface RtspResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  raw: string;
}

function buildRequest(
  method: string,
  url: string,
  cseq: number,
  extraHeaders: Record<string, string> = {},
): string {
  const lines = [`${method} ${url} ${RTSP_VERSION}`, `CSeq: ${cseq}`, "User-Agent: rtsp-monitor/1.0"];
  for (const [k, v] of Object.entries(extraHeaders)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function parseResponse(data: string): RtspResponse | null {
  const headerEnd = data.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerBlock = data.slice(0, headerEnd);
  const body = data.slice(headerEnd + 4);
  const lines = headerBlock.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = /^RTSP\/[\d.]+\s+(\d{3})\s*(.*)$/i.exec(statusLine);
  if (!match) return null;

  const statusCode = Number(match[1]);
  const statusText = (match[2] ?? "").trim();
  const headers: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }

  const contentLength = headers["content-length"]
    ? Number(headers["content-length"])
    : body.length > 0
      ? body.length
      : 0;

  if (contentLength > 0 && body.length < contentLength) {
    return null;
  }

  return {
    statusCode,
    statusText,
    headers,
    body: contentLength > 0 ? body.slice(0, contentLength) : body,
    raw: data,
  };
}

function parseSdp(sdp: string, baseUrl: string): TrackInfo[] {
  const tracks: TrackInfo[] = [];
  const blocks = sdp.split(/\nm=/);
  if (blocks.length <= 1) return tracks;

  for (let i = 1; i < blocks.length; i++) {
    const block = "m=" + (blocks[i] ?? "");
    const lines = block.split(/\r?\n/);
    const mLine = lines[0] ?? "";
    const mediaType = mLine.split(/\s+/)[0]?.slice(2) ?? "unknown";

    let control = "";
    let codec: string | undefined;
    let resolution: string | undefined;

    for (const line of lines) {
      if (line.startsWith("a=control:")) {
        control = line.slice("a=control:".length).trim();
      } else if (line.startsWith("a=rtpmap:")) {
        const parts = line.slice("a=rtpmap:".length).trim().split(/\s+/);
        const encoding = parts[1];
        if (encoding) {
          codec = encoding.split("/")[0];
        }
      } else if (line.startsWith("a=fmtp:")) {
        const dim =
          /(?:width|x-dimensions)=(\d+)[,x](\d+)/i.exec(line) ??
          /\b(\d{2,5})x(\d{2,5})\b/.exec(line);
        if (dim) {
          resolution = `${dim[1]}x${dim[2]}`;
        }
      } else if (line.startsWith("a=x-dimensions:")) {
        const dim = /(\d+)\s*,\s*(\d+)/.exec(line);
        if (dim) resolution = `${dim[1]}x${dim[2]}`;
      } else if (line.startsWith("a=framesize:")) {
        const dim = /^\d+\s+(\d+)\s*-\s*(\d+)/.exec(line.slice("a=framesize:".length).trim());
        if (dim) resolution = `${dim[1]}x${dim[2]}`;
      }
    }

    if (!control) continue;

    let absoluteControl = control;
    if (control === "*") {
      absoluteControl = baseUrl;
    } else if (!/^rtsp:\/\//i.test(control)) {
      const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
      absoluteControl = control.startsWith("/")
        ? `${baseOrigin(baseUrl)}${control}`
        : `${base}/${control}`;
    }

    tracks.push({
      control: absoluteControl,
      codec,
      resolution,
      mediaType,
    });
  }

  return tracks;
}

function baseOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

class RtspSession {
  private socket: Socket | null = null;
  private buffer = "";
  private cseq = 0;
  private pending: {
    resolve: (r: RtspResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeout: number,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onConnect = () => {
        cleanup();
        socket.setTimeout(0);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (err) => this.failPending(err));
        socket.on("close", () => this.failPending(new Error("Connection closed")));
        resolve();
      };

      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };

      const onTimeout = () => {
        cleanup();
        socket.destroy();
        reject(new Error("TCP connect timeout"));
      };

      socket.setTimeout(this.timeout);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (!this.pending) return;
    const parsed = parseResponse(this.buffer);
    if (!parsed) return;

    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    this.buffer = "";
    resolve(parsed);
  }

  private failPending(err: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { reject } = this.pending;
    this.pending = null;
    reject(err);
  }

  request(method: string, url: string, extraHeaders: Record<string, string> = {}): Promise<RtspResponse> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("Socket not connected"));
    }
    if (this.pending) {
      return Promise.reject(new Error("Another RTSP request is in flight"));
    }

    this.cseq += 1;
    const payload = buildRequest(method, url, this.cseq, extraHeaders);

    return new Promise<RtspResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`RTSP ${method} timeout`));
      }, this.timeout);

      this.pending = { resolve, reject, timer };
      this.buffer = "";
      this.socket!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = null;
          reject(err);
        }
      });
    });
  }

  close(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Session closed"));
      this.pending = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

function isAuthStatus(code: number): boolean {
  return code === 401 || code === 403;
}

async function probeSingleUrl(
  host: string,
  port: number,
  rtspUrl: string,
  timeout: number,
): Promise<RtspProbeResult> {
  const session = new RtspSession(host, port, timeout);
  try {
    await session.connect();

    const optionsRes = await session.request("OPTIONS", rtspUrl);
    if (isAuthStatus(optionsRes.statusCode)) {
      return { status: "auth_required", tracks: [], statusCode: optionsRes.statusCode };
    }

    const publicMethods = optionsRes.headers["public"];

    const describeRes = await session.request("DESCRIBE", rtspUrl, {
      Accept: "application/sdp",
    });

    if (isAuthStatus(describeRes.statusCode)) {
      return {
        status: "auth_required",
        tracks: [],
        statusCode: describeRes.statusCode,
        publicMethods,
      };
    }

    if (describeRes.statusCode === 404) {
      return {
        status: "unreachable",
        tracks: [],
        statusCode: 404,
        publicMethods,
        error: "Path not found",
      };
    }

    if (describeRes.statusCode < 200 || describeRes.statusCode >= 300) {
      return {
        status: "error",
        tracks: [],
        statusCode: describeRes.statusCode,
        publicMethods,
        error: `DESCRIBE ${describeRes.statusCode} ${describeRes.statusText}`,
      };
    }

    const contentBase =
      describeRes.headers["content-base"] ?? describeRes.headers["content-location"];
    const contentType = describeRes.headers["content-type"];
    const sdp = describeRes.body;
    const baseForTracks = (contentBase ?? rtspUrl).replace(/\/$/, "");
    const tracks = parseSdp(sdp, contentBase ?? rtspUrl);

    const setupTargets =
      tracks.length > 0
        ? tracks.map((t) => t.control)
        : [`${baseForTracks}/trackID=0`, rtspUrl];

    let setupOk = false;
    let lastSetupError = "";

    for (const target of setupTargets) {
      try {
        const setupRes = await session.request("SETUP", target, {
          Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
        });

        if (isAuthStatus(setupRes.statusCode)) {
          return {
            status: "auth_required",
            tracks,
            statusCode: setupRes.statusCode,
            publicMethods,
            contentType,
            contentBase,
            sdp,
            rtspUrl,
          };
        }

        if (setupRes.statusCode >= 200 && setupRes.statusCode < 300) {
          setupOk = true;
          break;
        }

        lastSetupError = `SETUP ${setupRes.statusCode} ${setupRes.statusText}`;
      } catch (err) {
        lastSetupError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      status: "open",
      rtspUrl,
      statusCode: describeRes.statusCode,
      publicMethods,
      contentType,
      contentBase,
      tracks,
      sdp,
      error: setupOk ? undefined : lastSetupError || undefined,
    };
  } catch (err) {
    return {
      status: "error",
      tracks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    session.close();
  }
}

export interface ProbeOptions {
  host: string;
  port: number;
  paths: string[];
  timeout: number;
}

/**
 * Try common RTSP paths without credentials.
 * Prefers first `open` path; if any path requires auth and none open, returns auth_required.
 */
export async function probeRtsp(options: ProbeOptions): Promise<RtspProbeResult> {
  const { host, port, paths, timeout } = options;
  let sawAuth = false;
  let lastError: RtspProbeResult | null = null;

  const uniquePaths = [...new Set(paths.map(normalizePath))];
  if (!uniquePaths.includes("/")) uniquePaths.unshift("/");

  for (const path of uniquePaths) {
    const rtspUrl =
      path === "/" ? `rtsp://${host}:${port}/` : `rtsp://${host}:${port}${path}`;

    const result = await probeSingleUrl(host, port, rtspUrl, timeout);

    if (result.status === "open") {
      return result;
    }
    if (result.status === "auth_required") {
      sawAuth = true;
      continue;
    }
    lastError = result;
  }

  if (sawAuth) {
    return { status: "auth_required", tracks: [] };
  }

  return lastError ?? { status: "unreachable", tracks: [], error: "No RTSP path responded" };
}

export function statusPriority(status: CameraStatus): number {
  switch (status) {
    case "open":
      return 0;
    case "auth_required":
      return 1;
    case "error":
      return 2;
    default:
      return 3;
  }
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(__dirname, "..");
export const DATA_DIR = join(ROOT_DIR, "data");
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const STREAMS_DIR = join(DATA_DIR, "streams");
export const CAMERAS_FILE = join(DATA_DIR, "cameras.json");
export const OPEN_PORTS_FILE = join(DATA_DIR, "open-rtsp-ports.txt");
export const SCAN_STATE_FILE = join(DATA_DIR, "scan-state.json");
export const CONFIG_FILE = join(ROOT_DIR, "config.json");

function assertPositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid config: ${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(path = CONFIG_FILE): AppConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;

  if (!Array.isArray(raw.ranges) || raw.ranges.length === 0) {
    throw new Error("Invalid config: ranges must be a non-empty array");
  }
  for (const r of raw.ranges) {
    if (typeof r !== "string" || r.trim() === "") {
      throw new Error("Invalid config: each range must be a non-empty string");
    }
  }

  const scan = raw.scan ?? { concurrency: 500, timeout: 1000, rtspConcurrency: 20 };
  const stream = raw.stream ?? { idleTimeoutMs: 60_000, segmentTime: 2 };
  const rtspPaths =
    Array.isArray(raw.rtspPaths) && raw.rtspPaths.length > 0
      ? raw.rtspPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : ["/"];

  return {
    port: assertPositiveInt(raw.port ?? 3000, "port"),
    ranges: raw.ranges.map((r) => r.trim()),
    rtspPort: assertPositiveInt(raw.rtspPort ?? 554, "rtspPort"),
    scan: {
      concurrency: assertPositiveInt(scan.concurrency ?? 500, "scan.concurrency"),
      timeout: assertPositiveInt(scan.timeout ?? 1000, "scan.timeout"),
      rtspConcurrency: assertPositiveInt(scan.rtspConcurrency ?? 20, "scan.rtspConcurrency"),
    },
    rtspPaths,
    stream: {
      idleTimeoutMs: assertPositiveInt(stream.idleTimeoutMs ?? 60_000, "stream.idleTimeoutMs"),
      segmentTime: assertPositiveInt(stream.segmentTime ?? 2, "stream.segmentTime"),
    },
  };
}

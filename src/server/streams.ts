import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, Camera } from "../types.js";
import { STREAMS_DIR } from "../config.js";
import { isValidIpv4 } from "../scanner/cidr.js";

interface StreamSession {
  ip: string;
  process: ChildProcess;
  outDir: string;
  lastAccess: number;
  idleTimer: NodeJS.Timeout | null;
}

export class StreamManager {
  private readonly sessions = new Map<string, StreamSession>();

  constructor(private readonly getConfig: () => AppConfig) {}

  listActive(): string[] {
    return [...this.sessions.keys()];
  }

  touch(ip: string): void {
    const session = this.sessions.get(ip);
    if (!session) return;
    session.lastAccess = Date.now();
    this.resetIdle(session);
  }

  async start(camera: Camera): Promise<{ hlsUrl: string; alreadyRunning: boolean }> {
    if (!isValidIpv4(camera.ip)) {
      throw new Error("Invalid IP");
    }
    if (camera.status !== "open" || !camera.rtspUrl) {
      throw new Error("Camera is not available for streaming without auth");
    }

    const existing = this.sessions.get(camera.ip);
    if (existing) {
      if (!existing.process.killed && existing.process.exitCode === null) {
        this.touch(camera.ip);
        return { hlsUrl: `/streams/${camera.ip}/index.m3u8`, alreadyRunning: true };
      }
      // Process already exiting — wait until fully stopped before reusing the dir
      await this.teardown(existing);
    }

    const config = this.getConfig();
    const outDir = join(STREAMS_DIR, camera.ip);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const playlist = join(outDir, "index.m3u8");
    const segment = join(outDir, "seg_%03d.ts");
    const segmentTime = config.stream.segmentTime;

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      camera.rtspUrl,
      "-an",
      "-c:v",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      String(segmentTime),
      "-hls_list_size",
      "6",
      "-hls_flags",
      "delete_segments+append_list",
      "-hls_segment_filename",
      segment,
      playlist,
    ];

    console.log(`[stream] Starting FFmpeg for ${camera.ip}: ${camera.rtspUrl}`);
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) console.log(`[ffmpeg ${camera.ip}] ${line}`);
    });

    child.on("exit", (code, signal) => {
      console.log(`[stream] FFmpeg exited ${camera.ip} code=${code} signal=${signal}`);
      const session = this.sessions.get(camera.ip);
      if (session?.process === child) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        this.sessions.delete(camera.ip);
      }
    });

    const session: StreamSession = {
      ip: camera.ip,
      process: child,
      outDir,
      lastAccess: Date.now(),
      idleTimer: null,
    };
    this.sessions.set(camera.ip, session);
    this.resetIdle(session);

    // Give FFmpeg a moment to produce the first playlist
    await waitForPlaylist(playlist, 8000).catch(() => {
      /* player will retry */
    });

    return { hlsUrl: `/streams/${camera.ip}/index.m3u8`, alreadyRunning: false };
  }

  async stop(ip: string): Promise<boolean> {
    const session = this.sessions.get(ip);
    if (!session) return false;
    await this.teardown(session);
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => this.teardown(s)));
  }

  private resetIdle(session: StreamSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const ms = this.getConfig().stream.idleTimeoutMs;
    session.idleTimer = setTimeout(() => {
      console.log(`[stream] Idle timeout for ${session.ip}`);
      void this.teardown(session);
    }, ms);
  }

  private async teardown(session: StreamSession): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (this.sessions.get(session.ip) === session) {
      this.sessions.delete(session.ip);
    }

    const child = session.process;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          resolve();
        };
        child.once("exit", done);
        if (!child.killed) child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 3000);
        // Already exited between the check and once()
        if (child.exitCode !== null || child.signalCode !== null) done();
      });
    }

    // Only remove files after the process has fully exited
    await rm(session.outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitForPlaylist(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const { access } = await import("node:fs/promises");
  while (Date.now() - start < timeoutMs) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Playlist not ready");
}

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { AppConfig, Camera, ScanProgress, ScanState } from "../types.js";
import { CAMERAS_FILE, DATA_DIR, OPEN_PORTS_FILE, SCAN_STATE_FILE } from "../config.js";
import { countRanges, iterateRanges } from "./cidr.js";
import { scanPorts } from "./portScanner.js";
import { probeRtsp } from "./rtspClient.js";

type Listener = (progress: ScanProgress) => void;

function emptyProgress(): ScanProgress {
  return {
    phase: "idle",
    running: false,
    totalIps: 0,
    checkedIps: 0,
    openPorts: 0,
    rtspOpen: 0,
    authRequired: 0,
    errors: 0,
    resumable: false,
  };
}

function rangesKey(ranges: string[], rtspPort: number): string {
  return `${rtspPort}|${ranges.join(",")}`;
}

function compareIp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sortByIp<T extends { ip: string }>(items: T[]): T[] {
  return items.sort((a, b) => compareIp(a.ip, b.ip));
}

/** Favorites first, then IP. */
function sortCameras(items: Camera[]): Camera[] {
  return items.sort((a, b) => {
    const fa = a.favorite ? 0 : 1;
    const fb = b.favorite ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return compareIp(a.ip, b.ip);
  });
}

function sortIps(ips: string[]): string[] {
  return ips.sort((a, b) => compareIp(a, b));
}

/** Only keep open cameras in memory/disk. */
function onlyOpen(cameras: Camera[]): Camera[] {
  return cameras.filter((c) => c.status === "open");
}

/** Merge by IP — `incoming` overwrites same IP, keeps favorite unless explicitly set. */
function mergeCameras(existing: Camera[], incoming: Camera[]): Camera[] {
  const map = new Map<string, Camera>();
  for (const c of onlyOpen(existing)) map.set(c.ip, c);
  for (const c of onlyOpen(incoming)) {
    const prev = map.get(c.ip);
    map.set(c.ip, {
      ...prev,
      ...c,
      favorite: c.favorite ?? prev?.favorite,
    });
  }
  return sortCameras([...map.values()]);
}

function normalizeState(raw: unknown): ScanState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.ranges) || !data.phase) return null;
  if (data.phase !== "tcp" && data.phase !== "rtsp") return null;

  const cameras = onlyOpen(Array.isArray(data.cameras) ? (data.cameras as Camera[]) : []);
  const openPorts = Array.isArray(data.openPorts) ? (data.openPorts as string[]) : [];
  let probedIps = Array.isArray(data.probedIps) ? (data.probedIps as string[]) : [];

  // Migrate v1 checkpoints that stored auth/error cameras
  if (probedIps.length === 0 && Array.isArray(data.cameras)) {
    probedIps = (data.cameras as Camera[]).map((c) => c.ip).filter(Boolean);
  }

  let authRequired = typeof data.authRequired === "number" ? data.authRequired : 0;
  let errors = typeof data.errors === "number" ? data.errors : 0;

  if (authRequired === 0 && errors === 0 && Array.isArray(data.cameras)) {
    for (const c of data.cameras as Camera[]) {
      if (c.status === "auth_required") authRequired++;
      else if (c.status !== "open") errors++;
    }
  }

  return {
    version: 2,
    rangesKey: String(data.rangesKey ?? ""),
    ranges: data.ranges as string[],
    rtspPort: Number(data.rtspPort) || 554,
    phase: data.phase,
    totalIps: Number(data.totalIps) || 0,
    checkedIps: Number(data.checkedIps) || 0,
    openPorts,
    probedIps,
    cameras,
    authRequired,
    errors,
    startedAt: String(data.startedAt ?? new Date().toISOString()),
    updatedAt: String(data.updatedAt ?? new Date().toISOString()),
  };
}

/** RTSP probe pool that runs while TCP scan discovers open ports. */
class RtspProbeQueue {
  private queue: string[] = [];
  private active = 0;
  private readonly inFlight = new Set<string>();
  private readonly done = new Set<string>();
  private wake: (() => void) | null = null;
  private closed = false;
  private aborted = false;
  private workers: Promise<void>[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly probe: (ip: string) => Promise<Camera>,
    private readonly onCamera: (camera: Camera) => void | Promise<void>,
    private readonly shouldAbort: () => boolean,
  ) {}

  seedDone(ips: string[]): void {
    for (const ip of ips) this.done.add(ip);
  }

  enqueue(ip: string): void {
    if (this.closed || this.aborted || this.done.has(ip) || this.inFlight.has(ip)) return;
    if (this.queue.includes(ip)) return;
    this.queue.push(ip);
    this.wake?.();
  }

  enqueueMany(ips: string[]): void {
    for (const ip of ips) this.enqueue(ip);
  }

  start(): void {
    const n = Math.max(1, this.concurrency);
    this.workers = Array.from({ length: n }, () => this.worker());
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /** Drop pending work and wake workers — in-flight probes may still finish. */
  abort(): void {
    this.aborted = true;
    this.closed = true;
    this.queue = [];
    this.wake?.();
  }

  async drain(timeoutMs = 0): Promise<void> {
    this.closed = true;
    this.wake?.();
    if (timeoutMs <= 0) {
      await Promise.all(this.workers);
      return;
    }
    await Promise.race([
      Promise.all(this.workers),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  pendingCount(): number {
    return this.queue.length + this.active;
  }

  private waitForWork(): Promise<void> {
    if (this.queue.length > 0 || this.closed || this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
  }

  private async worker(): Promise<void> {
    while (true) {
      if (this.aborted || this.shouldAbort()) {
        this.aborted = true;
        return;
      }

      if (this.queue.length === 0) {
        if (this.closed || this.aborted) return;
        await this.waitForWork();
        continue;
      }

      const ip = this.queue.shift();
      if (!ip || this.done.has(ip)) continue;

      this.inFlight.add(ip);
      this.active++;
      try {
        if (this.aborted || this.shouldAbort()) return;
        const camera = await this.probe(ip);
        if (this.aborted || this.shouldAbort()) return;
        this.done.add(ip);
        await this.onCamera(camera);
      } finally {
        this.inFlight.delete(ip);
        this.active--;
        if (this.queue.length === 0 && this.closed) {
          this.wake?.();
        }
      }
    }
  }
}

export class ScanOrchestrator extends EventEmitter {
  private progress: ScanProgress = emptyProgress();
  private abortFlag = false;
  private runPromise: Promise<Camera[]> | null = null;
  private state: ScanState | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private liveCameras: Camera[] = [];
  private authRequired = 0;
  private errors = 0;

  constructor(private readonly getConfig: () => AppConfig) {
    super();
  }

  getProgress(): ScanProgress {
    return { ...this.progress };
  }

  isRunning(): boolean {
    return this.progress.running;
  }

  onProgress(listener: Listener): () => void {
    this.on("progress", listener);
    return () => this.off("progress", listener);
  }

  private setProgress(partial: Partial<ScanProgress>): void {
    this.progress = { ...this.progress, ...partial };
    this.emit("progress", this.getProgress());
  }

  private async readCamerasFile(): Promise<Camera[]> {
    try {
      const raw = await readFile(CAMERAS_FILE, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (!Array.isArray(data)) return [];
      return onlyOpen(data as Camera[]);
    } catch {
      return [];
    }
  }

  async init(): Promise<void> {
    const config = this.getConfig();
    const diskCameras = await this.readCamerasFile();
    this.liveCameras = diskCameras;

    // Drop non-open leftovers from previous versions
    if (diskCameras.length >= 0) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CAMERAS_FILE, JSON.stringify(diskCameras, null, 2) + "\n", "utf8");
    }

    const saved = await this.loadState();
    if (saved && saved.rangesKey === rangesKey(config.ranges, config.rtspPort)) {
      this.state = saved;
      this.liveCameras = mergeCameras(diskCameras, saved.cameras);
      this.authRequired = saved.authRequired;
      this.errors = saved.errors;
      this.setProgress({
        phase: "paused",
        running: false,
        totalIps: saved.totalIps,
        checkedIps: saved.checkedIps,
        openPorts: saved.openPorts.length,
        rtspOpen: this.liveCameras.length,
        authRequired: this.authRequired,
        errors: this.errors,
        resumable: true,
        message:
          saved.phase === "tcp"
            ? `Paused at ${saved.checkedIps}/${saved.totalIps} · ${this.liveCameras.length} open. Start to resume.`
            : `Paused RTSP ${saved.probedIps.length}/${saved.openPorts.length}. Start to resume.`,
        startedAt: saved.startedAt,
        finishedAt: undefined,
      });
      console.log(
        `[scan] Resumable checkpoint: phase=${saved.phase} checked=${saved.checkedIps}/${saved.totalIps} open=${saved.openPorts.length} cameras=${this.liveCameras.length} probed=${saved.probedIps.length}`,
      );
    } else if (saved) {
      console.log(
        `[scan] Ranges changed — checkpoint discarded, keeping ${diskCameras.length} open camera(s)`,
      );
      await this.clearState();
    } else if (diskCameras.length > 0) {
      console.log(`[scan] Loaded ${diskCameras.length} open camera(s) from disk`);
    }
  }

  async loadCameras(): Promise<Camera[]> {
    if (this.liveCameras.length > 0 || this.progress.running || this.state) {
      return sortCameras(this.liveCameras.slice());
    }
    return sortCameras(await this.readCamerasFile());
  }

  /** Persist a single camera update immediately (merge by IP). Open only. */
  async upsertCamera(camera: Camera): Promise<Camera[]> {
    if (camera.status !== "open") {
      return this.loadCameras();
    }
    const current = mergeCameras(await this.readCamerasFile(), this.liveCameras);
    const next = mergeCameras(current, [camera]);
    this.liveCameras = next;
    if (this.state) {
      this.state = {
        ...this.state,
        cameras: mergeCameras(this.state.cameras, [camera]),
        updatedAt: new Date().toISOString(),
      };
      await this.enqueueSave(this.state);
    } else {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CAMERAS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
    }
    await this.saveChain;
    return next;
  }

  async setFavorite(ip: string, favorite: boolean): Promise<Camera> {
    const cameras = await this.loadCameras();
    const existing = cameras.find((c) => c.ip === ip);
    if (!existing) throw new Error("Camera not found");
    const camera: Camera = { ...existing, favorite: !!favorite };
    await this.upsertCamera(camera);
    return camera;
  }

  async start(options: { fresh?: boolean } = {}): Promise<Camera[]> {
    if (this.runPromise) {
      throw new Error("Scan already running");
    }
    this.abortFlag = false;
    this.runPromise = this.run(options).finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  async stop(timeoutMs = 4000): Promise<ScanProgress> {
    if (!this.runPromise) {
      return this.getProgress();
    }
    this.abortFlag = true;
    try {
      await Promise.race([
        this.runPromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      /* ignore */
    }
    return this.getProgress();
  }

  private async loadState(): Promise<ScanState | null> {
    try {
      const raw = await readFile(SCAN_STATE_FILE, "utf8");
      return normalizeState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private enqueueSave(state: ScanState): Promise<void> {
    this.state = state;
    this.liveCameras = state.cameras;
    this.authRequired = state.authRequired;
    this.errors = state.errors;
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(SCAN_STATE_FILE, JSON.stringify(state) + "\n", "utf8");
        await writeFile(
          OPEN_PORTS_FILE,
          state.openPorts.join("\n") + (state.openPorts.length ? "\n" : ""),
          "utf8",
        );
        await writeFile(CAMERAS_FILE, JSON.stringify(state.cameras, null, 2) + "\n", "utf8");
      })
      .catch((err) => {
        console.error("[scan] checkpoint save failed:", err);
      });
    return this.saveChain;
  }

  private async clearState(): Promise<void> {
    this.state = null;
    try {
      await unlink(SCAN_STATE_FILE);
    } catch {
      /* missing ok */
    }
  }

  private async run(options: { fresh?: boolean }): Promise<Camera[]> {
    const config = this.getConfig();
    await mkdir(DATA_DIR, { recursive: true });

    const key = rangesKey(config.ranges, config.rtspPort);
    let totalIps: number;
    try {
      totalIps = countRanges(config.ranges);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setProgress({
        phase: "error",
        running: false,
        resumable: false,
        message,
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }

    let state: ScanState;
    const existing =
      !options.fresh && this.state && this.state.rangesKey === key ? this.state : null;

    const keptCameras = mergeCameras(await this.readCamerasFile(), this.liveCameras);

    if (existing && (existing.phase === "tcp" || existing.phase === "rtsp")) {
      state = {
        ...existing,
        cameras: mergeCameras(keptCameras, existing.cameras),
        totalIps,
        ranges: config.ranges,
        rtspPort: config.rtspPort,
        rangesKey: key,
        updatedAt: new Date().toISOString(),
      };
      console.log(
        `[scan] Resuming from ${state.checkedIps}/${totalIps} (openPorts=${state.openPorts.length}, openCams=${state.cameras.length}, probed=${state.probedIps.length})`,
      );
    } else {
      state = {
        version: 2,
        rangesKey: key,
        ranges: config.ranges,
        rtspPort: config.rtspPort,
        phase: "tcp",
        totalIps,
        checkedIps: 0,
        openPorts: [],
        probedIps: [],
        cameras: keptCameras,
        authRequired: 0,
        errors: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      console.log(
        `[scan] Fresh scan: ${config.ranges.length} range(s) → ${totalIps} IPs (keeping ${keptCameras.length} open camera(s))`,
      );
      await this.enqueueSave(state);
    }

    this.state = state;
    this.liveCameras = state.cameras.slice();
    this.authRequired = state.authRequired;
    this.errors = state.errors;

    const cameras = state.cameras.slice();
    const probedIps = new Set(existing ? state.probedIps : []);
    // Open cameras already known count as probed on resume
    for (const c of cameras) probedIps.add(c.ip);

    let openPorts = state.openPorts.slice();
    let checkedIps = state.checkedIps;
    let authRequired = state.authRequired;
    let errors = state.errors;
    let camerasSinceSave = 0;

    const publishProgress = (phase: ScanProgress["phase"], message: string) => {
      this.setProgress({
        phase,
        running: phase !== "paused" && phase !== "done" && phase !== "error",
        totalIps,
        checkedIps,
        openPorts: openPorts.length,
        rtspOpen: cameras.length,
        authRequired,
        errors,
        resumable: true,
        message,
        startedAt: state.startedAt,
        finishedAt: undefined,
      });
    };

    const persist = async (phase: ScanState["phase"]) => {
      state = {
        ...state,
        version: 2,
        phase,
        totalIps,
        checkedIps,
        openPorts: openPorts.slice(),
        probedIps: [...probedIps],
        cameras: cameras.slice(),
        authRequired,
        errors,
        updatedAt: new Date().toISOString(),
      };
      await this.enqueueSave(state);
      camerasSinceSave = 0;
    };

    const addCamera = async (camera: Camera) => {
      if (probedIps.has(camera.ip) && existing && cameras.some((c) => c.ip === camera.ip)) {
        // already have open result
        if (camera.status !== "open") return;
      }
      probedIps.add(camera.ip);

      if (camera.status === "open") {
        const idx = cameras.findIndex((c) => c.ip === camera.ip);
        if (idx >= 0) {
          const prev = cameras[idx]!;
          cameras[idx] = {
            ...prev,
            ...camera,
            favorite: prev.favorite,
          };
        } else {
          cameras.push(camera);
        }
        this.liveCameras = sortCameras(cameras.slice());
      } else if (camera.status === "auth_required") {
        authRequired++;
        this.authRequired = authRequired;
      } else {
        errors++;
        this.errors = errors;
      }

      camerasSinceSave++;

      console.log(
        `[rtsp] ${camera.ip}:${config.rtspPort} → ${camera.status}` +
          (camera.rtspUrl ? ` (${camera.rtspUrl})` : ""),
      );

      publishProgress(
        "tcp",
        `TCP ${checkedIps}/${totalIps} · RTSP ${probedIps.size}/${openPorts.length} (open=${cameras.length} auth=${authRequired})`,
      );

      if (camerasSinceSave >= 3) {
        await persist("tcp");
      }
    };

    const rtspQueue = new RtspProbeQueue(
      config.scan.rtspConcurrency,
      async (ip) => {
        try {
          const result = await probeRtsp({
            host: ip,
            port: config.rtspPort,
            paths: config.rtspPaths,
            timeout: Math.max(config.scan.timeout, 3000),
          });
          return {
            ip,
            port: config.rtspPort,
            status: result.status,
            rtspUrl: result.rtspUrl,
            publicMethods: result.publicMethods,
            contentType: result.contentType,
            contentBase: result.contentBase,
            tracks: result.tracks,
            sdp: result.sdp,
            error: result.error,
            lastChecked: new Date().toISOString(),
          };
        } catch (err) {
          return {
            ip,
            port: config.rtspPort,
            status: "error" as const,
            tracks: [],
            error: err instanceof Error ? err.message : String(err),
            lastChecked: new Date().toISOString(),
          };
        }
      },
      (camera) => addCamera(camera),
      () => this.abortFlag,
    );

    rtspQueue.seedDone([...probedIps]);
    rtspQueue.enqueueMany(openPorts.filter((ip) => !probedIps.has(ip)));
    rtspQueue.start();

    publishProgress(
      "tcp",
      checkedIps > 0
        ? `Resuming TCP ${checkedIps}/${totalIps} · probing RTSP live…`
        : "TCP scan + RTSP live probe…",
    );

    const tcp = await scanPorts(iterateRanges(config.ranges, checkedIps), {
      port: config.rtspPort,
      concurrency: config.scan.concurrency,
      timeout: config.scan.timeout,
      total: totalIps,
      checkedOffset: checkedIps,
      initialOpen: openPorts,
      shouldAbort: () => this.abortFlag,
      checkpointEvery: 2000,
      onOpen: (ip, open) => {
        openPorts = open;
        rtspQueue.enqueue(ip);
        process.stdout.write(
          `\r[scan] TCP ${checkedIps}/${totalIps} · open=${openPorts.length} · rtspOpen=${cameras.length}   `,
        );
      },
      onProgress: (checked, total, openCount) => {
        checkedIps = checked;
        process.stdout.write(
          `\r[scan] TCP ${checked}/${total} · open=${openCount} · openCams=${cameras.length} (a=${authRequired} e=${errors})   `,
        );
        publishProgress(
          "tcp",
          `TCP ${checked}/${total} · open:${openCount} · RTSP ${probedIps.size}/${openCount}`,
        );
      },
      onCheckpoint: async (checked, open) => {
        checkedIps = checked;
        openPorts = open;
        await persist("tcp");
      },
    });
    process.stdout.write("\n");

    checkedIps = tcp.checked;
    openPorts = tcp.open;

    if (this.abortFlag || tcp.aborted) {
      rtspQueue.abort();
      await rtspQueue.drain(800);
      await persist(checkedIps < totalIps ? "tcp" : "rtsp");
      await this.saveChain;
      sortByIp(cameras);
      sortIps(openPorts);
      this.liveCameras = cameras.slice();
      this.authRequired = authRequired;
      this.errors = errors;
      console.log(
        `[scan] Stopped at TCP ${checkedIps}/${totalIps}, probed ${probedIps.size}/${openPorts.length}, openCams=${cameras.length}`,
      );
      this.setProgress({
        phase: "paused",
        running: false,
        totalIps,
        checkedIps,
        openPorts: openPorts.length,
        rtspOpen: cameras.length,
        authRequired,
        errors,
        resumable: true,
        message: `Paused TCP ${checkedIps}/${totalIps} · open ${cameras.length} · probed ${probedIps.size}/${openPorts.length}. Resume to continue.`,
      });
      return cameras;
    }

    rtspQueue.enqueueMany(openPorts.filter((ip) => !probedIps.has(ip)));
    rtspQueue.close();
    publishProgress("rtsp", `Finishing RTSP queue (${rtspQueue.pendingCount()} left)…`);
    await rtspQueue.drain();

    if (this.abortFlag) {
      rtspQueue.abort();
      await persist(probedIps.size < openPorts.length ? "rtsp" : "tcp");
      await this.saveChain;
      sortByIp(cameras);
      sortIps(openPorts);
      this.liveCameras = cameras.slice();
      this.authRequired = authRequired;
      this.errors = errors;
      console.log(
        `[scan] Stopped during RTSP · probed ${probedIps.size}/${openPorts.length}, openCams=${cameras.length}`,
      );
      this.setProgress({
        phase: "paused",
        running: false,
        totalIps,
        checkedIps,
        openPorts: openPorts.length,
        rtspOpen: cameras.length,
        authRequired,
        errors,
        resumable: true,
        message: `Paused RTSP ${probedIps.size}/${openPorts.length} · open ${cameras.length}. Resume to continue.`,
      });
      return cameras;
    }

    await this.saveChain;

    sortByIp(cameras);
    sortIps(openPorts);
    this.liveCameras = cameras.slice();
    this.authRequired = authRequired;
    this.errors = errors;

    state = {
      ...state,
      version: 2,
      phase: "rtsp",
      checkedIps: totalIps,
      openPorts,
      probedIps: [...probedIps],
      cameras,
      authRequired,
      errors,
      updatedAt: new Date().toISOString(),
    };
    await this.enqueueSave(state);
    await this.saveChain;
    await this.clearState();

    console.log(`[scan] Saved ${cameras.length} open camera(s) → ${CAMERAS_FILE}`);

    this.setProgress({
      phase: "done",
      running: false,
      totalIps,
      checkedIps: totalIps,
      openPorts: openPorts.length,
      rtspOpen: cameras.length,
      authRequired,
      errors,
      resumable: false,
      message: `Done. open=${cameras.length} auth=${authRequired} errors=${errors}`,
      finishedAt: new Date().toISOString(),
    });

    return cameras;
  }
}

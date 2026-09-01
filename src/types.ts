export type CameraStatus = "open" | "auth_required" | "unreachable" | "error";

export interface TrackInfo {
  control: string;
  codec?: string;
  resolution?: string;
  mediaType?: string;
}

export interface Camera {
  ip: string;
  port: number;
  status: CameraStatus;
  rtspUrl?: string;
  publicMethods?: string;
  contentType?: string;
  contentBase?: string;
  tracks: TrackInfo[];
  sdp?: string;
  error?: string;
  lastChecked: string;
  favorite?: boolean;
}

export type ScanPhase = "idle" | "tcp" | "rtsp" | "done" | "error" | "paused";

export interface ScanProgress {
  phase: ScanPhase;
  running: boolean;
  totalIps: number;
  checkedIps: number;
  openPorts: number;
  rtspOpen: number;
  authRequired: number;
  errors: number;
  resumable?: boolean;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Persisted checkpoint so scans resume after stop/crash. */
export interface ScanState {
  version: 2;
  rangesKey: string;
  ranges: string[];
  rtspPort: number;
  phase: "tcp" | "rtsp";
  totalIps: number;
  checkedIps: number;
  openPorts: string[];
  /** IPs already RTSP-probed (open + auth + error) — keeps resume without storing non-open cameras. */
  probedIps: string[];
  /** Only open cameras are kept. */
  cameras: Camera[];
  authRequired: number;
  errors: number;
  startedAt: string;
  updatedAt: string;
}

export interface AppConfig {
  port: number;
  ranges: string[];
  rtspPort: number;
  scan: {
    concurrency: number;
    timeout: number;
    rtspConcurrency: number;
  };
  rtspPaths: string[];
  stream: {
    idleTimeoutMs: number;
    segmentTime: number;
  };
}

export interface RtspProbeResult {
  status: CameraStatus;
  rtspUrl?: string;
  statusCode?: number;
  publicMethods?: string;
  contentType?: string;
  contentBase?: string;
  tracks: TrackInfo[];
  sdp?: string;
  error?: string;
}

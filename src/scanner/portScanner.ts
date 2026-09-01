import { createConnection, type Socket } from "node:net";

export interface PortScanOptions {
  port: number;
  concurrency: number;
  timeout: number;
  total: number;
  /** Already-checked count when resuming (progress offset). */
  checkedOffset?: number;
  /** Seed open list when resuming. */
  initialOpen?: string[];
  onProgress?: (checked: number, total: number, openCount: number) => void;
  onOpen?: (ip: string, open: string[]) => void;
  onCheckpoint?: (checked: number, open: string[]) => void | Promise<void>;
  checkpointEvery?: number;
  shouldAbort?: () => boolean;
}

export interface PortScanResult {
  open: string[];
  checked: number;
  total: number;
  aborted: boolean;
}

/**
 * Scan ports using a fixed worker pool.
 * Pulls IPs from an iterator so large ranges never allocate millions of promises.
 * On abort, in-flight sockets are destroyed so workers exit quickly.
 */
export async function scanPorts(
  ips: Iterable<string>,
  options: PortScanOptions,
): Promise<PortScanResult> {
  const {
    port,
    concurrency,
    timeout,
    total,
    checkedOffset = 0,
    initialOpen = [],
    onProgress,
    onOpen,
    onCheckpoint,
    checkpointEvery = 2000,
    shouldAbort,
  } = options;

  const open: string[] = [...initialOpen];
  let checked = checkedOffset;
  let aborted = false;
  let sinceCheckpoint = 0;
  let checkpointChain: Promise<void> = Promise.resolve();
  const liveSockets = new Set<Socket>();

  const iterator = ips[Symbol.iterator]();
  const remaining = Math.max(0, total - checkedOffset);
  const workers = Math.max(1, Math.min(concurrency, Math.max(remaining, 1)));

  const report = () => {
    onProgress?.(checked, total, open.length);
  };

  const queueCheckpoint = () => {
    if (!onCheckpoint) return;
    const snapChecked = checked;
    const snapOpen = open.slice();
    checkpointChain = checkpointChain
      .then(() => onCheckpoint(snapChecked, snapOpen))
      .catch(() => undefined);
  };

  const destroyLive = () => {
    for (const socket of liveSockets) {
      socket.removeAllListeners();
      socket.destroy();
    }
    liveSockets.clear();
  };

  const probePort = (ip: string): Promise<boolean> => {
    return new Promise((resolve) => {
      let settled = false;
      let socket: Socket | undefined;

      const finish = (isOpen: boolean) => {
        if (settled) return;
        settled = true;
        if (socket) {
          liveSockets.delete(socket);
          socket.removeAllListeners();
          socket.destroy();
        }
        resolve(isOpen);
      };

      if (aborted || shouldAbort?.()) {
        finish(false);
        return;
      }

      try {
        socket = createConnection({ host: ip, port });
        liveSockets.add(socket);
        socket.setTimeout(timeout);

        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.once("close", () => finish(false));
      } catch {
        finish(false);
      }
    });
  };

  report();

  const worker = async () => {
    while (!aborted) {
      if (shouldAbort?.()) {
        aborted = true;
        destroyLive();
        return;
      }

      const next = iterator.next();
      if (next.done) return;

      const ip = next.value;
      try {
        const isOpen = await probePort(ip);
        if (aborted) return;
        if (isOpen) {
          open.push(ip);
          onOpen?.(ip, open);
        }
      } finally {
        checked++;
        sinceCheckpoint++;
        if (checked % 250 === 0 || checked === total || open.length > initialOpen.length) {
          report();
        }
        if (sinceCheckpoint >= checkpointEvery) {
          sinceCheckpoint = 0;
          queueCheckpoint();
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  destroyLive();
  queueCheckpoint();
  await checkpointChain;
  report();

  open.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });

  return { open, checked, total, aborted };
}

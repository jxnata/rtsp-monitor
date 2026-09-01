import { mkdir } from "node:fs/promises";
import { loadConfig, DATA_DIR, STREAMS_DIR } from "./config.js";
import { ScanOrchestrator } from "./scanner/scanOrchestrator.js";
import { createApiServer } from "./server/api.js";
import { StreamManager } from "./server/streams.js";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(STREAMS_DIR, { recursive: true });

  const getConfig = () => loadConfig();
  const orchestrator = new ScanOrchestrator(getConfig);
  await orchestrator.init();
  const streams = new StreamManager(getConfig);
  const server = createApiServer({ getConfig, orchestrator, streams });

  server.listen(config.port, () => {
    console.log(`[rtsp-monitor] http://localhost:${config.port}`);
    console.log(`[rtsp-monitor] ranges: ${config.ranges.join(", ")}`);
    console.log(`[rtsp-monitor] rtsp port: ${config.rtspPort}`);
    console.log(`[rtsp-monitor] scan concurrency: ${config.scan.concurrency}, timeout: ${config.scan.timeout}ms`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n[rtsp-monitor] ${signal} again — force exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[rtsp-monitor] ${signal}, saving scan checkpoint…`);

    // Hard ceiling so Ctrl+C always exits
    const forceTimer = setTimeout(() => {
      console.log("[rtsp-monitor] shutdown timeout — force exit");
      process.exit(0);
    }, 5000);
    forceTimer.unref?.();

    try {
      if (orchestrator.isRunning()) {
        await withTimeout(orchestrator.stop(3500), 4000);
      }
      await withTimeout(streams.stopAll(), 2000);
      await withTimeout(
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // SSE keep-alives can block close; don't hang
          setTimeout(resolve, 500).unref?.();
        }),
        1000,
      );
    } catch (err) {
      console.error("[rtsp-monitor] shutdown error:", err);
    } finally {
      clearTimeout(forceTimer);
      console.log("[rtsp-monitor] bye");
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[rtsp-monitor] fatal:", err);
  process.exit(1);
});

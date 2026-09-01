(() => {
  /** @type {Array<any>} */
  let cameras = [];
  let filter = "all";
  /** @type {EventSource | null} */
  let es = null;
  /** @type {any} */
  let hls = null;
  let currentStreamIp = null;
  let lastCameraSignal = -1;

  const els = {
    scanBtn: document.getElementById("scanBtn"),
    stopBtn: document.getElementById("stopBtn"),
    freshBtn: document.getElementById("freshBtn"),
    progressPanel: document.getElementById("progressPanel"),
    progressTitle: document.getElementById("progressTitle"),
    progressMessage: document.getElementById("progressMessage"),
    progressBar: document.getElementById("progressBar"),
    statTotal: document.getElementById("statTotal"),
    statChecked: document.getElementById("statChecked"),
    statOpen: document.getElementById("statOpen"),
    statRtsp: document.getElementById("statRtsp"),
    statAuth: document.getElementById("statAuth"),
    statErrors: document.getElementById("statErrors"),
    cameraGrid: document.getElementById("cameraGrid"),
    emptyState: document.getElementById("emptyState"),
    cameraCount: document.getElementById("cameraCount"),
    playerModal: document.getElementById("playerModal"),
    playerTitle: document.getElementById("playerTitle"),
    playerVideo: document.getElementById("playerVideo"),
    playerStatus: document.getElementById("playerStatus"),
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function updateProgress(p) {
    if (!p) return;
    const running = !!p.running;
    els.progressPanel.classList.toggle("hidden", !running && p.phase === "idle");
    if (p.phase !== "idle") els.progressPanel.classList.remove("hidden");

    els.scanBtn.disabled = running;
    els.scanBtn.textContent = running
      ? "Scanning…"
      : p.resumable
        ? "Resume scan"
        : "Scan network";
    els.stopBtn?.classList.toggle("hidden", !running);
    els.freshBtn?.classList.toggle("hidden", running || !p.resumable);

    const titles = {
      idle: "Idle",
      tcp: "TCP scan",
      rtsp: "RTSP probe",
      paused: "Paused (resumable)",
      done: "Scan complete",
      error: "Scan error",
    };
    els.progressTitle.textContent = titles[p.phase] || p.phase;
    els.progressMessage.textContent = p.message || "";

    els.statTotal.textContent = String(p.totalIps ?? 0);
    els.statChecked.textContent = String(p.checkedIps ?? 0);
    els.statOpen.textContent = String(p.openPorts ?? 0);
    els.statRtsp.textContent = String(p.rtspOpen ?? 0);
    els.statAuth.textContent = String(p.authRequired ?? 0);
    els.statErrors.textContent = String(p.errors ?? 0);

    let pct = 0;
    if ((p.phase === "tcp" || p.phase === "paused") && p.totalIps > 0) {
      pct = Math.round((p.checkedIps / p.totalIps) * 90);
    } else if (p.phase === "rtsp") {
      pct = 90 + Math.min(9, p.openPorts ? Math.round((p.rtspOpen + p.authRequired + p.errors) / p.openPorts * 9) : 9);
    } else if (p.phase === "done") {
      pct = 100;
    } else if (p.phase === "error") {
      pct = 100;
    }
    els.progressBar.style.width = `${pct}%`;

    const cameraSignal = (p.rtspOpen ?? 0) + (p.authRequired ?? 0) + (p.errors ?? 0);
    if (
      p.phase === "done" ||
      p.phase === "error" ||
      p.phase === "paused" ||
      (p.running && cameraSignal !== lastCameraSignal)
    ) {
      lastCameraSignal = cameraSignal;
      void loadCameras();
    }
  }

  function connectSSE() {
    if (es) es.close();
    es = new EventSource("/api/scan/events");
    es.onmessage = (ev) => {
      try {
        updateProgress(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      /* browser reconnects; fallback poll while running */
    };
  }

  async function loadCameras() {
    const res = await fetch("/api/cameras");
    cameras = await res.json();
    render();
  }

  async function loadStatus() {
    const res = await fetch("/api/scan/status");
    updateProgress(await res.json());
  }

  function sortCamerasList(list) {
    return list.slice().sort((a, b) => {
      const fa = a.favorite ? 0 : 1;
      const fb = b.favorite ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const pa = String(a.ip).split(".").map(Number);
      const pb = String(b.ip).split(".").map(Number);
      for (let i = 0; i < 4; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  }

  function render() {
    let list =
      filter === "all"
        ? cameras
        : filter === "favorite"
          ? cameras.filter((c) => c.favorite)
          : cameras.filter((c) => c.status === filter);
    list = sortCamerasList(list);

    els.cameraCount.textContent = `${list.length} de ${cameras.length} câmera(s)`;
    els.emptyState.classList.toggle("hidden", cameras.length > 0);
    els.cameraGrid.innerHTML = "";

    for (const cam of list) {
      const tracks = (cam.tracks || [])
        .map((t) => {
          const bits = [t.mediaType, t.codec, t.resolution].filter(Boolean).join(" · ");
          return `<div>${escapeHtml(bits || t.control)}</div>`;
        })
        .join("");

      const card = document.createElement("article");
      card.className = "card" + (cam.favorite ? " favorite" : "");
      card.innerHTML = `
        <div class="card-top">
          <div class="ip-row">
            <button type="button" class="fav-btn ${cam.favorite ? "on" : ""}"
              data-favorite="${escapeHtml(cam.ip)}" data-fav-state="${cam.favorite ? "1" : "0"}"
              title="${cam.favorite ? "Remover dos favoritos" : "Favoritar"}"
              aria-label="Favoritar">★</button>
            <div class="ip">${escapeHtml(cam.ip)}:${cam.port ?? 554}</div>
          </div>
          <span class="badge ${escapeHtml(cam.status)}">${escapeHtml(cam.status)}</span>
        </div>
        <div class="meta">
          <div><strong>URL</strong> ${escapeHtml(cam.rtspUrl || "—")}</div>
          <div><strong>Última verificação</strong> ${escapeHtml(formatDate(cam.lastChecked))}</div>
          <div><strong>Content-Type</strong> ${escapeHtml(cam.contentType || "—")}</div>
          <div><strong>Public</strong> ${escapeHtml(cam.publicMethods || "—")}</div>
          ${cam.error ? `<div><strong>Nota</strong> ${escapeHtml(cam.error)}</div>` : ""}
        </div>
        ${tracks ? `<div class="tracks">${tracks}</div>` : ""}
        <div class="card-actions">
          <button type="button" class="btn small primary" data-view="${escapeHtml(cam.ip)}"
            ${cam.status === "open" && cam.rtspUrl ? "" : "disabled"}>
            Visualizar
          </button>
        </div>
      `;
      els.cameraGrid.appendChild(card);
    }
  }

  async function startScan(fresh = false) {
    els.scanBtn.disabled = true;
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fresh: !!fresh }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      alert(body.error || "Falha ao iniciar scan");
      els.scanBtn.disabled = false;
      return;
    }
    if (body.progress) updateProgress(body.progress);
    await loadStatus();
  }

  async function stopScan() {
    els.stopBtn.disabled = true;
    const res = await fetch("/api/scan/stop", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (body.progress) updateProgress(body.progress);
    els.stopBtn.disabled = false;
    await loadStatus();
    await loadCameras();
  }

  async function openPlayer(ip) {
    currentStreamIp = ip;
    els.playerTitle.textContent = `Stream ${ip}`;
    els.playerStatus.textContent = "Iniciando FFmpeg / HLS…";
    els.playerModal.classList.remove("hidden");
    els.playerVideo.pause();
    els.playerVideo.removeAttribute("src");
    els.playerVideo.load();

    try {
      const res = await fetch(`/api/cameras/${encodeURIComponent(ip)}/stream`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Falha ao iniciar stream");

      const url = body.hlsUrl;
      els.playerStatus.textContent = `HLS: ${url}`;

      destroyHls();
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(url);
        hls.attachMedia(els.playerVideo);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          void els.playerVideo.play().catch(() => undefined);
        });
        hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            els.playerStatus.textContent = `Erro HLS: ${data.type} ${data.details}`;
          }
        });
      } else if (els.playerVideo.canPlayType("application/vnd.apple.mpegurl")) {
        els.playerVideo.src = url;
        void els.playerVideo.play().catch(() => undefined);
      } else {
        els.playerStatus.textContent = "HLS não suportado neste navegador";
      }
    } catch (err) {
      els.playerStatus.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  async function closePlayer() {
    destroyHls();
    els.playerVideo.pause();
    els.playerVideo.removeAttribute("src");
    els.playerVideo.load();
    els.playerModal.classList.add("hidden");
    if (currentStreamIp) {
      const ip = currentStreamIp;
      currentStreamIp = null;
      await fetch(`/api/cameras/${encodeURIComponent(ip)}/stream`, { method: "DELETE" }).catch(
        () => undefined,
      );
    }
  }

  els.scanBtn.addEventListener("click", () => void startScan(false));
  els.stopBtn?.addEventListener("click", () => void stopScan());
  els.freshBtn?.addEventListener("click", () => {
    if (confirm("Recomeçar do zero e apagar o checkpoint?")) void startScan(true);
  });
  async function toggleFavorite(ip, currentlyFav) {
    const next = !currentlyFav;
    const res = await fetch(`/api/cameras/${encodeURIComponent(ip)}/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite: next }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(body.error || "Falha ao favoritar");
      return;
    }
    await loadCameras();
  }

  els.cameraGrid.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const viewIp = t.getAttribute("data-view");
    if (viewIp) void openPlayer(viewIp);
    const favIp = t.getAttribute("data-favorite");
    if (favIp) {
      const on = t.getAttribute("data-fav-state") === "1";
      void toggleFavorite(favIp, on);
    }
  });

  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      filter = btn.getAttribute("data-filter") || "all";
      render();
    });
  });

  els.playerModal.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => void closePlayer());
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !els.playerModal.classList.contains("hidden")) {
      void closePlayer();
    }
  });

  connectSSE();
  void loadCameras();
  void loadStatus();
})();

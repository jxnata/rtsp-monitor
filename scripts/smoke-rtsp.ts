import { createServer } from "node:net";
import { probeRtsp } from "../src/scanner/rtspClient.js";

async function main(): Promise<void> {
  const sdp = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=MockCam",
    "t=0 0",
    "m=video 0 RTP/AVP 96",
    "a=rtpmap:96 H264/90000",
    "a=control:trackID=0",
    "a=framesize:96 1920-1080",
    "",
  ].join("\r\n");

  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n\r\n")) return;
      const first = buf.split("\r\n")[0] ?? "";
      const cseq = /CSeq:\s*(\d+)/i.exec(buf)?.[1] ?? "1";
      buf = "";
      let body = "";
      let extra = "";
      let code = "200 OK";
      if (first.startsWith("OPTIONS")) {
        extra = "Public: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY\r\n";
      } else if (first.startsWith("DESCRIBE")) {
        body = sdp;
        extra =
          "Content-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1:8554/live/\r\nContent-Length: " +
          Buffer.byteLength(body) +
          "\r\n";
      } else if (first.startsWith("SETUP")) {
        extra =
          "Transport: RTP/AVP/TCP;unicast;interleaved=0-1;ssrc=1234\r\nSession: ABCD\r\n";
      } else {
        code = "501 Not Implemented";
      }
      socket.write("RTSP/1.0 " + code + "\r\nCSeq: " + cseq + "\r\n" + extra + "\r\n" + body);
    });
  });

  await new Promise<void>((r) => server.listen(8554, "127.0.0.1", r));
  const open = await probeRtsp({
    host: "127.0.0.1",
    port: 8554,
    paths: ["/live", "/"],
    timeout: 3000,
  });
  console.log(JSON.stringify(open, null, 2));
  if (open.status !== "open") throw new Error("expected open");
  if (!open.tracks.some((t) => t.codec === "H264")) throw new Error("expected H264 track");

  const authServer = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n\r\n")) return;
      const cseq = /CSeq:\s*(\d+)/i.exec(buf)?.[1] ?? "1";
      buf = "";
      socket.write(
        "RTSP/1.0 401 Unauthorized\r\nCSeq: " +
          cseq +
          '\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n',
      );
    });
  });
  await new Promise<void>((r) => authServer.listen(8555, "127.0.0.1", r));
  const auth = await probeRtsp({
    host: "127.0.0.1",
    port: 8555,
    paths: ["/"],
    timeout: 3000,
  });
  console.log("auth", auth.status);
  if (auth.status !== "auth_required") throw new Error("expected auth_required");

  server.close();
  authServer.close();
  console.log("rtsp client ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env python3
"""Record REAL markdrop CLI sessions for the docs' terminal scene videos.

    python3 frontend/scripts/docs-media/scenes/record_cli.py [upload-replace] [send-receive] [local-mcp]

Each recording runs the CLI built from cli/ (go build → $MARKDROP_CLI, default /tmp/markdrop-cli) in
a pseudo-terminal, so it prints exactly what a person sees (colours, spinners, progress lines), and
stores every output chunk with its time in frontend/content/docs/video-scenes/<scene>/session.json.
The scene replays it in its terminal frame with human-paced typing (see _kit/term.js).

Everything is local:
  * upload / replace / versions / restore talk to the docs-media demo API (STACK_ID, default 0 →
    http://127.0.0.1:8180; stack/stack.sh start). A session token for Riya comes from the sandbox's
    /__sandbox/mint and is passed in MARKDROP_TOKEN; it is never printed, and any token-looking
    text is masked before it is written.
  * send / get use a throwaway signalling relay on 127.0.0.1 (the CLI's own test relay,
    internal/signaling/sigtest, built with `go build -overlay` so nothing is added to cli/). It
    offers one unreachable loopback STUN server, so the two CLIs connect over host candidates and
    nothing leaves the machine (the demo API's signalling would hand out public STUN servers).
  * local-mcp drives `markdrop mcp` over stdio with a tiny MCP client and records the real
    progress notifications and tool results of upload_file / replace_file.

Local addresses are rewritten to the production ones (127.0.0.1:8180 → api.markdrop.in,
localhost:3400 → markdrop.in) before anything is saved.
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parents[2]
REPO = FRONTEND.parent
SCENES = FRONTEND / "content/docs/video-scenes"
STACK_ID = int(os.environ.get("STACK_ID", "0"))
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"
APP_PORT = 3400 + 10 * STACK_ID
WORKER_PORT = 8787 + 10 * STACK_ID
CLI = os.environ.get("MARKDROP_CLI", "/tmp/markdrop-cli")
RELAY = os.environ.get("MARKDROP_SIGRELAY", "/tmp/markdrop-sigrelay")
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FIXTURES = HERE.parent / ".data/fixtures"
WORK = Path(os.environ.get("DOCS_SCENES_WORK", tempfile.gettempdir())) / "markdrop-scenes-cli"

GO = shutil.which("go") or "/usr/local/go/bin/go"

RELAY_MAIN = """package main

import (
\t"fmt"
\t"os"
\t"os/signal"
\t"syscall"

\t"github.com/markdrop/cli/internal/signaling/sigtest"
)

func main() {
\tr := sigtest.New()
\tfmt.Println(r.URL)
\tc := make(chan os.Signal, 1)
\tsignal.Notify(c, os.Interrupt, syscall.SIGTERM)
\t<-c
\tr.Close()
}
"""


# ── Build ─────────────────────────────────────────────────────────────────────


def build() -> None:
    env = {**os.environ, "PATH": f"{Path(GO).parent}:{os.environ.get('PATH', '')}"}
    print("· go build cli →", CLI)
    subprocess.run([GO, "build", "-o", CLI, "./"], cwd=REPO / "cli", check=True, env=env)
    tmp = Path(tempfile.mkdtemp(prefix="sigrelay-"))
    (tmp / "main.go").write_text(RELAY_MAIN)
    overlay = tmp / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(REPO / "cli/cmd_sigrelay/main.go"): str(tmp / "main.go")}}))
    print("· go build signalling relay →", RELAY)
    subprocess.run([GO, "build", "-overlay", str(overlay), "-o", RELAY, "./cmd_sigrelay"], cwd=REPO / "cli", check=True, env=env)
    shutil.rmtree(tmp, ignore_errors=True)


# ── Scrubbing ─────────────────────────────────────────────────────────────────

RULES = [
    (re.compile(rf"https?://(?:localhost|127\.0\.0\.1):{APP_PORT}"), "https://markdrop.in"),
    (re.compile(rf"(?:localhost|127\.0\.0\.1):{APP_PORT}"), "markdrop.in"),
    (re.compile(rf"https?://127\.0\.0\.1:{8180 + 10 * STACK_ID}"), "https://api.markdrop.in"),
    (re.compile(rf"https?://127\.0\.0\.1:{WORKER_PORT}"), "https://markdrop-artifacts.markdrop-in.workers.dev"),
    (re.compile(r"\beyJ[\w-]{6,}\.[\w-]+\.[\w-]+"), "mdk_••••"),
    (re.compile(r"\bmdk_[A-Za-z0-9_-]{6,}"), "mdk_••••"),
]


def scrub(s: str, extra: list[tuple[str, str]] = ()) -> str:
    for rx, to in RULES:
        s = rx.sub(to, s)
    for a, b in extra:
        s = s.replace(a, b)
    return s


# ── Sandbox ───────────────────────────────────────────────────────────────────


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def riya_token() -> str:
    fx = json.loads((HERE.parent / ".data/fixtures.json").read_text()) if STACK_ID == 0 else \
        json.loads((HERE.parent / f".data/{STACK_ID}/fixtures.json").read_text())
    return post("/__sandbox/mint", {"email": fx["users"]["riya"]["email"]})["token"]


# ── A throttling proxy in front of the demo API ───────────────────────────────


def start_throttle(mb_per_s: float):
    """A local reverse proxy that reads request bodies at `mb_per_s`, like a real uplink.

    On loopback a 100 MB upload finishes before the CLI draws a second progress line; through
    this proxy the CLI's real progress line moves the way it does on a network. Upload addresses
    the API hands out are rewritten to come back through the proxy too."""
    import http.client
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    up = API.split("//", 1)[1]
    rate = mb_per_s * 1024 * 1024

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _body(self) -> bytes:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                out = bytearray()
                while True:
                    n = int(self.rfile.readline().strip().split(b";")[0], 16)
                    if n == 0:
                        self.rfile.readline()
                        break
                    out += self._read(n)
                    self.rfile.readline()
                return bytes(out)
            return self._read(int(self.headers.get("Content-Length") or 0))

        def _read(self, n: int) -> bytes:
            out = bytearray()
            t0 = time.monotonic()
            while len(out) < n:
                out += self.rfile.read(min(64 * 1024, n - len(out)))
                ahead = len(out) / rate - (time.monotonic() - t0)
                if ahead > 0:
                    time.sleep(ahead)
            return bytes(out)

        def _any(self):
            body = self._body()
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "transfer-encoding", "connection")}
            headers["Content-Length"] = str(len(body))
            c = http.client.HTTPConnection(up, timeout=120)
            c.request(self.command, self.path, body=body, headers=headers)
            r = c.getresponse()
            data = r.read()
            me = f"127.0.0.1:{self.server.server_address[1]}"
            if b"127.0.0.1:" in data:
                data = data.replace(up.encode(), me.encode())
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() in ("content-length", "transfer-encoding", "connection"):
                    continue
                self.send_header(k, v.replace(up, me))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            c.close()

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = _any

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


# ── PTY sessions ──────────────────────────────────────────────────────────────


class Proc:
    """One command in its own pseudo-terminal; output chunks are timestamped."""

    def __init__(self, argv, *, cwd, env, cols, rows, answers=()):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.t0 = time.monotonic()
        self.chunks: list[list] = []
        self.buf = ""
        self.answers = list(answers)  # [(regex, text, delay)]
        self.pending = None
        self.done = False
        self.status = None

    def pump(self) -> None:
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        if not data:
            self.finish()
            return
        s = data.decode("utf-8", "replace")
        self.chunks.append([round(time.monotonic() - self.t0, 4), s])
        self.buf += s
        if self.answers and self.pending is None and re.search(self.answers[0][0], self.buf):
            _, text, delay = self.answers.pop(0)
            self.pending = (time.monotonic() + delay, text)

    def tick(self) -> None:
        if self.pending and time.monotonic() >= self.pending[0]:
            # The answer is recorded as typed input; the PTY's echo shows it in the output too.
            self.chunks.append([round(time.monotonic() - self.t0, 4), {"input": self.pending[1]}])
            os.write(self.fd, self.pending[1].encode())
            self.pending = None

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        try:
            _, st = os.waitpid(self.pid, 0)
            self.status = os.waitstatus_to_exitcode(st) if hasattr(os, "waitstatus_to_exitcode") else st
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def run_all(procs: list[Proc], timeout: float = 120) -> None:
    end = time.monotonic() + timeout
    while not all(p.done for p in procs):
        if time.monotonic() > end:
            for p in procs:
                if not p.done:
                    os.kill(p.pid, signal.SIGINT)
            end = time.monotonic() + 5
        fds = [p.fd for p in procs if not p.done]
        r, _, _ = select.select(fds, [], [], 0.02)
        for p in procs:
            if not p.done and p.fd in r:
                p.pump()
            if not p.done:
                p.tick()


def step(display: str, proc: Proc, extra=()) -> dict:
    out = []
    for t, c in proc.chunks:
        if isinstance(c, dict):
            out.append([t, c])
        else:
            out.append([t, scrub(c, extra)])
    return {"cmd": display, "out": out, "exit": proc.status}


def env_with(**kw) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("MARKDROP_")}
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8", "HOME": str(WORK / "home")})
    env.update(kw)
    (WORK / "home").mkdir(parents=True, exist_ok=True)
    return env


def write_session(scene: str, data: dict) -> None:
    out = SCENES / scene / "session.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    print(f"  → {out.relative_to(FRONTEND)}")


# ── Fixture videos ────────────────────────────────────────────────────────────


def demo_videos(dirpath: Path) -> tuple[Path, Path]:
    """demo.mp4 / demo-v2.mp4: the demo stack's 40 s product video, re-encoded at a camera-like
    bitrate so the upload has a size worth a progress line (~110 MB)."""
    dirpath.mkdir(parents=True, exist_ok=True)
    out = []
    for src, name in (("product-demo-v1.mp4", "demo.mp4"), ("product-demo-v2.mp4", "demo-v2.mp4")):
        dst = dirpath / name
        if not dst.exists():
            print(f"· ffmpeg {name}")
            subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(FIXTURES / src),
                            "-vf", "scale=1920:1080:flags=lanczos,noise=alls=12:allf=t", "-c:v", "libx264",
                            "-preset", "ultrafast", "-b:v", "22M", "-maxrate", "22M", "-bufsize", "44M",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(dst)], check=True)
        out.append(dst)
    return out[0], out[1]


def cleanup_docs() -> None:
    try:
        post("/__sandbox/cleanup", {})
    except Exception as exc:  # noqa: BLE001
        print("  ! cleanup:", exc)


# ── Scenes ────────────────────────────────────────────────────────────────────


def rec_upload_replace() -> None:
    """markdrop upload demo.mp4 → replace demo demo-v2.mp4 → versions demo."""
    print("▸ cli-upload-replace")
    cleanup_docs()
    movies = WORK / "Movies"
    v1, v2 = demo_videos(movies)
    token = riya_token()
    env = env_with(MARKDROP_TOKEN=token)
    cols, rows = 92, 26
    steps = []
    srv, server = start_throttle(4.5)  # per connection; the CLI sends 4 parts at a time
    proxy_host = server.split("//", 1)[1]
    for display, args in (
        ("markdrop upload demo.mp4", ["upload", v1.name]),
        ("markdrop replace demo demo-v2.mp4", ["replace", "demo", v2.name]),
        ("markdrop versions demo", ["versions", "demo"]),
    ):
        p = Proc([CLI, *args, "--server", server], cwd=movies, env=env, cols=cols, rows=rows)
        run_all([p], timeout=300)
        steps.append(step(display, p, [(f"http://{proxy_host}", "https://api.markdrop.in")]))
        print(f"  {display}: exit {p.status}, {len(p.chunks)} chunks")
    srv.shutdown()
    write_session("cli-upload-replace", {"cols": cols, "rows": rows, "cwd": "~/Movies", "steps": steps})
    cleanup_docs()


def rec_send_receive() -> None:
    """markdrop send ./screenshots in one terminal, markdrop get <room> in another."""
    print("▸ cli-send-receive")
    base = WORK / "p2p"
    shutil.rmtree(base, ignore_errors=True)
    src = base / "laptop/screenshots"
    dst = base / "desktop"
    src.mkdir(parents=True)
    dst.mkdir(parents=True)
    # Eight screenshots worth sending (noise, so the zip doesn't shrink them away).
    names = ["dashboard.png", "share-dialog.png", "analytics.png", "upload-progress.png",
             "workspace-settings.png", "custom-domain.png", "editor-dark.png", "editor-light.png"]
    for i, n in enumerate(names):
        subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        f"color=c=0x{(0x2150D8 + i * 0x0f0f13) & 0xffffff:06x}:s=2880x1800,noise=alls=40:allf=t",
                        "-frames:v", "1", str(src / n)], check=True)
    relay = subprocess.Popen([RELAY], stdout=subprocess.PIPE, text=True)
    try:
        url = relay.stdout.readline().strip()
        print("  relay", url)
        cols, rows = 78, 40
        # VPN tunnels can carry the handshake but crawl (cli/send-and-receive docs): loopback only.
        env = env_with(MARKDROP_ICE_EXCLUDE_IFACES="utun,tun,ipsec,ppp,awdl,llw")
        common = ["--server", url, "--web", "https://markdrop.in"]
        sender = Proc([CLI, "send", "./screenshots", *common], cwd=src.parent, env=env, cols=cols, rows=rows)
        # Wait for the room id, then start the receiver like a person would: a few seconds later.
        room = None
        t_end = time.monotonic() + 20
        while room is None and time.monotonic() < t_end:
            r, _, _ = select.select([sender.fd], [], [], 0.05)
            if r:
                sender.pump()
            m = re.search(r"Room\s*\S*\s*:\s*(?:\x1b\[[0-9;]*m)*\s*([0-9a-f]{10})", sender.buf)
            if m:
                room = m.group(1)
        if not room:
            raise SystemExit("no room id from markdrop send")
        t_get = time.monotonic() - sender.t0
        receiver = Proc([CLI, "get", room, *common], cwd=dst, env=env, cols=cols, rows=rows,
                        answers=[(r"\[Y/n\]: ", "y\r", 1.4)])
        run_all([sender, receiver], timeout=120)
        ls = Proc(["/bin/ls", "screenshots"], cwd=dst, env=env, cols=cols, rows=rows)
        run_all([ls], timeout=10)
        print(f"  send exit {sender.status}, get exit {receiver.status}")
        # "Saved to <absolute path>": as it reads on the reader's own machine.
        home = [(os.path.realpath(dst), "/Users/sam/Desktop"), (str(dst), "/Users/sam/Desktop")]
        write_session("cli-send-receive", {
            "cols": cols, "rows": rows,
            "left": {"cwd": "~/Projects/launch", "steps": [step("markdrop send ./screenshots", sender)]},
            "right": {"cwd": "~/Desktop", "start": round(t_get, 3),
                      "steps": [step(f"markdrop get {room}", receiver, home), step("ls screenshots", ls)]},
        })
    finally:
        relay.send_signal(signal.SIGINT)
        relay.wait(timeout=5)


class Mcp:
    """A minimal MCP stdio client for `markdrop mcp` (newline-delimited JSON-RPC)."""

    def __init__(self, argv, env, cwd):
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env=env, cwd=cwd, text=True, bufsize=1)
        self.n = 0
        self.t0 = time.monotonic()

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def call(self, method, params=None, notify=False):
        if notify:
            self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})
            return None, []
        self.n += 1
        rid = self.n
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        events = []
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("markdrop mcp closed")
            msg = json.loads(line)
            if msg.get("id") == rid:
                return msg, events
            if msg.get("method") == "notifications/progress":
                events.append([round(time.monotonic() - self.t0, 3), msg["params"]])

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def rec_local_mcp() -> None:
    print("▸ local-mcp-publish")
    cleanup_docs()
    movies = WORK / "Movies"
    v1, v2 = demo_videos(movies)
    env = env_with(MARKDROP_TOKEN=riya_token())
    srv, server = start_throttle(4.5)
    proxy = server.split("//", 1)[1]
    m = Mcp([CLI, "mcp", "--server", server], env, str(movies))
    out = {"calls": []}
    try:
        init, _ = m.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "docs-scenes", "version": "1"}})
        out["server"] = init["result"].get("serverInfo")
        m.call("notifications/initialized", notify=True)
        tools, _ = m.call("tools/list")
        out["tools"] = [t["name"] for t in tools["result"]["tools"]]
        for name, args in (("upload_file", {"path": str(v1)}), ("replace_file", {"document": "demo", "path": str(v2)})):
            t = time.monotonic()
            res, events = m.call("tools/call", {"name": name, "arguments": args, "_meta": {"progressToken": name}})
            if "error" in res:
                raise RuntimeError(f"{name}: {res['error']}")
            r = res["result"]
            text = "".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
            disp_args = {k: (v.replace(str(movies), "~/Movies") if isinstance(v, str) else v) for k, v in args.items()}
            out["calls"].append({
                "tool": name, "arguments": disp_args, "seconds": round(time.monotonic() - t, 3),
                "progress": [[e[0], {"progress": e[1].get("progress"), "total": e[1].get("total"),
                                     "message": scrub(e[1].get("message", ""), [(str(movies), "~/Movies")])}]
                             for e in events],
                "text": scrub(text, [(str(movies), "~/Movies")]),
                "isError": r.get("isError", False),
                "structured": json.loads(scrub(json.dumps(r.get("structuredContent") or {}), [(str(movies), "~/Movies")])),
            })
            print(f"  {name}: {len(events)} progress events, {out['calls'][-1]['seconds']} s")
    finally:
        m.close()
        srv.shutdown()
    out = json.loads(json.dumps(out).replace(f"http://{proxy}", "https://api.markdrop.in"))
    write_session("local-mcp-publish", out)
    # Keep `demo` for the browser stills (scenes/stills.mjs); cleanup happens on the next run.


def main() -> None:
    which = sys.argv[1:] or ["upload-replace", "send-receive", "local-mcp"]
    if "--no-build" in which:
        which.remove("--no-build")
    else:
        build()
    WORK.mkdir(parents=True, exist_ok=True)
    for w in which:
        {"upload-replace": rec_upload_replace, "send-receive": rec_send_receive, "local-mcp": rec_local_mcp}[w]()


if __name__ == "__main__":
    main()

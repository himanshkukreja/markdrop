#!/usr/bin/env python3
"""The main landing page's product loops (frontend/public/landing-desk/): short, silent, seamless
clips of the REAL product, cut from the "Markdrop in 12" series recordings (the series kit's clips,
recorded with Playwright on the docs-media sandbox stack with fictional Acme data; each clip is a
packed frames.mp4 plus clip.json with every frame's real time).

    KIT=<series kit>/videos python3 frontend/scripts/landing-samples/loops.py [names…]

Per loop: the frames are re-timed to their recorded times (variable frame rate → 30 fps), segments
joined, sped up, cropped, scaled, the last frame held, and the end cross-faded into the start; out
come <name>.mp4 (H.264, faststart), <name>.webm (VP9) and <name>.webp (the poster), as
scripts/docs-media/landing-loops.mjs makes the Guides landing's loops. Raw frames go to a temp
folder and are deleted. Run it inside the shared render slot (render-slot.sh) on the owner's Mac.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "public" / "landing-desk"
KIT = Path(os.environ.get("KIT", "/private/tmp/claude-501/-Users-himanshukukreja-markdrop/aa3cad07-3754-41b6-bc49-1a71cd0aa16c/scratchpad/series/kit/videos"))
FF = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "/opt/homebrew/bin/ffprobe")

# segs: (clip, from, to) in recorded seconds; crop: [w, h, x, y] in the clip's 2x pixels.
LOOPS = [
    # VS Code with the Markdrop extension: Publish to Markdrop in the status bar, the toast with the
    # link, then an edit to release-notes.md and "Markdrop: synced".
    {"name": "vscode", "segs": [("08-vscode-sync/clips/v2-publish", 4.4, 9.8), ("08-vscode-sync/clips/v3-push", 0.4, 9.0)],
     "speed": 1.1, "crop": [1856, 1600, 704, 0], "width": 1100, "hold": 1.2, "fade": 0.4, "poster": 4.6, "crf": [30, 44]},
    # An AI app calling Markdrop's MCP tool publish_document, and the link it answers with.
    {"name": "ai-chat", "segs": [("09-ai-apps-and-cli/clips/s-publish", 1.0, 8.9)],
     "speed": 1.0, "crop": [1640, 1600, 460, 0], "width": 760, "hold": 2.0, "fade": 0.4, "poster": 8.4, "crf": [30, 44]},
    # The Markdrop CLI: markdrop upload, then markdrop replace on the same link.
    {"name": "terminal", "segs": [("09-ai-apps-and-cli/clips/t-upload", 0.0, 21.9)],
     "speed": 1.5, "crop": [2480, 572, 0, 0], "width": 1600, "hold": 2.4, "fade": 0.4, "poster": 14.4, "crf": [30, 44]},
    # The real Share dialog: Who can open it → Only people added.
    {"name": "share-dialog", "segs": [("04-share-with-control/clips/l1-access", 3.2, 17.8)],
     "speed": 1.25, "crop": [1136, 1128, 712, 236], "width": 880, "hold": 1.0, "fade": 0.4, "poster": 9.4, "crf": [30, 44]},
]


def run(args):
    subprocess.run(["nice", "-n", "15", FF, "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def segment(tmp: Path, clip: str, start: float, end: float, speed: float, idx: int) -> Path:
    """The frames of `clip` between start and end, at their recorded times, as a 30 fps video."""
    d = KIT / clip
    frames = json.loads((d / "clip.json").read_text())["frames"]
    picks = [i for i, (_, t) in enumerate(frames) if start <= t <= end]
    fd = tmp / f"f{idx}"
    fd.mkdir()
    # Every frame of the packed video (frame n of frames.mp4 = frames[n]), then keep the picks.
    run(["-i", str(d / "frames.mp4"), "-vsync", "0", "-q:v", "2", str(fd / "%06d.jpg")])
    lines = ["ffconcat version 1.0"]
    for k, i in enumerate(picks):
        t = frames[i][1]
        nxt = frames[picks[k + 1]][1] if k + 1 < len(picks) else min(end, t + 1 / 30)
        lines.append(f"file '{fd / f'{i + 1:06d}.jpg'}'")
        lines.append(f"duration {max(nxt - t, 1 / 60) / speed:.5f}")
    lines.append(f"file '{fd / f'{picks[-1] + 1:06d}.jpg'}'")
    lst = tmp / f"s{idx}.txt"
    lst.write_text("\n".join(lines) + "\n")
    out = tmp / f"s{idx}.mp4"
    run(["-f", "concat", "-safe", "0", "-i", str(lst), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", str(out)])
    shutil.rmtree(fd)
    return out


def duration(f: Path) -> float:
    return float(subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]).decode().strip())


def build(loop):
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
        tmp = Path(t)
        parts = [segment(tmp, c, a, b, loop["speed"], i) for i, (c, a, b) in enumerate(loop["segs"])]
        joined = tmp / "joined.mp4"
        if len(parts) == 1:
            joined = parts[0]
        else:
            lst = tmp / "parts.txt"
            lst.write_text("".join(f"file '{p}'\n" for p in parts))
            run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])
        hold, x = loop.get("hold", 0), loop["fade"]
        length = duration(joined) + hold
        w, h, cx, cy = loop["crop"]
        pre = ",".join(filter(None, [
            f"tpad=stop_mode=clone:stop_duration={hold}" if hold else None,
            f"crop={w}:{h}:{cx}:{cy}",
            f"scale={loop['width']}:-2:flags=lanczos:out_range=tv:out_color_matrix=bt709", "format=yuv420p",
        ]))
        graph = ";".join([
            f"[0:v]{pre},split[a0][b0]",
            f"[a0]trim=start={x},setpts=PTS-STARTPTS[a]",
            f"[b0]trim=end={x},setpts=PTS-STARTPTS[b]",
            f"[a][b]xfade=transition=fade:duration={x}:offset={length - 2 * x:.3f},format=yuv420p[v]",
        ])
        master = tmp / "master.mp4"
        run(["-i", str(joined), "-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", str(master)])
        base = OUT / loop["name"]
        c264, c9 = loop["crf"]
        color = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
        run(["-i", str(master), "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", str(c264), "-pix_fmt", "yuv420p",
             "-profile:v", "high", "-g", "60", *color, "-movflags", "+faststart", f"{base}.mp4"])
        run(["-i", str(master), "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(c9), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
             "-g", "60", "-pix_fmt", "yuv420p", *color, f"{base}.webm"])
        run(["-ss", str(loop["poster"]), "-i", str(master), "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-compression_level", "6", f"{base}.webp"])
        size = lambda ext: f"{os.path.getsize(f'{base}.{ext}') // 1024} KB"
        print(f"  {loop['name']}: {length - x:.1f} s · mp4 {size('mp4')} · webm {size('webm')} · poster {size('webp')}")


if __name__ == "__main__":
    want = sys.argv[1:]
    for loop in LOOPS:
        if not want or loop["name"] in want:
            build(loop)

# Narration for the docs' short how-to videos (public/docs-assets/videos/<id>.mp4): one Kokoro line (voice af_heart,
# the series' narrator) per on-screen caption, each starting just after its caption appears and ending at least 0.15 s
# before the next one. A line that doesn't fit is spoken a little faster (Kokoro speed ≤ 1.1, then atempo ≤ 1.12);
# if it still doesn't fit, the picture holds on the last frame of that caption's stretch, and later chapters shift.
# Under the voice: the series' "drive" bed, 28 LU down. Mix at −16 LUFS, true peak ≤ −1.5 dBTP, AAC 128k.
#
#   <kokoro venv>/bin/python narrate.py plan    [ids…]   TTS (cached) and the fit of every line
#   <kokoro venv>/bin/python narrate.py build   [ids…]   voice + bed → AAC, muxed (video copied; re-encoded only with holds)
#   <kokoro venv>/bin/python narrate.py qa      [ids…]   Whisper small.en vs the captions and the spoken script, overruns, loudness
#   <kokoro venv>/bin/python narrate.py install [ids…]   replace the mp4s, shift chapters, set durations (videos.json, ::video)
#   then: npm run docs:media-manifest
#
# Run it on the SILENT render (docs:media / docs:scenes write videos without sound, so a re-recorded video loses its
# narration until this runs again; build refuses a video that already has sound). The script is lines.json (`say`
# where the spoken words differ from the caption); scene captions come from scene-captions.json (node
# scene-captions.mjs re-samples them after a scene changes); capture captions from the video's .vtt.
# Needs: ffmpeg, Kokoro (KOKORO_DIR with kokoro-v1.0.onnx, voices-v1.0.bin; kokoro-onnx, soundfile, faster-whisper),
# espeak-ng. Work files: scripts/docs-media/.data/narration/. RENDER_SLOT: a wrapper for the re-encode (shared CPU).
import sys, os, json, re, hashlib, subprocess, math, difflib
import numpy as np, soundfile as sf

SRC = os.path.dirname(os.path.abspath(__file__))
FRONT = os.path.abspath(os.path.join(SRC, "../../.."))
HERE = os.path.join(FRONT, "scripts/docs-media/.data/narration")
VID = f"{FRONT}/public/docs-assets/videos"
FF = os.environ.get("FFMPEG") or ("/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg")
FP = os.environ.get("FFPROBE") or ("/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else "ffprobe")
SLOT = os.environ.get("RENDER_SLOT", "")
BED = os.environ.get("NARRATION_BED") or os.path.expanduser("~/.cache/hk-render/music-moods/drive.mp3")
KOK = os.environ.get("KOKORO_DIR") or os.path.expanduser("~/.cache/kokoro")
VOICE, SR, FPS = "af_heart", 24000, 30
BED_DB = float(os.environ.get("BED_DB", 28))  # the music bed sits this many LU under the voice
LEAD, MARGIN = 0.18, 0.15  # voice starts LEAD after its caption appears; ends MARGIN before the next one appears
CAPTURE_OFFSET = 0.30  # capture .vtt cues are 0.3 s later than the video (the recording's trimmed start)
CFG = json.load(open(f"{SRC}/lines.json"))
SCN = json.load(open(f"{SRC}/scene-captions.json"))
os.makedirs(f"{HERE}/tts", exist_ok=True)


def run(*a, slot=False, **k):
    cmd = ([SLOT] if slot and SLOT else []) + list(a)
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **k)


def dur(f):
    return float(run(FP, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f).stdout.strip())


def vtt_parse(f):
    def ts(s):
        h, m, r = s.split(":")
        return int(h) * 3600 + int(m) * 60 + float(r)
    out = []
    for b in open(f).read().strip().split("\n\n")[1:]:
        ls = b.strip().split("\n")
        i = 0 if "-->" in ls[0] else 1
        a, z = ls[i].split("-->")
        out.append({"t0": ts(a.strip()), "t1": ts(z.strip().split()[0]), "text": "\n".join(ls[i + 1:])})
    return out


def vtt_write(f, cues):
    def ts(s):
        ms = max(0, round(s * 1000))
        return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d}.{ms % 1000:03d}"
    body = "\n\n".join(f"{i + 1}\n{ts(c['t0'])} --> {ts(c['t1'])}\n{c['text']}" for i, c in enumerate(cues))
    open(f, "w").write(f"WEBVTT\n\n{body}\n")


def auto_say(t):
    t = re.sub(r"markdrop\.in/([\w-]+)", lambda m: f"mark drop dot in slash {m.group(1)}", t)
    t = t.replace("markdrop.in", "mark drop dot in").replace("Markdrop", "Mark drop")
    t = t.replace(" › ", ", then ").replace(" · ", ", ").replace(" — ", ". ").replace("…", "").replace("⌘", "Command ")
    t = re.sub(r"\bEsc\b", "Escape", t)
    return re.sub(r"\s+", " ", t).strip()


def cues_for(vid):
    c = CFG[vid]
    total = dur(f"{VID}/{vid}.mp4")
    if "cues" in c:
        raw = [{"on": x["t0"], "text": x["text"]} for x in c["cues"]]
    elif c["kind"] == "scene":
        raw = [{"on": x["t0"], "text": x["text"]} for x in SCN[vid]["cues"]]
    else:
        raw = [{"on": x["t0"] - CAPTURE_OFFSET, "text": x["text"]} for x in vtt_parse(f"{VID}/{vid}.vtt")]
    for i, x in enumerate(raw):
        x["say"] = c["say"].get(str(i)) or auto_say(x["text"])
        x["start"] = round(x["on"] + LEAD, 3)
        nxt = raw[i + 1]["on"] if i + 1 < len(raw) else None
        x["deadline"] = round(nxt - MARGIN, 3) if nxt is not None else round(total - (0.6 if c["kind"] == "scene" else 0.35), 3)
        # where to hold the picture if the line needs more room: before the next caption (and a scene caption's fade-out)
        x["freeze"] = round((nxt - 0.45) if nxt is not None else total - (0.65 if c["kind"] == "scene" else 1 / FPS), 3)
    return raw, total


_k = None


def kokoro():
    global _k
    if _k is None:
        from kokoro_onnx import Kokoro, EspeakConfig
        _k = Kokoro(f"{KOK}/kokoro-v1.0.onnx", f"{KOK}/voices-v1.0.bin", espeak_config=EspeakConfig(lib_path="/opt/homebrew/lib/libespeak-ng.dylib", data_path="/opt/homebrew/share/espeak-ng-data"))
    return _k


def trim(a, thr=0.008, pad=0.03):
    idx = np.where(np.abs(a) > thr)[0]
    if not len(idx):
        return a
    p = int(pad * SR)
    return a[max(0, idx[0] - p): min(len(a), idx[-1] + p)]


def tts(text, speed):
    key = hashlib.sha1(f"{VOICE}|{speed}|{text}".encode()).hexdigest()[:16]
    f = f"{HERE}/tts/{key}.wav"
    if not os.path.exists(f):
        a, sr = kokoro().create(text, voice=VOICE, speed=speed, lang="en-us")
        assert sr == SR
        sf.write(f, trim(np.asarray(a, dtype=np.float32)), SR)
    return f


def atempo(src, factor):
    out = src.replace(".wav", f".at{factor:.3f}.wav")
    if not os.path.exists(out):
        run(FF, "-y", "-v", "error", "-i", src, "-af", f"atempo={factor:.4f}", "-ar", str(SR), out)
    return out


def plan(vid):
    cues, total = cues_for(vid)
    for x in cues:
        avail = x["deadline"] - x["start"] - 0.03  # a little slack for atempo/rounding
        x["avail"] = round(avail, 3)
        choice = None
        for sp in (1.0, 1.05, 1.1):
            f = tts(x["say"], sp)
            d = sf.info(f).duration
            if d <= avail:
                choice = {"speed": sp, "atempo": 1.0, "file": f, "dur": d, "ext": 0}
                break
        if not choice:
            d = sf.info(f).duration  # speed 1.1
            if d / avail <= 1.12:
                fa = math.ceil(d / avail * 1000) / 1000
                af = atempo(f, fa)
                choice = {"speed": 1.1, "atempo": fa, "file": af, "dur": sf.info(af).duration, "ext": 0}
            else:  # hold the picture: speed 1.1, a gentle 1.05 atempo, the rest as a freeze
                af = atempo(f, 1.05)
                d2 = sf.info(af).duration
                frames = math.ceil((d2 - avail) * FPS)
                choice = {"speed": 1.1, "atempo": 1.05, "file": af, "dur": d2, "ext": frames / FPS, "ext_frames": frames}
        x.update(choice)
    # shift for freezes
    shift = 0.0
    for x in cues:
        x["t_start"] = round(x["start"] + shift, 3)
        x["t_on"] = round(x["on"] + shift, 3)
        x["t_freeze"] = round(x["freeze"] + shift, 3)
        shift += x["ext"]
        x["t_deadline"] = round(x["deadline"] + shift, 3)
        x["t_end"] = round(x["t_start"] + x["dur"], 3)
    return {"id": vid, "kind": CFG[vid]["kind"], "total": total, "new_total": round(total + shift, 3), "ext": round(shift, 3), "cues": cues}


def show(p):
    print(f"== {p['id']}  {p['total']:.2f}s → {p['new_total']:.2f}s (+{p['ext']:.2f})")
    for x in p["cues"]:
        flag = f" FREEZE +{x['ext']:.2f}s at {x['freeze']:.2f}" if x["ext"] else ""
        print(f"  {x['on']:6.2f} avail {x['avail']:4.2f} dur {x['dur']:4.2f} sp {x['speed']} at {x['atempo']}{flag}  | {x['say']}")


def loudness(f, extra=()):
    r = subprocess.run([FF, "-hide_banner", "-nostats", "-i", f, *extra, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True).stderr
    tail = r[r.rfind("Summary:"):]
    I = float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1))
    tp = re.search(r"True peak:\s+Peak:\s+(-?[\d.inf]+) dBFS", tail, re.S)
    return I, float(tp.group(1)) if tp else None


def build(vid):
    p = plan(vid)
    od = f"{HERE}/out/{vid}"
    os.makedirs(od, exist_ok=True)
    total = p["new_total"]
    n = int(math.ceil(total * SR))
    voice = np.zeros(n, dtype=np.float32)
    for x in p["cues"]:
        a, sr = sf.read(x["file"], dtype="float32")
        assert sr == SR
        i0 = int(round(x["t_start"] * SR))
        voice[i0:i0 + len(a)] += a[: max(0, n - i0)]
    sf.write(f"{od}/voice.wav", voice, SR)
    vI, _ = loudness(f"{od}/voice.wav")
    bI, _ = loudness(BED)
    bed_gain = (vI - BED_DB) - bI
    fade_out = max(0, total - 1.5)
    mix = f"{od}/mix.wav"
    run(FF, "-y", "-v", "error", "-i", f"{od}/voice.wav", "-stream_loop", "-1", "-i", BED, "-filter_complex",
        f"[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0[v];[1:a]aresample=48000,atrim=0:{total:.3f},asetpts=PTS-STARTPTS,volume={bed_gain:.2f}dB,"
        f"afade=t=in:st=0:d=1.2,afade=t=out:st={fade_out:.3f}:d=1.5[b];[v][b]amix=inputs=2:normalize=0:duration=first[m]",
        "-map", "[m]", "-t", f"{total:.3f}", "-ar", "48000", mix)
    # two-pass loudnorm to −16 LUFS, true peak ≤ −1.5 dBTP
    r = subprocess.run([FF, "-hide_banner", "-nostats", "-i", mix, "-af", "loudnorm=I=-16:TP=-2.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    j0 = r.rfind("{"); m = json.loads(r[j0:r.index("}", j0) + 1])
    ln = (f"loudnorm=I=-16:TP=-2.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000")
    aac = f"{od}/audio.m4a"
    run(FF, "-y", "-v", "error", "-i", mix, "-af", ln, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", aac)
    src = f"{VID}/{vid}.mp4"
    assert not run(FP, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src).stdout.strip(), f"{src} already has sound: narrate the silent render"
    final = f"{od}/{vid}.mp4"
    if p["ext"] == 0:
        run(FF, "-y", "-v", "error", "-i", src, "-i", aac, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy",
            "-shortest", "-movflags", "+faststart", final)
        enc = "video copied"
    else:
        # hold frames: split at each freeze frame and clone its last frame
        segs, fl, a = [], [], 0
        for x in p["cues"]:
            if x["ext"]:
                f = int(round(x["freeze"] * FPS))
                segs.append((a, f, x["ext_frames"]))
                a = f
        segs.append((a, None, 0))
        for k, (s, e, pad) in enumerate(segs):
            tr = f"trim=start_frame={s}" + (f":end_frame={e}" if e is not None else "")
            fl.append(f"[0:v]{tr},setpts=PTS-STARTPTS" + (f",tpad=stop_mode=clone:stop={pad}" if pad else "") + f"[s{k}]")
        fl.append("".join(f"[s{k}]" for k in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[v]")
        scene = p["kind"] == "scene"
        vfile = f"{od}/video.mp4"
        run(FF, "-y", "-v", "error", "-i", src, "-filter_complex", ";".join(fl), "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow",
            "-tune", "animation" if scene else "stillimage", "-crf", "19" if scene else "22", "-profile:v", "high", "-r", "30",
            "-threads", "4", vfile, slot=True)
        run(FF, "-y", "-v", "error", "-i", vfile, "-i", aac, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy",
            "-shortest", "-movflags", "+faststart", final)
        enc = "video re-encoded with holds"
    I, tp = loudness(final)
    p.update({"final": final, "enc": enc, "lufs": I, "tp": tp, "final_dur": dur(final), "bytes_before": os.path.getsize(src), "bytes_after": os.path.getsize(final)})
    json.dump(p, open(f"{od}/plan.json", "w"), indent=1)
    print(f"built {vid}: {enc}, {p['total']:.2f}→{p['final_dur']:.2f}s, {I} LUFS, TP {tp}, {p['bytes_before']//1024}→{p['bytes_after']//1024} KB")
    return p


# ── QA ──
ALIASES = [("mark drop", "markdrop"), ("mark-drop", "markdrop"), ("read me", "readme"), ("git book", "gitbook"), ("q 3", "q3"), ("q3", "q3"),
           ("i d", "id"), ("q r", "qr"), ("u r l", "url"), ("a i", "ai"), ("m c p", "mcp"), ("dot", "."), ("slash", "/")]


def norm(s):
    s = s.lower().replace("’", "'")
    s = s.replace("markdrop.in", "markdrop dot in").replace("⌘", "command ").replace("#k=", " hash k equals ").replace("…", " ")
    s = re.sub(r"(\w)\.(\w)", r"\1 dot \2", s)
    s = re.sub(r"(\w)/(\w)", r"\1 slash \2", s)
    s = re.sub(r"[_\-]", " ", s)
    s = re.sub(r"[^a-z0-9' ]", " ", s)
    s = " " + " ".join(s.split()) + " "
    s = s.replace(" mark drop's ", " markdrop's ")
    for a, b in [("mark drop", "markdrop"), ("read me", "readme"), ("git book", "gitbook"), ("q 3", "q3"), ("i d", "id"), ("q r", "qr"), ("u r l", "url"),
                 ("a i", "ai"), ("m c p", "mcp"), ("k equals", "k equals"), ("underscore", ""), ("esc ", "escape "), ("re watching", "rewatching"), ("re watched", "rewatched"),
                 ("multi page", "multipage"), ("work spaces", "workspaces"), ("set up", "setup"), ("sign in", "signin"), ("full screen", "fullscreen"),
                 ("north wind", "northwind"), ("recognizes", "recognises"), ("seven", "7"), ("thirty", "30"), ("ninety", "90"), ("two", "2"), ("four", "4"),
                 ("e mail", "email"), ("i phone", "iphone"), ("dns", "dns"), ("d n s", "dns"), ("v s code", "vscode")]:
        s = s.replace(f" {a} ", f" {b} ")
    return [w.strip("'") for w in s.split() if w.strip("'")]


_wm = None


def qa(vid):
    global _wm
    from faster_whisper import WhisperModel
    p = json.load(open(f"{HERE}/out/{vid}/plan.json"))
    _wm = _wm or WhisperModel("small.en", device="cpu", compute_type="int8")
    # VAD on: these clips have long quiet stretches, where Whisper otherwise invents text
    segs, _ = _wm.transcribe(p["final"], beam_size=5, vad_filter=True, condition_on_previous_text=False)
    heard = " ".join(s.text.strip() for s in segs)
    def cmp(ref):
        a, b = norm(ref), norm(heard)
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        errs = sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal")
        diffs = [f"{op}: '{' '.join(a[i1:i2])}' → '{' '.join(b[j1:j2])}'" for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal"]
        return round(100 * (1 - errs / max(1, len(a))), 1), diffs
    cap_match, cap_diffs = cmp(" ".join(x["text"] for x in p["cues"]))
    say_match, say_diffs = cmp(" ".join(x["say"] for x in p["cues"]))
    over = []
    cues = p["cues"]
    for i, x in enumerate(cues):
        nxt_on = cues[i + 1]["t_on"] if i + 1 < len(cues) else p["final_dur"]
        gap = nxt_on - x["t_end"]
        if gap < (MARGIN if i + 1 < len(cues) else 0.2) - 1e-6:
            over.append(f"{i}: ends {x['t_end']:.2f}, next caption {nxt_on:.2f} (gap {gap:.2f})")
    p["qa"] = {"heard": heard, "caption_match": cap_match, "caption_diffs": cap_diffs, "spoken_match": say_match, "spoken_diffs": say_diffs, "overruns": over}
    json.dump(p, open(f"{HERE}/out/{vid}/plan.json", "w"), indent=1)
    print(f"qa {vid}: captions {cap_match}% · spoken script {say_match}% · overruns {len(over)} · {p['lufs']} LUFS TP {p['tp']}")
    for d in say_diffs:
        print(f"   spoken≠heard {d}")
    for o in over:
        print(f"   OVERRUN {o}")
    return p


def install(ids):
    import glob, shutil
    VJ = f"{FRONT}/content/docs/videos.json"
    videos = json.load(open(VJ))
    fmt = lambda s: f"{int(s // 60)}:{int(round(s % 60)):02d}"
    changed = {}
    for plan_file in [f"{HERE}/out/{i}/plan.json" for i in ids]:
        p = json.load(open(plan_file))
        vid = p["id"]
        if not p.get("qa") or p["qa"]["overruns"]:
            print(f"skip {vid}: no QA or overruns"); continue
        shutil.copyfile(p["final"], f"{VID}/{vid}.mp4")
        if p["ext"]:
            off = CAPTURE_OFFSET if p["kind"] == "capture" else 0.0
            holds = [(x["freeze"], x["ext"]) for x in p["cues"] if x["ext"]]
            s = lambda t: sum(e for F, e in holds if t - off > F - 1e-6)
            cues = vtt_parse(f"{VID}/{vid}.vtt")
            for c in cues:
                c["t0"], c["t1"] = c["t0"] + s(c["t0"]), c["t1"] + s(c["t1"])
            cues[-1]["t1"] = min(cues[-1]["t1"], p["final_dur"])
            vtt_write(f"{VID}/{vid}.vtt", cues)
        d = fmt(dur(f"{VID}/{vid}.mp4"))
        if videos[vid].get("duration") != d:
            changed[vid] = (videos[vid].get("duration"), d)
            videos[vid]["duration"] = d
        print(f"installed {vid}: {d}{'  (holds +%.2fs)' % p['ext'] if p['ext'] else ''}")
    json.dump(videos, open(VJ, "w"), indent=2, ensure_ascii=False)
    open(VJ, "a").write("\n")
    # ::video{id="x" … duration="m:ss"} on the pages
    for md in glob.glob(f"{FRONT}/content/docs/**/*.md", recursive=True):
        t = open(md).read()
        def fix(m):
            vid = m.group(1)
            if vid not in videos or vid not in ids:
                return m.group(0)
            return re.sub(r'duration="[^"]*"', f'duration="{videos[vid]["duration"]}"', m.group(0))
        t2 = re.sub(r'::video\{id="([\w-]+)"[^}]*\}', fix, t)
        if t2 != t:
            open(md, "w").write(t2); print(f"  page {os.path.relpath(md, FRONT)}")
    print("videos.json duration changes:", changed)


if __name__ == "__main__":
    cmd, ids = sys.argv[1], sys.argv[2:] or [k for k in CFG if not k.startswith("_")]
    for v in ids:
        if cmd == "plan":
            show(plan(v))
        elif cmd == "build":
            build(v)
        elif cmd == "qa":
            qa(v)
    if cmd == "install":
        install(ids)

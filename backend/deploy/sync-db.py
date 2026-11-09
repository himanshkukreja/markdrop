"""sync-db.py — copy a live Markdrop database to another MongoDB and keep it in step until cut-over.

    SRC_URI=… DEST_URI=… python backend/deploy/sync-db.py [--db markdrop] [--stop-file /tmp/markdrop-sync.stop]

1. Opens a change stream on the source (so nothing written during the copy is missed).
2. mongodump | mongorestore --drop of the whole database (the slow part; the app keeps running).
3. Applies every change recorded since step 1, then follows new ones live ("LIVE lag …" lines).
4. When the stop file appears (create it after stopping the app), drains the stream, compares every
   collection's document count, and exits 0 only if they all match.

Changes are applied as full-document upserts (updateLookup) and deletes, so replaying a change the
dump already contains is harmless. A drop/rename on the source aborts — copy again.
URIs come from the environment and are never printed. Needs mongodump/mongorestore on PATH and pymongo.
"""
import argparse
import os
import queue
import subprocess
import sys
import threading
import time

import pymongo
from pymongo import ReplaceOne, DeleteOne


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def same_server(a, b) -> bool:
    """True when both clients reach the same mongod (e.g. a tunnel looping back to the destination)."""
    def ident(c):
        return (c.admin.command("hostInfo")["system"].get("hostname"),
                c.admin.command("serverStatus", repl=0, metrics=0, locks=0).get("pid"))
    return ident(a) == ident(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="markdrop")
    ap.add_argument("--stop-file", default="/tmp/markdrop-sync.stop")
    args = ap.parse_args()
    src_uri, dest_uri = os.environ["SRC_URI"], os.environ["DEST_URI"]
    if os.path.exists(args.stop_file):
        os.remove(args.stop_file)

    src_client, dst_client = pymongo.MongoClient(src_uri), pymongo.MongoClient(dest_uri)
    if same_server(src_client, dst_client):
        sys.exit("✗ source and destination are the same MongoDB server (check the tunnel): refusing")
    src = src_client[args.db]
    dst = dst_client[args.db]

    events: "queue.Queue[dict]" = queue.Queue()
    failure: list = []
    opened = threading.Event()

    def follow():
        try:
            with src.watch(full_document="updateLookup", max_await_time_ms=500) as stream:
                opened.set()
                while True:
                    ch = stream.try_next()
                    if ch is not None:
                        events.put(ch)
        except Exception as e:  # surfaced in the main thread
            failure.append(e)
            opened.set()

    threading.Thread(target=follow, daemon=True).start()
    opened.wait(30)
    if failure:
        raise failure[0]
    log("change stream open; copying (the app keeps running)")

    t0 = time.time()
    dump = subprocess.Popen(["mongodump", f"--uri={src_uri}", f"--db={args.db}", "--archive", "--quiet"],
                            stdout=subprocess.PIPE)
    restore = subprocess.run(["mongorestore", f"--uri={dest_uri}", "--archive", "--drop",
                              f"--nsInclude={args.db}.*", "--quiet"], stdin=dump.stdout)
    dump.stdout.close()
    if dump.wait() != 0 or restore.returncode != 0:
        sys.exit("✗ dump/restore failed")
    log(f"copied in {time.time() - t0:.0f} s; applying changes recorded meanwhile ({events.qsize()})")

    applied = 0
    last_report = 0.0
    stop_seen_at = None
    while True:
        if failure:
            raise failure[0]
        batch: dict[str, list] = {}
        while len(batch) < 200:
            try:
                ch = events.get(timeout=0.2)
            except queue.Empty:
                break
            op = ch["operationType"]
            if op in ("drop", "rename", "dropDatabase", "invalidate"):
                sys.exit(f"✗ source had a {op} on {ch.get('ns')}: run the copy again")
            coll = ch["ns"]["coll"]
            key = ch["documentKey"]
            if op in ("insert", "replace", "update"):
                doc = ch.get("fullDocument")
                if doc is None:
                    continue  # deleted since; its delete event follows
                batch.setdefault(coll, []).append(ReplaceOne(key, doc, upsert=True))
            elif op == "delete":
                batch.setdefault(coll, []).append(DeleteOne(key))
        for coll, ops in batch.items():
            dst[coll].bulk_write(ops, ordered=True)
            applied += len(ops)
        now = time.time()
        if now - last_report > 15:
            log(f"LIVE applied {applied}, waiting {events.qsize()}")
            last_report = now
        if os.path.exists(args.stop_file):
            if stop_seen_at is None:
                stop_seen_at = now
                log("stop requested: draining")
            # the app is stopped: 3 quiet seconds after the request = drained
            if not batch and events.empty() and now - stop_seen_at > 3:
                break

    log(f"drained ({applied} changes applied); comparing counts")
    names = sorted(n for n in src.list_collection_names() if not n.startswith("system."))
    bad = [f"{n}: {a} → {b}" for n in names
           for a, b in [(src[n].count_documents({}), dst[n].count_documents({}))] if a != b]
    for line in bad:
        log(f"✗ {line}")
    if bad:
        sys.exit(1)
    log(f"✓ {len(names)} collections match")


if __name__ == "__main__":
    main()

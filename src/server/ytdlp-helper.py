#!/usr/bin/env python3
"""Long-lived yt-dlp worker for the music server (see ytdlp-runner.ts).

The yt-dlp command spends about 0.3 s starting Python and importing yt-dlp, and
on the mini it took ~0.8 s longer than this process for the same YouTube
requests. The server keeps one of these running and sends it yt-dlp's own
command-line arguments, so it can fall back to the command with the same ones.

One JSON object per line:
  first line out: {"ready": true, "version": "..."} or {"ready": false, "error": "..."}
  request in:     {"id": 1, "args": ["--flat-playlist", "-J", "ytsearch6:..."]}
  response out:   {"id": 1, "ok": true, "stdout": "..."}  # what the command would print
                  {"id": 1, "ok": false, "kind": "ytdlp" | "internal", "error": "..."}

"ytdlp" errors are failures the command would report too. "internal" errors
come from running in this process, and the server retries those as a command.
"""
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

# Jobs run side by side, so a background download never holds up the song
# someone is waiting for.
MAX_JOBS = 4


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: ytdlp-helper.py <yt-dlp path>")
    # Keep the protocol on a private copy of stdout. Anything yt-dlp or its child
    # processes (ffmpeg, deno) print goes to stderr instead.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    write_lock = threading.Lock()

    def send(message):
        line = json.dumps(message, ensure_ascii=False)
        with write_lock:
            protocol.write(line + "\n")
            protocol.flush()

    try:
        # A zipapp is importable from its own path; other installs are found on
        # the path of the interpreter named in their shebang.
        sys.path.insert(0, sys.argv[1])
        import yt_dlp
        from yt_dlp.utils import YoutubeDLError
    except BaseException as error:
        send({"ready": False, "error": f"{type(error).__name__}: {error}"})
        return
    send({"ready": True, "version": yt_dlp.version.__version__})

    # Each job reads the cookies file when it starts and saves it when it ends,
    # as the command does. Keep those reads and writes from overlapping.
    cookies_lock = threading.Lock()

    def run(args):
        parsed = yt_dlp.parse_options(args)
        with cookies_lock:
            ydl = yt_dlp.YoutubeDL(parsed.ydl_opts)
            ydl.cookiejar  # loads the cookies file
        try:
            if parsed.ydl_opts.get("dump_single_json"):
                info = ydl.extract_info(parsed.urls[0], download=False)
                ydl.post_extract(info)
                return json.dumps(ydl.sanitize_info(info))
            if ydl.download(parsed.urls):
                raise YoutubeDLError("yt-dlp reported a failed download")
            return ""
        finally:
            with cookies_lock:
                ydl.close()

    def handle(request):
        request_id = request.get("id")
        try:
            send({"id": request_id, "ok": True, "stdout": run(request["args"])})
        except (YoutubeDLError, SystemExit) as error:
            # SystemExit: yt-dlp rejected the arguments, as the command would.
            send({"id": request_id, "ok": False, "kind": "ytdlp", "error": str(error)})
        except BaseException as error:
            send({"id": request_id, "ok": False, "kind": "internal", "error": f"{type(error).__name__}: {error}"})

    pool = ThreadPoolExecutor(max_workers=MAX_JOBS)
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, request)
    # The server closed stdin, so it has gone away. Stop without waiting for jobs.
    os._exit(0)


if __name__ == "__main__":
    main()

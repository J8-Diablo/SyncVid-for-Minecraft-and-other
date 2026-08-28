"""SyncVid server — Python port of server.js.

FastAPI + python-socketio (ASGI) + uvicorn.
Compatible with the existing public/ frontend and socket.io JS client.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

import socketio
import uvicorn
import engineio.payload
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile

# engineio caps each HTTP long-poll POST to 16 packets by default, which is
# trivially exceeded by the sub-screen editor when sliders fire bursts of
# frameUpdate events. Raise the ceiling so we don't drop legitimate traffic.
engineio.payload.Payload.max_decode_packets = 500
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles


# ---------------------------------------------------------------------------
# Paths & packaging detection
# ---------------------------------------------------------------------------

IS_FROZEN = getattr(sys, "frozen", False)
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))

if IS_FROZEN:
    appdata_root = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA") or os.getcwd()
    DATA_DIR = Path(appdata_root) / "SyncVid"
else:
    DATA_DIR = RESOURCE_DIR

PUBLIC_DIR = RESOURCE_DIR / "public"
LOCALES_DIR = RESOURCE_DIR / "locales"
RESOURCE_VIDEOS_DIR = PUBLIC_DIR / "videos"
RESOURCE_STREAMS_DIR = PUBLIC_DIR / "streams"

VIDEOS_DIR = (DATA_DIR / "videos") if IS_FROZEN else RESOURCE_VIDEOS_DIR
UPLOADS_DIR = (DATA_DIR / "uploads") if IS_FROZEN else (RESOURCE_DIR / "uploads")
LAYOUTS_DIR = (DATA_DIR / "layouts") if IS_FROZEN else (RESOURCE_DIR / "layouts")
STREAMS_DIR = (DATA_DIR / "streams") if IS_FROZEN else RESOURCE_STREAMS_DIR
CONFIG_DIR = (DATA_DIR / "config") if IS_FROZEN else (RESOURCE_DIR / "config")

API_CONFIG_PATH = CONFIG_DIR / "api.json"
RTMP_OUTPUT_DIR = STREAMS_DIR / "rtmp"
RTMP_MANIFEST_PATH = RTMP_OUTPUT_DIR / "index.m3u8"
RTMP_MANIFEST_URL = "/streams/rtmp/index.m3u8"
CALIB_DEBUG_DIR = (DATA_DIR / "debug" / "calibration") if IS_FROZEN else (RESOURCE_DIR / "debug" / "calibration")

for d in (DATA_DIR, VIDEOS_DIR, UPLOADS_DIR, LAYOUTS_DIR, STREAMS_DIR, CONFIG_DIR, CALIB_DEBUG_DIR):
    d.mkdir(parents=True, exist_ok=True)


def seed_videos() -> None:
    if not IS_FROZEN:
        return
    try:
        existing = [f for f in VIDEOS_DIR.iterdir() if f.suffix.lower() == ".webm"]
        if existing:
            return
        if not RESOURCE_VIDEOS_DIR.exists():
            return
        for src in RESOURCE_VIDEOS_DIR.iterdir():
            if src.suffix.lower() != ".webm":
                continue
            try:
                shutil.copy2(src, VIDEOS_DIR / src.name)
            except OSError:
                pass
    except OSError:
        pass


seed_videos()


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

current_video_src: str = ""
is_playing: bool = False
master_time: float = 0.0
layout_frames: dict[int, dict[str, float]] = {}
current_stream_mode: str = "file"
rtmp_process: Optional[asyncio.subprocess.Process] = None
rtmp_source_url: str = ""

displays: dict[str, dict[str, Any]] = {}

api_config: dict[str, Any] = {"enabled": False, "token": ""}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        f = float(value)
        if f != f:  # NaN
            return default
        return f
    except (TypeError, ValueError):
        return default


def _to_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# Windows opens a console window for every child process unless told otherwise.
# server.js passed windowsHide for ffmpeg; the Python port had dropped it, so
# both ffmpeg and the WebRTC server flashed a blank terminal.
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


VALID_SUBSCREEN_SHAPES = {"rect", "circle", "triangle", "polygon"}


def _clamp(value: float, lo: float, hi: float) -> float:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def normalize_subscreen_payload(sub: Any) -> Optional[dict[str, Any]]:
    if not isinstance(sub, dict):
        return None
    sub_id = _to_int(sub.get("id"))
    if sub_id is None:
        return None
    shape = sub.get("shape")
    if shape not in VALID_SUBSCREEN_SHAPES:
        shape = "rect"
    color_raw = sub.get("color") if isinstance(sub.get("color"), dict) else {}
    color = {
        "r": int(_clamp(_to_float(color_raw.get("r"), 255), 0, 255)),
        "g": int(_clamp(_to_float(color_raw.get("g"), 255), 0, 255)),
        "b": int(_clamp(_to_float(color_raw.get("b"), 255), 0, 255)),
    }
    points: list[list[float]] = []
    raw_points = sub.get("points")
    if isinstance(raw_points, list):
        for p in raw_points:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                points.append([_to_float(p[0], 0.0), _to_float(p[1], 0.0)])
    return {
        "id": sub_id,
        "shape": shape,
        "x": _to_float(sub.get("x"), 0.0),
        "y": _to_float(sub.get("y"), 0.0),
        "width": _to_float(sub.get("width"), 0.0),
        "height": _to_float(sub.get("height"), 0.0),
        "rotation": _to_float(sub.get("rotation"), 0.0),
        "points": points,
        "color": color,
        "dimmer": int(_clamp(_to_float(sub.get("dimmer"), 255), 0, 255)),
        "dmxAddress": _to_int(sub.get("dmxAddress")),
    }


def normalize_frame_payload(frame: Any) -> Optional[dict[str, Any]]:
    if not isinstance(frame, dict):
        return None
    frame_id = _to_int(frame.get("id"))
    if frame_id is None:
        return None
    sub_screens: list[dict[str, Any]] = []
    raw_subs = frame.get("subScreens")
    if isinstance(raw_subs, list):
        for s in raw_subs:
            normalized = normalize_subscreen_payload(s)
            if normalized is not None:
                sub_screens.append(normalized)
    return {
        "id": frame_id,
        "x": _to_float(frame.get("x"), 0.0),
        "y": _to_float(frame.get("y"), 0.0),
        "width": _to_float(frame.get("width"), 0.0),
        "height": _to_float(frame.get("height"), 0.0),
        "subScreens": sub_screens,
    }


def update_layout_frame(frame: Any) -> None:
    normalized = normalize_frame_payload(frame)
    if normalized is None:
        return
    layout_frames[normalized["id"]] = normalized


def replace_layout_frames(frames: Any) -> None:
    global layout_frames
    next_frames: dict[int, dict[str, float]] = {}
    if isinstance(frames, list):
        for frame in frames:
            normalized = normalize_frame_payload(frame)
            if normalized is not None:
                next_frames[normalized["id"]] = normalized
    layout_frames = next_frames


def build_sync_state() -> dict[str, Any]:
    return {
        "src": current_video_src or "",
        "time": master_time if isinstance(master_time, (int, float)) else 0,
        "playing": bool(is_playing),
        "frames": list(layout_frames.values()),
        "mode": current_stream_mode,
    }


def ensure_rtmp_dir() -> None:
    RTMP_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def clear_rtmp_dir() -> None:
    if RTMP_OUTPUT_DIR.exists():
        shutil.rmtree(RTMP_OUTPUT_DIR, ignore_errors=True)
    RTMP_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def to_listen_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        host_port = "0.0.0.0"
        if parts.port:
            host_port = f"0.0.0.0:{parts.port}"
        return urlunsplit((parts.scheme, host_port, parts.path, parts.query, parts.fragment))
    except ValueError:
        return url


async def stop_rtmp_transcode() -> None:
    global rtmp_process
    if rtmp_process is None:
        return
    proc = rtmp_process
    rtmp_process = None
    try:
        proc.kill()
    except ProcessLookupError:
        pass


async def _rtmp_log_reader(proc: asyncio.subprocess.Process) -> None:
    if proc.stderr is None:
        return
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
        msg = line.decode("utf-8", errors="replace").strip()
        if msg:
            print(f"[rtmp] {msg}", flush=True)
    code = await proc.wait()
    print(f"[rtmp] ffmpeg exited with code {code}", flush=True)


async def start_rtmp_transcode(url: str, listen_mode: bool = True) -> None:
    global rtmp_process, rtmp_source_url
    await stop_rtmp_transcode()
    clear_rtmp_dir()
    rtmp_source_url = url
    input_url = to_listen_url(url) if listen_mode else url
    args = [
        "-nostdin",
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-rtmp_live", "live",
        *(["-listen", "1"] if listen_mode else []),
        "-i", input_url,
        "-c:v", "copy",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-f", "hls",
        "-hls_time", "1",
        "-hls_list_size", "6",
        "-hls_flags", "delete_segments+append_list+omit_endlist",
        "-hls_segment_filename", str(RTMP_OUTPUT_DIR / "seg_%05d.ts"),
        str(RTMP_MANIFEST_PATH),
    ]
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=NO_WINDOW,
    )
    rtmp_process = proc
    asyncio.create_task(_rtmp_log_reader(proc))


WIN_RESERVED_NAME = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE)


def sanitize_video_filename(name: Any) -> str:
    """Reduce an uploaded filename to a safe basename ending in .webm.

    The multipart filename is attacker-controlled and Starlette hands it over
    verbatim, so every path component has to go before it touches a path.
    Accents and spaces are kept; only what breaks a path or a filesystem is
    removed — control characters, the Windows-reserved punctuation, and
    leading/trailing dots (which is what collapses "." and ".." to the default).
    """
    # Split on both separators: a backslash is a plain character on POSIX, so
    # Path() alone would leave "..\..\x" intact there.
    base = re.split(r"[\\/]", str(name or ""))[-1]
    stem = Path(base).stem
    cleaned = re.sub(r'[\x00-\x1f<>:"|?*]+', "-", stem).strip(". -")[:120]
    if not cleaned:
        return "video.webm"
    if WIN_RESERVED_NAME.match(cleaned):
        # CON.webm, NUL.webm… still address devices on Windows, not files.
        cleaned = f"_{cleaned}"
    return f"{cleaned}.webm"


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def sanitize_layout_id(name: Any) -> str:
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", str(name or "").lower())
    cleaned = re.sub(r"^-+|-+$", "", cleaned)[:60]
    return cleaned or "layout"


def resolve_layout_path(layout_id: str) -> Optional[Path]:
    if not re.match(r"^[A-Za-z0-9_-]+$", layout_id or ""):
        return None
    return LAYOUTS_DIR / f"{layout_id}.json"


def load_api_config() -> None:
    if not API_CONFIG_PATH.exists():
        return
    try:
        data = json.loads(API_CONFIG_PATH.read_text(encoding="utf-8"))
        api_config["enabled"] = bool(data.get("enabled"))
        token = data.get("token")
        api_config["token"] = token if isinstance(token, str) else ""
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Failed to load API config: {exc}", flush=True)


def save_api_config() -> None:
    API_CONFIG_PATH.write_text(json.dumps(api_config, indent=2), encoding="utf-8")


def extract_token(request: Request, body: Optional[dict[str, Any]] = None) -> str:
    header_token = request.headers.get("x-api-token")
    if header_token and header_token.strip():
        return header_token.strip()
    auth = request.headers.get("authorization")
    if auth and auth.startswith("Bearer "):
        return auth[7:].strip()
    query_token = request.query_params.get("token")
    if query_token:
        return query_token.strip()
    if body and isinstance(body.get("token"), str):
        return body["token"].strip()
    return ""


async def require_api_token(request: Request) -> None:
    if not api_config["enabled"]:
        return
    if not api_config["token"]:
        raise HTTPException(status_code=401, detail="API token not configured")
    try:
        body = await request.json()
    except Exception:
        body = None
    token = extract_token(request, body if isinstance(body, dict) else None)
    if not token or token != api_config["token"]:
        raise HTTPException(status_code=401, detail="Invalid API token")


load_api_config()


# ---------------------------------------------------------------------------
# FastAPI + Socket.IO app
# ---------------------------------------------------------------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    max_http_buffer_size=10_000_000,
)

fastapi_app = FastAPI()

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5000", "http://localhost:5000"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "x-api-token", "Authorization"],
    allow_credentials=False,
)


# --------- Upload ---------

@fastapi_app.post("/upload")
async def upload_video(video: UploadFile = File(...), clientId: Optional[str] = Form(None)) -> JSONResponse:
    final_name = sanitize_video_filename(video.filename)
    dest = VIDEOS_DIR / final_name
    # Defence in depth: the sanitizer above already removes every path
    # component, so a dest outside VIDEOS_DIR means the sanitizer regressed.
    if not is_inside(dest, VIDEOS_DIR):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    try:
        with dest.open("wb") as fh:
            while True:
                chunk = await video.read(1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
    except OSError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    print(f"Upload terminé : {final_name}", flush=True)
    return JSONResponse({"filename": final_name})


# --------- Videos ---------

@fastapi_app.get("/videos/list")
async def videos_list() -> JSONResponse:
    try:
        files = [f.name for f in VIDEOS_DIR.iterdir() if f.suffix.lower() == ".webm"]
    except OSError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse({"videos": files})


# --------- Layouts ---------

@fastapi_app.get("/layouts/list")
async def layouts_list() -> JSONResponse:
    try:
        entries = []
        for f in LAYOUTS_DIR.iterdir():
            if f.suffix.lower() != ".json":
                continue
            layout_id = f.stem
            name = layout_id
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("name"):
                    name = data["name"]
            except (OSError, json.JSONDecodeError):
                pass
            entries.append({"id": layout_id, "name": name})
    except OSError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse({"layouts": entries})


@fastapi_app.post("/layouts/save")
async def layouts_save(request: Request) -> JSONResponse:
    body = await request.json()
    name = body.get("name") if isinstance(body, dict) else None
    frames = body.get("frames") if isinstance(body, dict) else None
    if not isinstance(frames, list):
        return JSONResponse({"error": "Invalid layout frames"}, status_code=400)
    layout_name = name.strip() if isinstance(name, str) and name.strip() else f"layout-{int(time.time() * 1000)}"
    base_id = sanitize_layout_id(layout_name)
    layout_id = base_id
    file_path = LAYOUTS_DIR / f"{layout_id}.json"
    if file_path.exists():
        layout_id = f"{base_id}-{int(time.time() * 1000)}"
        file_path = LAYOUTS_DIR / f"{layout_id}.json"
    payload = {
        "id": layout_id,
        "name": layout_name,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "frames": frames,
    }
    try:
        file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse({"id": layout_id, "name": layout_name})


@fastapi_app.get("/layouts/export/{layout_id}")
async def layouts_export(layout_id: str) -> Response:
    file_path = resolve_layout_path(layout_id)
    if file_path is None:
        return JSONResponse({"error": "Invalid layout id"}, status_code=400)
    if not file_path.exists():
        return JSONResponse({"error": "Layout not found"}, status_code=404)
    return FileResponse(
        path=file_path,
        media_type="application/json",
        filename=f"{layout_id}.json",
    )


@fastapi_app.get("/layouts/{layout_id}")
async def layouts_get(layout_id: str) -> Response:
    file_path = resolve_layout_path(layout_id)
    if file_path is None:
        return JSONResponse({"error": "Invalid layout id"}, status_code=400)
    if not file_path.exists():
        return JSONResponse({"error": "Layout not found"}, status_code=404)
    return Response(content=file_path.read_text(encoding="utf-8"), media_type="application/json")


@fastapi_app.delete("/layouts/{layout_id}")
async def layouts_delete(layout_id: str) -> JSONResponse:
    file_path = resolve_layout_path(layout_id)
    if file_path is None:
        return JSONResponse({"error": "Invalid layout id"}, status_code=400)
    if not file_path.exists():
        return JSONResponse({"error": "Layout not found"}, status_code=404)
    try:
        file_path.unlink()
    except OSError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse({"ok": True})


# --------- API config ---------

@fastapi_app.get("/api/config")
async def get_api_config() -> JSONResponse:
    return JSONResponse({"enabled": api_config["enabled"], "token": api_config["token"] or ""})


@fastapi_app.post("/api/config")
async def post_api_config(request: Request) -> JSONResponse:
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    enabled = bool(body.get("enabled"))
    token = body.get("token")
    token = token.strip() if isinstance(token, str) else ""
    if enabled and not token:
        return JSONResponse({"error": "Token required when API is enabled"}, status_code=400)
    api_config["enabled"] = enabled
    api_config["token"] = token if enabled else ""
    save_api_config()
    return JSONResponse({"enabled": api_config["enabled"], "token": api_config["token"] or ""})


# --------- RTMP ---------

@fastapi_app.post("/rtmp/start")
async def rtmp_start(request: Request) -> JSONResponse:
    global current_video_src, current_stream_mode, master_time
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    url = body.get("url")
    url = url.strip() if isinstance(url, str) else ""
    listen_mode = body.get("listen")
    listen_mode = bool(listen_mode) if isinstance(listen_mode, bool) else True
    if not url or not url.startswith("rtmp://"):
        return JSONResponse({"error": "Invalid RTMP url"}, status_code=400)
    if not has_ffmpeg():
        return JSONResponse({"error": "ffmpeg not found in PATH"}, status_code=500)
    ensure_rtmp_dir()
    await start_rtmp_transcode(url, listen_mode)
    current_video_src = RTMP_MANIFEST_URL
    current_stream_mode = "rtmp"
    master_time = 0
    return JSONResponse({"ok": True, "hlsUrl": RTMP_MANIFEST_URL, "listen": listen_mode})


@fastapi_app.post("/rtmp/stop")
async def rtmp_stop() -> JSONResponse:
    global rtmp_source_url
    await stop_rtmp_transcode()
    rtmp_source_url = ""
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# WebRTC (WHIP/WHEP) server supervision
# ---------------------------------------------------------------------------
# whep_server.py runs as its own process: it monkey-patches aiortc at import
# time, so it cannot share this interpreter. We spawn it, keep a bounded tail
# of its log, and proxy its /health and /debug/stats to the control panel.

WEBRTC_SCRIPT = RESOURCE_DIR / "webrtc_server" / "whep_server.py"
WEBRTC_PORT = int(os.environ.get("WEBRTC_PORT") or 8080)
WEBRTC_BASE = f"http://127.0.0.1:{WEBRTC_PORT}"
WEBRTC_LOG_LINES = 500

webrtc_process: Optional[asyncio.subprocess.Process] = None
webrtc_log: deque[str] = deque(maxlen=WEBRTC_LOG_LINES)
webrtc_log_seq: int = 0          # total lines ever emitted, for incremental fetch
webrtc_started_at: Optional[float] = None
webrtc_options: dict[str, Any] = {
    "videoBitrate": 15000,
    "audioBitrate": 192,
    "codec": "h264",
    "verbose": False,
}


def webrtc_python() -> Optional[str]:
    """Interpreter to run whep_server.py with.

    Prefer pythonw.exe: python.exe is a console binary and Windows attaches a
    console to it even with CREATE_NO_WINDOW, which pops an empty terminal in
    the operator's face. pythonw.exe is a GUI-subsystem build and never does.
    Frozen builds must not re-launch themselves, so they look on PATH instead.
    """
    candidates: list[Optional[str]] = []
    if not IS_FROZEN:
        exe = Path(sys.executable)
        if sys.platform == "win32":
            # pythonw sitting next to the running interpreter is the same build.
            candidates.append(str(exe.with_name(exe.name.replace("python", "pythonw", 1))))
            candidates.append(str(exe.with_name("pythonw.exe")))
        candidates.append(sys.executable)
    if sys.platform == "win32":
        candidates.append(shutil.which("pythonw"))
    candidates.extend([shutil.which("python"), shutil.which("py")])

    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def webrtc_append_log(line: str) -> None:
    global webrtc_log_seq
    webrtc_log.append(line)
    webrtc_log_seq += 1


async def _webrtc_log_reader(proc: asyncio.subprocess.Process) -> None:
    if proc.stderr is None:
        return
    while True:
        raw = await proc.stderr.readline()
        if not raw:
            break
        text = raw.decode("utf-8", errors="replace").rstrip()
        if text:
            webrtc_append_log(text)
    code = await proc.wait()
    webrtc_append_log(f"--- processus termine (code {code}) ---")


def webrtc_build_args() -> list[str]:
    args = [
        str(WEBRTC_SCRIPT),
        "--port", str(WEBRTC_PORT),
        "--video-bitrate", str(int(webrtc_options["videoBitrate"])),
        "--audio-bitrate", str(int(webrtc_options["audioBitrate"])),
        "--video-codec", str(webrtc_options["codec"]),
    ]
    if webrtc_options["verbose"]:
        args.append("--verbose")
    return args


def webrtc_is_owned_running() -> bool:
    return webrtc_process is not None and webrtc_process.returncode is None


def _http_get_json(path: str, timeout: float = 1.5) -> Optional[dict[str, Any]]:
    import urllib.request
    try:
        with urllib.request.urlopen(f"{WEBRTC_BASE}{path}", timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


async def webrtc_fetch(path: str) -> Optional[dict[str, Any]]:
    return await asyncio.to_thread(_http_get_json, path)


async def start_webrtc() -> tuple[bool, str]:
    global webrtc_process, webrtc_started_at
    if webrtc_is_owned_running():
        return False, "Le serveur WebRTC tourne deja"
    if not WEBRTC_SCRIPT.exists():
        return False, f"Script introuvable : {WEBRTC_SCRIPT}"
    python = webrtc_python()
    if not python:
        return False, "Aucun interpreteur Python disponible pour lancer le serveur"
    if await webrtc_fetch("/health") is not None:
        return False, f"Le port {WEBRTC_PORT} est deja occupe par un autre processus"

    webrtc_log.clear()
    webrtc_append_log(f"--- demarrage : {python} {' '.join(webrtc_build_args())} ---")
    try:
        proc = await asyncio.create_subprocess_exec(
            python, *webrtc_build_args(),
            cwd=str(WEBRTC_SCRIPT.parent),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=NO_WINDOW,
        )
    except OSError as exc:
        return False, f"Lancement impossible : {exc}"
    webrtc_process = proc
    webrtc_started_at = time.time()
    asyncio.create_task(_webrtc_log_reader(proc))
    return True, "Serveur WebRTC demarre"


async def kill_process_tree(pid: int) -> None:
    """Kill a process and everything it spawned, without a psutil dependency."""
    if sys.platform == "win32":
        cmd = ["taskkill", "/F", "/T", "/PID", str(pid)]
    else:
        cmd = ["pkill", "-KILL", "-P", str(pid)]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=NO_WINDOW,
        )
        await proc.wait()
    except (OSError, FileNotFoundError):
        pass
    if sys.platform != "win32":
        try:
            os.kill(pid, 9)
        except (ProcessLookupError, PermissionError):
            pass


async def stop_webrtc() -> tuple[bool, str]:
    global webrtc_process, webrtc_started_at
    if not webrtc_is_owned_running():
        webrtc_process = None
        webrtc_started_at = None
        return False, "Aucun serveur WebRTC lance depuis l'application"
    proc = webrtc_process
    webrtc_process = None
    webrtc_started_at = None
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        # terminate() only signals the parent. aiortc/av spawn helper processes
        # that survive it on Windows, so fall back to killing the whole tree.
        await kill_process_tree(proc.pid)
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            pass
    webrtc_append_log("--- arrete depuis le panneau de controle ---")
    return True, "Serveur WebRTC arrete"


@fastapi_app.get("/webrtc/status")
async def webrtc_status() -> JSONResponse:
    health = await webrtc_fetch("/health")
    owned = webrtc_is_owned_running()
    return JSONResponse({
        "reachable": health is not None,
        "owned": owned,
        "pid": webrtc_process.pid if owned and webrtc_process else None,
        "uptime": (time.time() - webrtc_started_at) if (owned and webrtc_started_at) else None,
        "port": WEBRTC_PORT,
        "scriptFound": WEBRTC_SCRIPT.exists(),
        "canLaunch": webrtc_python() is not None,
        "options": webrtc_options,
        "health": health,
    })


@fastapi_app.get("/webrtc/stats")
async def webrtc_stats() -> JSONResponse:
    stats = await webrtc_fetch("/debug/stats")
    if stats is None:
        return JSONResponse({"error": "Serveur WebRTC injoignable"}, status_code=503)
    return JSONResponse(stats)


@fastapi_app.get("/webrtc/logs")
async def webrtc_logs(since: int = 0) -> JSONResponse:
    first_seq = webrtc_log_seq - len(webrtc_log)
    start = max(0, min(since, webrtc_log_seq) - first_seq)
    if since < first_seq:
        start = 0
    return JSONResponse({
        "lines": list(webrtc_log)[start:],
        "next": webrtc_log_seq,
        "truncated": since < first_seq,
    })


@fastapi_app.post("/webrtc/start")
async def webrtc_start(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if isinstance(body, dict):
        for key, cast in (("videoBitrate", int), ("audioBitrate", int)):
            if key in body:
                try:
                    webrtc_options[key] = cast(body[key])
                except (TypeError, ValueError):
                    pass
        if body.get("codec") in ("auto", "h264", "vp8"):
            webrtc_options["codec"] = body["codec"]
        if isinstance(body.get("verbose"), bool):
            webrtc_options["verbose"] = body["verbose"]
    ok, message = await start_webrtc()
    return JSONResponse({"ok": ok, "message": message}, status_code=200 if ok else 409)


@fastapi_app.post("/webrtc/stop")
async def webrtc_stop() -> JSONResponse:
    ok, message = await stop_webrtc()
    return JSONResponse({"ok": ok, "message": message}, status_code=200 if ok else 409)


@fastapi_app.post("/webrtc/restart")
async def webrtc_restart(request: Request) -> JSONResponse:
    await stop_webrtc()
    await asyncio.sleep(0.6)
    return await webrtc_start(request)


# --------- API DMX control endpoints ---------

@fastapi_app.post("/api/play", dependencies=[Depends(require_api_token)])
async def api_play() -> JSONResponse:
    global is_playing
    await sio.emit("controlEvent", {"type": "play"}, room="displays")
    is_playing = True
    return JSONResponse({"ok": True})


@fastapi_app.post("/api/pause", dependencies=[Depends(require_api_token)])
async def api_pause() -> JSONResponse:
    global is_playing
    await sio.emit("controlEvent", {"type": "pause"}, room="displays")
    is_playing = False
    return JSONResponse({"ok": True})


@fastapi_app.post("/api/seek", dependencies=[Depends(require_api_token)])
async def api_seek(request: Request) -> JSONResponse:
    global master_time
    body = await request.json()
    time_value = _to_float(body.get("time") if isinstance(body, dict) else None, float("nan"))
    if time_value != time_value:  # NaN
        return JSONResponse({"error": "Invalid time"}, status_code=400)
    master_time = time_value
    await sio.emit("controlEvent", {"type": "seek", "time": time_value}, room="displays")
    return JSONResponse({"ok": True, "time": time_value})


@fastapi_app.post("/api/load-video", dependencies=[Depends(require_api_token)])
async def api_load_video(request: Request) -> JSONResponse:
    global master_time, current_video_src, current_stream_mode
    body = await request.json()
    src_input = ""
    if isinstance(body, dict):
        src_input = body.get("src") or body.get("name") or body.get("filename") or ""
    if not src_input:
        return JSONResponse({"error": "Missing src or name"}, status_code=400)
    src = str(src_input)
    if not src.startswith("/videos/"):
        if "/" in src or "\\" in src:
            return JSONResponse({"error": "Invalid video path"}, status_code=400)
        src = f"/videos/{src}"
    master_time = 0
    current_video_src = src
    current_stream_mode = "file"
    await sio.emit("controlEvent", {"type": "load", "src": src}, room="displays")
    return JSONResponse({"ok": True, "src": src})


try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    CALIBRATION_AVAILABLE = True
except ImportError:
    cv2 = None  # type: ignore
    np = None  # type: ignore
    CALIBRATION_AVAILABLE = False


# Rectified canvas resolution used during perspective warp. Detected
# coordinates are expressed in % of this canvas, which matches the 0-100% panel
# coordinate space (homography is built so the display window maps to it 1:1).
CALIB_CANVAS_SIZE = 1000

# ArUco grid: GRID_COLS x GRID_ROWS markers distributed evenly across the
# display window. Markers are deliberately LARGE and SPARSE so they stay
# detectable even when the camera is far from the panel or the panel itself
# is small. With 24 markers we can lose 80% to physical-screen gaps and still
# have 4-5 visible — well above the 4 needed for a homography.
ARUCO_GRID_COLS = 6
ARUCO_GRID_ROWS = 4
# Marker side as a fraction of the cell size. Larger fill = bigger markers =
# more reliably detected.
ARUCO_MARKER_FILL = 0.75
ARUCO_GRID_PNG_PATH = PUBLIC_DIR / "calibration-grid.png"
ARUCO_GRID_PNG_SIZE = 2400  # baked PNG resolution; display stretches to window

_aruco_dict = None
_aruco_known_positions: dict[int, tuple[float, float]] = {}


def _build_aruco_grid_image() -> None:
    """Bake the ArUco marker grid PNG into public/ and record marker positions.

    Each marker's position is stored as the centre in % of the panel (0-100).
    The canvas is WHITE so each marker's black border has the contrast required
    for cv2.aruco detection.
    """
    global _aruco_dict, _aruco_known_positions
    if not CALIBRATION_AVAILABLE:
        return
    try:
        _aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_250)
    except Exception as exc:
        print(f"[calibration] aruco init failed: {exc}", flush=True)
        return
    size = ARUCO_GRID_PNG_SIZE
    # White background so the marker's black border has contrast.
    canvas = np.full((size, size, 3), 255, dtype=np.uint8)
    cell_w = size / ARUCO_GRID_COLS
    cell_h = size / ARUCO_GRID_ROWS
    marker_pixel = int(min(cell_w, cell_h) * ARUCO_MARKER_FILL)
    if marker_pixel < 60:
        marker_pixel = 60
    _aruco_known_positions = {}
    for row in range(ARUCO_GRID_ROWS):
        for col in range(ARUCO_GRID_COLS):
            marker_id = row * ARUCO_GRID_COLS + col
            try:
                marker_img = cv2.aruco.generateImageMarker(_aruco_dict, marker_id, marker_pixel)
            except AttributeError:
                # Older OpenCV
                marker_img = cv2.aruco.drawMarker(_aruco_dict, marker_id, marker_pixel)
            cell_cx = (col + 0.5) * cell_w
            cell_cy = (row + 0.5) * cell_h
            x0 = int(cell_cx - marker_pixel / 2)
            y0 = int(cell_cy - marker_pixel / 2)
            marker_rgb = cv2.cvtColor(marker_img, cv2.COLOR_GRAY2BGR)
            canvas[y0:y0 + marker_pixel, x0:x0 + marker_pixel] = marker_rgb
            _aruco_known_positions[marker_id] = (
                cell_cx / size * 100.0,
                cell_cy / size * 100.0,
            )
    try:
        cv2.imwrite(str(ARUCO_GRID_PNG_PATH), canvas)
        print(
            f"[calibration] baked {ARUCO_GRID_COLS}x{ARUCO_GRID_ROWS} ArUco grid "
            f"({marker_pixel}px markers on {size}px canvas) to {ARUCO_GRID_PNG_PATH}",
            flush=True,
        )
    except OSError as exc:
        print(f"[calibration] failed to write aruco grid: {exc}", flush=True)


def _make_detector_params(preset: str = "default"):
    """Build ArUco DetectorParameters tuned for our typical conditions."""
    p = cv2.aruco.DetectorParameters()
    if preset == "default":
        p.adaptiveThreshWinSizeMin = 3
        p.adaptiveThreshWinSizeMax = 53
        p.adaptiveThreshWinSizeStep = 10
        p.minMarkerPerimeterRate = 0.01
        p.maxMarkerPerimeterRate = 4.0
        p.polygonalApproxAccuracyRate = 0.05
        p.errorCorrectionRate = 0.8
    elif preset == "tiny":
        # Markers are very small in the image — detect tighter contours
        p.adaptiveThreshWinSizeMin = 3
        p.adaptiveThreshWinSizeMax = 23
        p.adaptiveThreshWinSizeStep = 4
        p.minMarkerPerimeterRate = 0.005
        p.maxMarkerPerimeterRate = 4.0
        p.polygonalApproxAccuracyRate = 0.08
        p.errorCorrectionRate = 0.9
    elif preset == "blurry":
        # Camera is out of focus — relax everything
        p.adaptiveThreshWinSizeMin = 5
        p.adaptiveThreshWinSizeMax = 91
        p.adaptiveThreshWinSizeStep = 10
        p.minMarkerPerimeterRate = 0.01
        p.maxMarkerPerimeterRate = 4.0
        p.polygonalApproxAccuracyRate = 0.1
        p.errorCorrectionRate = 0.9
        p.minCornerDistanceRate = 0.02
    try:
        p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    except AttributeError:
        pass
    return p


def _detect_markers_raw(bgr_image, params):
    """Wrap detectMarkers for compatibility across OpenCV versions."""
    try:
        detector = cv2.aruco.ArucoDetector(_aruco_dict, params)
        return detector.detectMarkers(bgr_image)[:2]
    except AttributeError:
        return cv2.aruco.detectMarkers(bgr_image, _aruco_dict, parameters=params)[:2]


_build_aruco_grid_image()


# ---------------------------------------------------------------------------
# Gray code structured light
# ---------------------------------------------------------------------------
# Robust alternative to ArUco when the physical screens are too small / too
# low-resolution to decode markers. Instead of localised patterns we project
# a sequence of black/white stripe patterns whose ON/OFF state at each pixel
# encodes the pixel's display position in a Gray code. Each visible camera
# pixel — even from a tiny fragment of a screen — can recover its display
# coordinate, so the algorithm doesn't depend on whole markers being intact.

GRAY_BITS_X = 6  # 64 cells along X — smaller cells catch sub-cell LCD gaps
GRAY_BITS_Y = 6  # 64 cells along Y
GRAY_CELLS_X = 1 << GRAY_BITS_X
GRAY_CELLS_Y = 1 << GRAY_BITS_Y
GRAY_PATTERN_SIZE = 1024  # baked PNG side; display upscales pixel-perfect


def _gray_pattern_x(bit: int) -> "np.ndarray":
    width = GRAY_PATTERN_SIZE
    img = np.zeros((GRAY_PATTERN_SIZE, GRAY_PATTERN_SIZE), dtype=np.uint8)
    xs = np.arange(width)
    cells = (xs * GRAY_CELLS_X) // width
    gray_codes = cells ^ (cells >> 1)
    bits = (gray_codes >> bit) & 1
    column = (bits * 255).astype(np.uint8)
    img[:] = column[np.newaxis, :]
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def _gray_pattern_y(bit: int) -> "np.ndarray":
    img = np.zeros((GRAY_PATTERN_SIZE, GRAY_PATTERN_SIZE), dtype=np.uint8)
    ys = np.arange(GRAY_PATTERN_SIZE)
    cells = (ys * GRAY_CELLS_Y) // GRAY_PATTERN_SIZE
    gray_codes = cells ^ (cells >> 1)
    bits = (gray_codes >> bit) & 1
    row = (bits * 255).astype(np.uint8)
    img[:] = row[:, np.newaxis]
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def _build_gray_patterns() -> None:
    if not CALIBRATION_AVAILABLE:
        return
    for bit in range(GRAY_BITS_X):
        path = PUBLIC_DIR / f"calibration-gray-x-{bit}.png"
        try:
            cv2.imwrite(str(path), _gray_pattern_x(bit))
        except OSError as exc:
            print(f"[calibration] failed to write {path}: {exc}", flush=True)
    for bit in range(GRAY_BITS_Y):
        path = PUBLIC_DIR / f"calibration-gray-y-{bit}.png"
        try:
            cv2.imwrite(str(path), _gray_pattern_y(bit))
        except OSError as exc:
            print(f"[calibration] failed to write {path}: {exc}", flush=True)
    print(
        f"[calibration] baked Gray code patterns: {GRAY_BITS_X} X-bits + "
        f"{GRAY_BITS_Y} Y-bits ({GRAY_CELLS_X}x{GRAY_CELLS_Y} cells)",
        flush=True,
    )


_build_gray_patterns()


def _gray_to_binary(gray: "np.ndarray") -> "np.ndarray":
    g = gray.astype(np.int32, copy=True)
    g ^= g >> 1
    g ^= g >> 2
    g ^= g >> 4
    g ^= g >> 8
    g ^= g >> 16
    return g


def _decode_gray_axis(bit_images, white_ref_gray, black_ref_gray, valid_mask):
    threshold = (white_ref_gray + black_ref_gray) / 2.0
    code = np.zeros(white_ref_gray.shape, dtype=np.int32)
    for bit, img in enumerate(bit_images):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        on = (g > threshold).astype(np.int32)
        code |= (on << bit)
    code = _gray_to_binary(code)
    code[~valid_mask] = -1
    return code


def _calibrate_gray_code(bit_x_imgs, bit_y_imgs, white_ref, black_ref, debug_dir: Optional[Path] = None):
    if len(bit_x_imgs) != GRAY_BITS_X:
        raise ValueError(f"Need {GRAY_BITS_X} X-axis captures, got {len(bit_x_imgs)}")
    if len(bit_y_imgs) != GRAY_BITS_Y:
        raise ValueError(f"Need {GRAY_BITS_Y} Y-axis captures, got {len(bit_y_imgs)}")

    white_gray = cv2.cvtColor(white_ref, cv2.COLOR_BGR2GRAY).astype(np.float32)
    black_gray = cv2.cvtColor(black_ref, cv2.COLOR_BGR2GRAY).astype(np.float32)
    contrast = white_gray - black_gray
    # Use Otsu's method to auto-pick the threshold that separates the LCDs
    # (high contrast) from ambient illumination (low contrast caused by
    # in-scene reflections, e.g., Minecraft block textures lit by the LCDs).
    # Floor at 25 so dim displays (e.g., screens with dark calibration
    # rendering due to in-game shading) still get picked up.
    contrast_u8 = np.clip(contrast, 0, 255).astype(np.uint8)
    otsu_thresh, _ = cv2.threshold(contrast_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contrast_threshold = max(25.0, float(otsu_thresh))
    valid_mask = contrast > contrast_threshold
    n_valid = int(valid_mask.sum())

    # Debug: save the valid mask + contrast heatmap so the operator can SEE
    # which camera pixels are being considered.
    if debug_dir is not None:
        _save_debug_image(debug_dir, "_valid_mask.png", (valid_mask.astype(np.uint8) * 255))
        contrast_vis = np.clip(contrast, 0, 255).astype(np.uint8)
        contrast_color = cv2.applyColorMap(contrast_vis, cv2.COLORMAP_JET)
        _save_debug_image(debug_dir, "_contrast.png", contrast_color)

    if n_valid < 200:
        raise ValueError(
            f"Only {n_valid} bright pixels detected. The display likely "
            "isn't showing the calibration patterns, or the camera is "
            "framing too little of the panel."
        )

    cell_x = _decode_gray_axis(bit_x_imgs, white_gray, black_gray, valid_mask)
    cell_y = _decode_gray_axis(bit_y_imgs, white_gray, black_gray, valid_mask)

    # Spatial denoising: per-pixel decoding can be flaky at stripe boundaries
    # and at low-contrast pixels (e.g., inside a Minecraft texture rendering
    # the pattern at a low resolution). A 5x5 median filter forces each pixel
    # to take the most common decoded value of its neighbourhood, which kills
    # speckle noise while preserving the boundaries between LCD regions.
    cell_x_u16 = cell_x.astype(np.uint16)
    cell_y_u16 = cell_y.astype(np.uint16)
    cell_x_smoothed = cv2.medianBlur(cell_x_u16, 5).astype(np.int32)
    cell_y_smoothed = cv2.medianBlur(cell_y_u16, 5).astype(np.int32)
    cell_x = np.where(valid_mask, cell_x_smoothed, cell_x)
    cell_y = np.where(valid_mask, cell_y_smoothed, cell_y)

    if debug_dir is not None:
        # Visualise the decoded cell coordinates as colour-coded heatmaps
        cx_vis = np.where(valid_mask, (cell_x * 255 // max(1, GRAY_CELLS_X - 1)).clip(0, 255), 0).astype(np.uint8)
        cy_vis = np.where(valid_mask, (cell_y * 255 // max(1, GRAY_CELLS_Y - 1)).clip(0, 255), 0).astype(np.uint8)
        _save_debug_image(debug_dir, "_decoded_x.png", cv2.applyColorMap(cx_vis, cv2.COLORMAP_HSV))
        _save_debug_image(debug_dir, "_decoded_y.png", cv2.applyColorMap(cy_vis, cv2.COLORMAP_HSV))

    occupancy = np.zeros((GRAY_CELLS_Y, GRAY_CELLS_X), dtype=np.uint32)
    valid_x = cell_x[valid_mask]
    valid_y = cell_y[valid_mask]
    in_range = (
        (valid_x >= 0) & (valid_x < GRAY_CELLS_X)
        & (valid_y >= 0) & (valid_y < GRAY_CELLS_Y)
    )
    if int(in_range.sum()) < 50:
        raise ValueError(
            "Gray code decode produced no valid cells. Patterns may be "
            "flickering or the camera is moving during capture."
        )
    np.add.at(occupancy, (valid_y[in_range], valid_x[in_range]), 1)

    # ------------------------------------------------------------------
    # HYBRID ARCHITECTURE — camera-CC primary, with proper shape detection
    # from the camera contour and dedup of panel-bbox duplicates.
    #
    # The cell-cluster-first approach merged adjacent LCDs that showed
    # contiguous panel regions; the camera-CC approach gives finer-grained
    # detection of each physical LCD (matches _cc_labels.png). For each
    # physical LCD we:
    #   1. Detect its shape from the camera contour (triangle / polygon /
    #      circle / rect, with fill_ratio guard against false-rect).
    #   2. Look up which panel cells its pixels decoded to → bbox in
    #      cell space gives the sub-screen's panel rectangle.
    #   3. Dedup at the end by panel-bbox IoU (multiple physical LCDs
    #      showing the SAME panel region — mirrors — produce one sub).
    # ------------------------------------------------------------------

    bright_mask_u8 = (valid_mask.astype(np.uint8)) * 255
    n_components, labels, stats, _ = cv2.connectedComponentsWithStats(
        bright_mask_u8, connectivity=4
    )
    h, w = valid_mask.shape
    component_min_pixels = max(30, int(h * w * 0.00015))

    if debug_dir is not None and n_components > 1:
        color_map = np.random.randint(50, 255, size=(n_components, 3), dtype=np.uint8)
        color_map[0] = (0, 0, 0)
        _save_debug_image(debug_dir, "_cc_labels.png", color_map[labels])

    sub_screens: list[dict[str, Any]] = []
    contour_vis = (white_ref * 0.4).astype(np.uint8) if debug_dir is not None else None
    next_id = 1

    for comp_idx in range(1, n_components):
        comp_pixels = int(stats[comp_idx, cv2.CC_STAT_AREA])
        if comp_pixels < component_min_pixels:
            continue
        comp_mask = labels == comp_idx
        cx_vals = cell_x[comp_mask]
        cy_vals = cell_y[comp_mask]
        good = (cx_vals >= 0) & (cx_vals < GRAY_CELLS_X) & (cy_vals >= 0) & (cy_vals < GRAY_CELLS_Y)
        cx_good = cx_vals[good]
        cy_good = cy_vals[good]
        if cx_good.size < max(20, int(comp_pixels * 0.3)):
            _append_debug_log(debug_dir, f"CC#{comp_idx}: skipped (too_few_decoded={cx_good.size})")
            continue

        # ---- Camera-space shape detection ----
        cam_mask_u8 = comp_mask.astype(np.uint8) * 255
        cam_mask_clean = cv2.morphologyEx(
            cam_mask_u8, cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
            iterations=1,
        )
        cam_contours, _ = cv2.findContours(cam_mask_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        shape = "rect"
        points: list[list[float]] = []
        raw_shape_dbg = "n/a"
        approx_pts_dbg = 0
        fill_ratio_dbg = 0.0
        if cam_contours:
            cam_contour = max(cam_contours, key=cv2.contourArea)
            cam_area = cv2.contourArea(cam_contour)
            cam_perim = cv2.arcLength(cam_contour, True)
            cam_eps = max(2.0, 0.012 * cam_perim)
            cam_approx = cv2.approxPolyDP(cam_contour, cam_eps, True)
            raw_shape, _ = _classify_contour(cam_approx, cam_area)
            raw_shape_dbg = raw_shape
            approx_pts_dbg = int(len(cam_approx))
            cx_bb, cy_bb, cw_bb, ch_bb = cv2.boundingRect(cam_contour)
            bbox_area = max(1.0, float(cw_bb * ch_bb))
            fill_ratio_dbg = float(cam_area) / bbox_area
            if cw_bb > 0 and ch_bb > 0:
                pts = cam_approx.reshape(-1, 2)
                pts_pct = [
                    [(float(px) - cx_bb) / cw_bb * 100.0,
                     (float(py) - cy_bb) / ch_bb * 100.0]
                    for px, py in pts
                ]
                if raw_shape == "circle":
                    shape = "circle"
                elif raw_shape == "rect" and len(pts_pct) == 4 and fill_ratio_dbg > 0.85:
                    shape = "rect"
                else:
                    shape = "polygon"
                    points = pts_pct
            # Draw on debug overlay
            if contour_vis is not None:
                cv2.drawContours(contour_vis, [cam_contour], -1, (0, 200, 0), 2)
                for i_v, (vp,) in enumerate(cam_approx):
                    vx, vy = int(vp[0]), int(vp[1])
                    cv2.circle(contour_vis, (vx, vy), 4, (0, 255, 255), -1)
                cx_lbl, cy_lbl, _, _ = cv2.boundingRect(cam_contour)
                cv2.putText(
                    contour_vis, f"#{comp_idx} {shape} v={approx_pts_dbg}",
                    (cx_lbl, max(15, cy_lbl - 5)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1,
                )

        # ---- Panel bbox from decoded cells (5-95 percentile drops outliers) ----
        x_min = int(np.percentile(cx_good, 5))
        x_max = int(np.percentile(cx_good, 95))
        y_min = int(np.percentile(cy_good, 5))
        y_max = int(np.percentile(cy_good, 95))
        if x_max <= x_min or y_max <= y_min:
            _append_debug_log(debug_dir, f"CC#{comp_idx}: skipped (degenerate cell bbox)")
            continue
        sw_cells = x_max - x_min + 1
        sh_cells = y_max - y_min + 1
        if sw_cells < 2 or sh_cells < 2:
            _append_debug_log(debug_dir, f"CC#{comp_idx}: skipped (cell bbox too small: {sw_cells}x{sh_cells})")
            continue

        x_pct = x_min / GRAY_CELLS_X * 100.0
        y_pct = y_min / GRAY_CELLS_Y * 100.0
        w_pct = sw_cells / GRAY_CELLS_X * 100.0
        h_pct = sh_cells / GRAY_CELLS_Y * 100.0

        _append_debug_log(debug_dir, (
            f"CC#{comp_idx}: cam_pixels={comp_pixels} decoded={cx_good.size} "
            f"approx_pts={approx_pts_dbg} raw_shape={raw_shape_dbg} fill={fill_ratio_dbg:.3f} "
            f"-> shape={shape} pts={len(points)} "
            f"panel_bbox=({x_pct:.2f},{y_pct:.2f}) {w_pct:.2f}x{h_pct:.2f}"
        ))

        sub_screens.append({
            "id": next_id,
            "shape": shape,
            "x": x_pct,
            "y": y_pct,
            "width": w_pct,
            "height": h_pct,
            "color": {"r": 255, "g": 255, "b": 255},
            "dimmer": 255,
            "points": points,
            "dmxAddress": None,
        })
        next_id += 1

    if contour_vis is not None:
        _save_debug_image(debug_dir, "_cam_contours.png", contour_vis)

    # Dedup mirrors: multiple physical LCDs showing the same panel region.
    sub_screens = _dedupe_sub_screens(sub_screens)

    if debug_dir is not None:
        try:
            (debug_dir / "_summary.json").write_text(
                json.dumps({
                    "method": "gray-code-camera-cc",
                    "bright_pixels": n_valid,
                    "cells_x": GRAY_CELLS_X,
                    "cells_y": GRAY_CELLS_Y,
                    "n_camera_ccs": int(n_components - 1),
                    "sub_screens_count": len(sub_screens),
                    "sub_screens": sub_screens,
                }, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    return sub_screens, n_valid


def _bbox_iou(a: dict, b: dict) -> float:
    """Intersection-over-union of two sub-screen bboxes (in % space)."""
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def _bbox_contains(outer: dict, inner: dict, tolerance: float = 1.0) -> bool:
    """True if `outer` bbox contains `inner` (with a % tolerance margin)."""
    return (
        outer["x"] - tolerance <= inner["x"]
        and outer["y"] - tolerance <= inner["y"]
        and outer["x"] + outer["width"] + tolerance >= inner["x"] + inner["width"]
        and outer["y"] + outer["height"] + tolerance >= inner["y"] + inner["height"]
    )


def _dedupe_sub_screens(subs: list, iou_threshold: float = 0.5) -> list:
    """Drop near-duplicate bboxes (high IoU = same physical panel region) and
    also drop "container" sub-screens that wholly enclose 3+ smaller ones
    (these are usually a single huge over-merged misdetection)."""
    if not subs:
        return subs
    # Sort by area ASC so smaller (more specific) bboxes are kept first;
    # larger bboxes that are essentially supersets of those get dropped.
    sorted_subs = sorted(subs, key=lambda s: s["width"] * s["height"])
    kept: list = []
    for sub in sorted_subs:
        is_dup = False
        for k in kept:
            if _bbox_iou(sub, k) > iou_threshold:
                is_dup = True
                break
        if not is_dup:
            kept.append(sub)
    # Second pass: drop suspicious "container" sub-screens. A sub-screen that
    # significantly overlaps with two or more smaller ones is almost certainly
    # an over-merged misdetection — the smaller ones are the real LCDs.
    final: list = []
    for sub in kept:
        sub_area = sub["width"] * sub["height"]
        # Only consider sub-screens that are reasonably large (cheap to skip)
        if sub_area >= 8.0:
            overlapping_smaller = 0
            for other in kept:
                if other is sub:
                    continue
                other_area = other["width"] * other["height"]
                if other_area >= sub_area * 0.7:
                    continue
                # Either contained or substantially overlapping
                if _bbox_contains(sub, other, tolerance=1.5) or _bbox_iou(sub, other) > 0.25:
                    overlapping_smaller += 1
            if overlapping_smaller >= 2:
                continue
        final.append(sub)
    # Renumber IDs starting from 1
    for i, s in enumerate(final, start=1):
        s["id"] = i
    return final


def _classify_contour(approx, area):
    """Pick a sub-screen shape from a simplified contour."""
    vertices = len(approx)
    # Circularity test (4*pi*area / perimeter^2 → 1.0 for perfect circle)
    perimeter = cv2.arcLength(approx, True)
    if perimeter <= 0:
        return "polygon", approx
    circularity = (4 * 3.141592653589793 * area) / (perimeter * perimeter)
    if circularity > 0.82 and vertices >= 6:
        return "circle", approx
    if vertices == 3:
        return "triangle", approx
    if vertices == 4:
        # Rect if angles look ~90° (we accept any quad as rect for simplicity;
        # tilted rects in the rectified view are unlikely).
        return "rect", approx
    return "polygon", approx


def _contour_to_subscreen(contour, sub_id, canvas_size):
    x, y, w, h = cv2.boundingRect(contour)
    if w <= 0 or h <= 0:
        return None
    epsilon = 0.02 * cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    area = cv2.contourArea(contour)
    shape, pts = _classify_contour(approx, area)
    sub = {
        "id": sub_id,
        "shape": shape,
        "x": float(x) / canvas_size * 100.0,
        "y": float(y) / canvas_size * 100.0,
        "width": float(w) / canvas_size * 100.0,
        "height": float(h) / canvas_size * 100.0,
        "color": {"r": 255, "g": 255, "b": 255},
        "dimmer": 255,
        "points": [],
        "dmxAddress": None,
    }
    if shape == "polygon":
        # Express polygon points as % of the sub-screen's bounding box.
        pts_flat = pts.reshape(-1, 2)
        points = []
        for px, py in pts_flat:
            rx = (float(px) - x) / float(w) * 100.0 if w > 0 else 0.0
            ry = (float(py) - y) / float(h) * 100.0 if h > 0 else 0.0
            points.append([rx, ry])
        sub["points"] = points
    return sub


async def _decode_form_image(file_field) -> Optional["np.ndarray"]:
    if file_field is None or not hasattr(file_field, "read"):
        return None
    raw = await file_field.read()
    if not raw:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _new_debug_session_dir() -> Path:
    """Create a timestamped folder under CALIB_DEBUG_DIR for this run."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    candidate = CALIB_DEBUG_DIR / stamp
    i = 0
    while candidate.exists():
        i += 1
        candidate = CALIB_DEBUG_DIR / f"{stamp}-{i}"
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate


def _save_debug_image(folder: Path, name: str, image) -> None:
    try:
        cv2.imwrite(str(folder / name), image)
    except Exception as exc:
        print(f"[calibration] debug save failed for {name}: {exc}", flush=True)


def _save_debug_raw(folder: Path, name: str, raw_bytes: bytes) -> None:
    try:
        (folder / name).write_bytes(raw_bytes)
    except OSError as exc:
        print(f"[calibration] debug raw save failed for {name}: {exc}", flush=True)


def _append_debug_log(folder: Optional[Path], message: str) -> None:
    """Append a line to the session debug log (also echo to stdout)."""
    line = f"[calib] {message}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # Fallback for Windows consoles stuck on cp1252.
        try:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:
            pass
    if folder is None:
        return
    try:
        with (folder / "_shape_log.txt").open("a", encoding="utf-8") as f:
            f.write(message + "\n")
    except OSError:
        pass


def _write_debug_index(folder: Path, meta: dict[str, Any]) -> None:
    """Generate an index.html that shows every saved image in the session."""
    try:
        files = sorted(folder.iterdir())
    except OSError:
        return
    sections = {"Captures": [], "Pipeline": [], "Other": []}
    for f in files:
        if f.name == "index.html":
            continue
        if not f.is_file():
            continue
        suffix = f.suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg"}:
            continue
        if f.name.startswith("_"):
            sections["Pipeline"].append(f.name)
        elif f.name.startswith("gray_") or f.name in {"white.jpg", "black.jpg", "aruco.jpg"} or f.name.endswith(".jpg"):
            sections["Captures"].append(f.name)
        else:
            sections["Other"].append(f.name)

    def img_block(name: str) -> str:
        return f"""
        <figure>
          <img src="{name}" loading="lazy" />
          <figcaption>{name}</figcaption>
        </figure>
        """

    body_parts = [
        '<!doctype html><html><head><meta charset="utf-8">',
        f"<title>Calibration debug — {folder.name}</title>",
        "<style>",
        "body{margin:0;padding:24px;background:#05060a;color:#e5e7eb;",
        "font-family:Segoe UI,system-ui,sans-serif}",
        "h1{font-size:18px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px}",
        "h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;",
        "margin:24px 0 12px;border-bottom:1px solid rgba(148,163,184,.25);padding-bottom:6px}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}",
        "figure{margin:0;background:#0e1424;border:1px solid rgba(148,163,184,.25);",
        "border-radius:10px;overflow:hidden}",
        "figure img{display:block;width:100%;height:auto;background:#000}",
        "figcaption{padding:6px 10px;font:11px ui-monospace,Consolas,monospace;",
        "color:#94a3b8}",
        "pre{background:#0e1424;padding:12px;border-radius:10px;font-size:11px;",
        "color:#bbf7d0;overflow:auto;border:1px solid rgba(148,163,184,.25)}",
        "</style></head><body>",
        f"<h1>Calibration debug — {folder.name}</h1>",
    ]
    if meta:
        body_parts.append("<pre>")
        body_parts.append(json.dumps(meta, indent=2))
        body_parts.append("</pre>")
    for title, items in sections.items():
        if not items:
            continue
        body_parts.append(f"<h2>{title}</h2><div class='grid'>")
        for name in items:
            body_parts.append(img_block(name))
        body_parts.append("</div>")
    body_parts.append("</body></html>")
    try:
        (folder / "index.html").write_text("".join(body_parts), encoding="utf-8")
    except OSError as exc:
        print(f"[calibration] index.html write failed: {exc}", flush=True)


def _detect_aruco_homography(bgr_image):
    """Detect ArUco markers in a camera frame and build a homography from
    image pixels → warped panel canvas (CALIB_CANVAS_SIZE square).

    Tries multiple detection passes (default params, CLAHE-enhanced contrast,
    downscaled image, blurry preset) and accumulates a UNION of detected
    markers across passes — so a marker that's only visible in one pass still
    contributes to the homography.

    Returns (matrix, n_detected) or raises ValueError if too few markers found.
    """
    if _aruco_dict is None or not _aruco_known_positions:
        raise ValueError("ArUco grid not initialised on server")

    h, w = bgr_image.shape[:2]
    # accumulated: marker_id -> centroid in image pixel space
    accumulated: dict[int, tuple[float, float]] = {}

    def merge(corners_arr, ids_arr, scale: float = 1.0):
        if ids_arr is None:
            return 0
        added = 0
        for marker_corners, marker_id_arr in zip(corners_arr, ids_arr):
            mid = int(marker_id_arr[0])
            if mid not in _aruco_known_positions:
                continue
            if mid in accumulated:
                continue
            pts = marker_corners.reshape(-1, 2)
            cx = float(pts[:, 0].mean()) * scale
            cy = float(pts[:, 1].mean()) * scale
            accumulated[mid] = (cx, cy)
            added += 1
        return added

    # Pass 1 — default params on the raw image
    corners, ids = _detect_markers_raw(bgr_image, _make_detector_params("default"))
    merge(corners, ids)

    if len(accumulated) < 4:
        # Pass 2 — CLAHE-enhanced contrast (helps low-light / washed-out frames)
        gray = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        enhanced_bgr = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
        corners, ids = _detect_markers_raw(enhanced_bgr, _make_detector_params("default"))
        merge(corners, ids)

    if len(accumulated) < 4 and min(h, w) >= 800:
        # Pass 3 — downscale ½ (helps when markers are very sharp/small)
        small = cv2.resize(bgr_image, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
        corners, ids = _detect_markers_raw(small, _make_detector_params("tiny"))
        merge(corners, ids, scale=2.0)

    if len(accumulated) < 4:
        # Pass 4 — blurry / loose params on original
        corners, ids = _detect_markers_raw(bgr_image, _make_detector_params("blurry"))
        merge(corners, ids)

    n = len(accumulated)
    if n == 0:
        raise ValueError(
            "No ArUco markers found. Make sure the panel fills the camera "
            "frame, the grid is in focus, and the calibration pattern is "
            "actually showing on the display."
        )
    if n < 4:
        raise ValueError(
            f"Only {n} ArUco marker(s) detected — need at least 4. "
            "Try moving the camera closer to the panel, improving focus, "
            "or making sure enough physical screens are visible to the camera."
        )

    src_points = []
    dst_points = []
    for mid, (cx, cy) in accumulated.items():
        known = _aruco_known_positions[mid]
        src_points.append([cx, cy])
        dst_points.append([
            known[0] / 100.0 * (CALIB_CANVAS_SIZE - 1),
            known[1] / 100.0 * (CALIB_CANVAS_SIZE - 1),
        ])
    src = np.array(src_points, dtype=np.float32)
    dst = np.array(dst_points, dtype=np.float32)
    matrix, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if matrix is None:
        raise ValueError("Homography computation failed despite detected markers")
    return matrix, n


def _sample_warped_color(warped_bgr, sub: dict[str, Any]) -> tuple[int, int, int]:
    """Mean BGR colour inside the sub-screen's bounding box on a warped frame.

    Used to verify the sub-screen actually lit up in red/green/blue patterns.
    """
    h, w = warped_bgr.shape[:2]
    x = int(round(sub["x"] / 100.0 * w))
    y = int(round(sub["y"] / 100.0 * h))
    ww = max(1, int(round(sub["width"] / 100.0 * w)))
    hh = max(1, int(round(sub["height"] / 100.0 * h)))
    x = max(0, min(w - 1, x))
    y = max(0, min(h - 1, y))
    x2 = max(x + 1, min(w, x + ww))
    y2 = max(y + 1, min(h, y + hh))
    patch = warped_bgr[y:y2, x:x2]
    if patch.size == 0:
        return (0, 0, 0)
    mean = patch.reshape(-1, 3).mean(axis=0)
    return (int(mean[0]), int(mean[1]), int(mean[2]))


@fastapi_app.post("/api/calibrate")
async def api_calibrate(request: Request) -> JSONResponse:
    """Auto-calibration entry point.

    Two methods, tried in order:
      1) Gray code structured light (PREFERRED, more robust): the client
         provides captures of N X-axis stripe patterns + N Y-axis stripe
         patterns + a black reference + a white reference. Each visible
         camera pixel decodes its display cell — works even for tiny
         in-engine displays (Minecraft, etc.) where ArUco markers are
         too low-resolution to decode.
      2) ArUco grid (FALLBACK, faster but needs decodable markers): single
         photo of the display showing the ArUco grid pattern.

    The endpoint auto-detects which method based on uploaded fields:
        - If `gray_x_0..N` + `gray_y_0..N` + `black` + `white` are present
          → Gray code path.
        - Else if `aruco` + `white` are present → ArUco path.

    Optional `red`/`green`/`blue` fields validate per-channel lighting.

    Returns: { ok, subScreens, count, method, warnings }
    """
    if not CALIBRATION_AVAILABLE:
        return JSONResponse(
            {"error": "OpenCV / numpy not installed on this server build"},
            status_code=501,
        )
    form = await request.form()

    # ---- Gray code path detection ----
    has_gray = (
        form.get(f"gray_x_{GRAY_BITS_X - 1}") is not None
        and form.get(f"gray_y_{GRAY_BITS_Y - 1}") is not None
        and form.get("black") is not None
        and form.get("white") is not None
    )

    if has_gray:
        debug_dir = _new_debug_session_dir()
        debug_url = f"/debug/calibration/{debug_dir.name}/"
        meta: dict[str, Any] = {"method": "gray-code", "status": "pending"}
        response: Optional[JSONResponse] = None
        try:
            async def grab_and_save(field_name: str):
                field = form.get(field_name)
                if field is None or not hasattr(field, "read"):
                    return None
                raw = await field.read()
                if not raw:
                    return None
                _save_debug_raw(debug_dir, f"{field_name}.jpg", raw)
                arr = np.frombuffer(raw, dtype=np.uint8)
                return cv2.imdecode(arr, cv2.IMREAD_COLOR)

            bit_x_imgs = []
            for bit in range(GRAY_BITS_X):
                img = await grab_and_save(f"gray_x_{bit}")
                if img is None:
                    meta.update({"status": "error", "error": f"Missing gray_x_{bit}"})
                    response = JSONResponse(
                        {"error": f"Missing gray_x_{bit}", "debugUrl": debug_url},
                        status_code=400,
                    )
                    return response
                bit_x_imgs.append(img)
            bit_y_imgs = []
            for bit in range(GRAY_BITS_Y):
                img = await grab_and_save(f"gray_y_{bit}")
                if img is None:
                    meta.update({"status": "error", "error": f"Missing gray_y_{bit}"})
                    response = JSONResponse(
                        {"error": f"Missing gray_y_{bit}", "debugUrl": debug_url},
                        status_code=400,
                    )
                    return response
                bit_y_imgs.append(img)
            white_ref = await grab_and_save("white")
            black_ref = await grab_and_save("black")
            if white_ref is None or black_ref is None:
                meta.update({"status": "error", "error": "Missing white/black reference"})
                response = JSONResponse(
                    {"error": "Missing white/black reference", "debugUrl": debug_url},
                    status_code=400,
                )
                return response
            try:
                sub_screens, n_valid = _calibrate_gray_code(
                    bit_x_imgs, bit_y_imgs, white_ref, black_ref, debug_dir=debug_dir
                )
            except ValueError as exc:
                meta.update({"status": "error", "error": str(exc)})
                response = JSONResponse(
                    {"error": str(exc), "debugUrl": debug_url}, status_code=422
                )
                return response
            except Exception as exc:
                meta.update({"status": "error", "error": f"crashed: {exc}"})
                response = JSONResponse(
                    {"error": f"calibration crashed: {exc}", "debugUrl": debug_url},
                    status_code=500,
                )
                return response

            meta.update({
                "status": "ok",
                "bright_pixels": n_valid,
                "sub_screens_count": len(sub_screens),
                "sub_screens": sub_screens,
            })
            response = JSONResponse(
                {
                    "ok": True,
                    "method": "gray-code",
                    "subScreens": sub_screens,
                    "count": len(sub_screens),
                    "brightPixels": n_valid,
                    "warnings": [],
                    "debugUrl": debug_url,
                }
            )
            return response
        finally:
            _write_debug_index(debug_dir, meta)

    # ---- ArUco fallback path ----
    debug_dir = _new_debug_session_dir()
    debug_url = f"/debug/calibration/{debug_dir.name}/"
    aruco_meta: dict[str, Any] = {"method": "aruco", "status": "pending"}

    async def grab_and_save_aruco(field_name: str):
        field = form.get(field_name)
        if field is None or not hasattr(field, "read"):
            return None
        raw = await field.read()
        if not raw:
            return None
        _save_debug_raw(debug_dir, f"{field_name}.jpg", raw)
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)

    aruco_img = await grab_and_save_aruco("aruco")
    white_img = await grab_and_save_aruco("white")
    if aruco_img is None:
        aruco_meta.update({"status": "error", "error": "missing aruco image"})
        _write_debug_index(debug_dir, aruco_meta)
        return JSONResponse({"error": "Missing or invalid 'aruco' image", "debugUrl": debug_url}, status_code=400)
    if white_img is None:
        aruco_meta.update({"status": "error", "error": "missing white image"})
        _write_debug_index(debug_dir, aruco_meta)
        return JSONResponse({"error": "Missing or invalid 'white' image", "debugUrl": debug_url}, status_code=400)
    red_img = await grab_and_save_aruco("red")
    green_img = await grab_and_save_aruco("green")
    blue_img = await grab_and_save_aruco("blue")

    try:
        matrix, markers_detected = _detect_aruco_homography(aruco_img)
    except ValueError as exc:
        aruco_meta.update({"status": "error", "error": str(exc)})
        _write_debug_index(debug_dir, aruco_meta)
        return JSONResponse({"error": str(exc), "debugUrl": debug_url}, status_code=422)

    warped_white = cv2.warpPerspective(
        white_img, matrix, (CALIB_CANVAS_SIZE, CALIB_CANVAS_SIZE)
    )

    gray = cv2.cvtColor(warped_white, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    canvas_area = CALIB_CANVAS_SIZE * CALIB_CANVAS_SIZE
    min_area = canvas_area * 0.002

    raw_subs = []
    next_id = 1
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        sub = _contour_to_subscreen(c, next_id, CALIB_CANVAS_SIZE)
        if sub is not None:
            raw_subs.append(sub)
            next_id += 1

    # Validate sub-screens against R/G/B frames if available — mean colour in
    # the warped patch should be dominated by the projected channel.
    warnings_list: list[str] = []
    warped_color_frames: dict[str, "np.ndarray"] = {}
    for label, src in (("red", red_img), ("green", green_img), ("blue", blue_img)):
        if src is None:
            continue
        warped_color_frames[label] = cv2.warpPerspective(
            src, matrix, (CALIB_CANVAS_SIZE, CALIB_CANVAS_SIZE)
        )

    for sub in raw_subs:
        channel_results = {}
        for label, warped in warped_color_frames.items():
            b, g, r = _sample_warped_color(warped, sub)
            channel_results[label] = (b, g, r)
            if label == "red" and r < g + 20 and r < b + 20:
                warnings_list.append(f"sub-screen #{sub['id']} did not light up red")
            elif label == "green" and g < r + 20 and g < b + 20:
                warnings_list.append(f"sub-screen #{sub['id']} did not light up green")
            elif label == "blue" and b < r + 20 and b < g + 20:
                warnings_list.append(f"sub-screen #{sub['id']} did not light up blue")
        sub["validation"] = channel_results

    # Homography already maps directly into the full 0-100% panel space — no
    # extra rescaling needed (each ArUco marker's known position is in panel %).
    sub_screens = raw_subs

    aruco_meta.update({
        "status": "ok",
        "markers_detected": markers_detected,
        "sub_screens_count": len(sub_screens),
        "sub_screens": sub_screens,
        "warnings": warnings_list,
    })
    _write_debug_index(debug_dir, aruco_meta)
    return JSONResponse(
        {
            "ok": True,
            "method": "aruco",
            "subScreens": sub_screens,
            "count": len(sub_screens),
            "markersDetected": markers_detected,
            "warnings": warnings_list,
            "debugUrl": debug_url,
        }
    )


@fastapi_app.post("/api/calibrate/verify")
async def api_calibrate_verify(request: Request) -> JSONResponse:
    """Verification pass: confirm each detected sub-screen is truly ONE
    physical screen by projecting a unique colour into each and seeing if
    that colour appears as a single connected component in the camera.

    Multipart fields:
        - frame  (image, REQUIRED): camera capture with each sub-screen lit
          in its assigned colour (the display renders this).
        - session_id (form field, REQUIRED): timestamp of the original
          calibration debug folder; used to load the cached cell maps.
        - sub_screens (JSON string, REQUIRED): list of
          [{x, y, width, height, color: {r,g,b}, id}].

    Returns: { ok, refined: [...], split_count, debugUrl }
    """
    if not CALIBRATION_AVAILABLE:
        return JSONResponse(
            {"error": "OpenCV / numpy not installed"}, status_code=501
        )
    form = await request.form()
    session_id = form.get("session_id")
    sub_screens_raw = form.get("sub_screens")
    frame_field = form.get("frame")
    if not isinstance(session_id, str) or not session_id:
        return JSONResponse({"error": "Missing session_id"}, status_code=400)
    if not isinstance(sub_screens_raw, str):
        return JSONResponse({"error": "Missing sub_screens JSON"}, status_code=400)
    if frame_field is None or not hasattr(frame_field, "read"):
        return JSONResponse({"error": "Missing frame image"}, status_code=400)
    try:
        sub_screens_in = json.loads(sub_screens_raw)
        assert isinstance(sub_screens_in, list)
    except Exception:
        return JSONResponse({"error": "Invalid sub_screens JSON"}, status_code=400)

    session_dir = CALIB_DEBUG_DIR / session_id
    cell_x_path = session_dir / "_cell_x.npy"
    cell_y_path = session_dir / "_cell_y.npy"
    valid_mask_path = session_dir / "_valid_mask.npy"
    if not (cell_x_path.exists() and cell_y_path.exists() and valid_mask_path.exists()):
        return JSONResponse(
            {"error": f"Cached cell maps not found for session '{session_id}'. Run /api/calibrate first."},
            status_code=404,
        )
    try:
        cell_x = np.load(str(cell_x_path))
        cell_y = np.load(str(cell_y_path))
        valid_mask = np.load(str(valid_mask_path))
    except Exception as exc:
        return JSONResponse({"error": f"Failed to load cached cells: {exc}"}, status_code=500)

    raw = await frame_field.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return JSONResponse({"error": "Could not decode frame"}, status_code=400)
    if frame.shape[:2] != cell_x.shape:
        # Resize the verification frame to match the original calibration
        # resolution so cell lookups align.
        frame = cv2.resize(frame, (cell_x.shape[1], cell_x.shape[0]))

    # Save the verification capture into the same debug folder.
    _save_debug_image(session_dir, "_verify_capture.png", frame)
    _save_debug_raw(session_dir, "verify.jpg", raw)

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    refined: list[dict[str, Any]] = []
    split_count = 0
    verify_summary: list[dict[str, Any]] = []
    next_id = 1
    cc_overlay = frame.copy()

    for sub in sub_screens_in:
        if not isinstance(sub, dict):
            continue
        color = sub.get("color") or {}
        r = int(color.get("r", 255))
        g = int(color.get("g", 255))
        b = int(color.get("b", 255))
        # Convert expected RGB to expected HSV hue
        expected_bgr = np.uint8([[[b, g, r]]])
        expected_hsv = cv2.cvtColor(expected_bgr, cv2.COLOR_BGR2HSV)[0, 0]
        expected_hue = int(expected_hsv[0])
        # Hue tolerance (OpenCV hue is 0-179)
        HUE_TOL = 12
        SAT_MIN = 80
        VAL_MIN = 60

        # Hue diff handles wrap-around at 0/179
        hue_diff = np.abs(hsv[:, :, 0].astype(np.int16) - expected_hue)
        hue_diff = np.minimum(hue_diff, 180 - hue_diff)
        mask = (
            (hue_diff <= HUE_TOL)
            & (hsv[:, :, 1] >= SAT_MIN)
            & (hsv[:, :, 2] >= VAL_MIN)
        ).astype(np.uint8) * 255

        # Cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        h_frame, w_frame = mask.shape
        min_cc_pixels = max(200, int(h_frame * w_frame * 0.001))  # ~0.1% of frame
        big_components = [
            i for i in range(1, n_comp)
            if stats[i, cv2.CC_STAT_AREA] >= min_cc_pixels
        ]

        verify_summary.append({
            "input_id": sub.get("id"),
            "expected_hue": expected_hue,
            "components_total": int(n_comp - 1),
            "components_used": len(big_components),
        })

        if not big_components:
            # Could not find this colour at all — keep the original sub as-is.
            refined.append({
                **sub,
                "id": next_id,
                "color": {"r": 255, "g": 255, "b": 255},
                "dimmer": 255,
            })
            next_id += 1
            continue

        if len(big_components) > 1:
            split_count += 1

        for comp_idx in big_components:
            comp_mask = labels == comp_idx
            cx_vals = cell_x[comp_mask]
            cy_vals = cell_y[comp_mask]
            good = (cx_vals >= 0) & (cx_vals < GRAY_CELLS_X) & (cy_vals >= 0) & (cy_vals < GRAY_CELLS_Y)
            cx_good = cx_vals[good]
            cy_good = cy_vals[good]
            if cx_good.size < 30:
                continue
            x_min = int(np.percentile(cx_good, 5))
            x_max = int(np.percentile(cx_good, 95))
            y_min = int(np.percentile(cy_good, 5))
            y_max = int(np.percentile(cy_good, 95))
            if x_max <= x_min or y_max <= y_min:
                continue
            # Reject tiny refinement candidates and pathological aspect ratios
            cell_w = x_max - x_min + 1
            cell_h = y_max - y_min + 1
            if cell_w < 2 or cell_h < 2 or cell_w * cell_h < 6:
                continue
            ratio = max(cell_w, cell_h) / max(1, min(cell_w, cell_h))
            if ratio > 10:
                continue
            refined.append({
                "id": next_id,
                "shape": "rect",
                "x": x_min / GRAY_CELLS_X * 100.0,
                "y": y_min / GRAY_CELLS_Y * 100.0,
                "width": (x_max - x_min + 1) / GRAY_CELLS_X * 100.0,
                "height": (y_max - y_min + 1) / GRAY_CELLS_Y * 100.0,
                "color": {"r": 255, "g": 255, "b": 255},
                "dimmer": 255,
                "points": [],
                "dmxAddress": None,
            })
            # Draw a green outline over the verified component
            bb = stats[comp_idx]
            x_bb, y_bb = int(bb[cv2.CC_STAT_LEFT]), int(bb[cv2.CC_STAT_TOP])
            w_bb, h_bb = int(bb[cv2.CC_STAT_WIDTH]), int(bb[cv2.CC_STAT_HEIGHT])
            cv2.rectangle(cc_overlay, (x_bb, y_bb), (x_bb + w_bb, y_bb + h_bb), (0, 255, 0), 2)
            cv2.putText(cc_overlay, f"#{next_id}", (x_bb + 4, y_bb + 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            next_id += 1

    refined = _dedupe_sub_screens(refined)

    _save_debug_image(session_dir, "_verify_overlay.png", cc_overlay)
    try:
        (session_dir / "_verify_summary.json").write_text(
            json.dumps({
                "input_count": len(sub_screens_in),
                "refined_count": len(refined),
                "splits": split_count,
                "per_sub": verify_summary,
            }, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass

    return JSONResponse({
        "ok": True,
        "refined": refined,
        "count": len(refined),
        "splitCount": split_count,
        "debugUrl": f"/debug/calibration/{session_id}/",
    })


@fastapi_app.post("/api/load-layout", dependencies=[Depends(require_api_token)])
async def api_load_layout(request: Request) -> JSONResponse:
    body = await request.json()
    layout_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(layout_id, str):
        return JSONResponse({"error": "Invalid layout id"}, status_code=400)
    file_path = resolve_layout_path(layout_id)
    if file_path is None:
        return JSONResponse({"error": "Invalid layout id"}, status_code=400)
    if not file_path.exists():
        return JSONResponse({"error": "Layout not found"}, status_code=404)
    try:
        layout = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return JSONResponse({"error": "Invalid layout file"}, status_code=500)
    frames = layout.get("frames") if isinstance(layout, dict) else None
    if not isinstance(frames, list):
        frames = []
    replace_layout_frames(frames)
    for frame in frames:
        await sio.emit("frameUpdate", frame, room="displays")
    return JSONResponse({"ok": True, "frames": len(frames)})


# --------- Pages ---------

@fastapi_app.get("/")
async def index() -> RedirectResponse:
    return RedirectResponse(url="/control")


@fastapi_app.get("/control")
async def control_page() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "control.html")


@fastapi_app.get("/display/{display_id}")
async def display_page(display_id: str) -> FileResponse:
    return FileResponse(PUBLIC_DIR / "display.html")


@fastapi_app.get("/kicked")
async def kicked_page() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "kicked.html")


@fastapi_app.get("/subscreen-editor")
async def subscreen_editor_page() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "subscreen-editor.html")


@fastapi_app.get("/locales/{lng}/translation.json")
async def locale_translation(lng: str) -> Response:
    file_path = LOCALES_DIR / lng / "translation.json"
    if not file_path.exists():
        return JSONResponse({"error": "not found"}, status_code=500)
    return Response(content=file_path.read_text(encoding="utf-8"), media_type="application/json")


# --------- Static mounts (registered last so explicit routes take precedence) ---------

fastapi_app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")
fastapi_app.mount("/streams", StaticFiles(directory=str(STREAMS_DIR)), name="streams")
fastapi_app.mount(
    "/debug/calibration",
    StaticFiles(directory=str(CALIB_DEBUG_DIR), html=True),
    name="debug-calibration",
)
fastapi_app.mount("/", StaticFiles(directory=str(PUBLIC_DIR)), name="public")


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------

def _find_sid_by_display_id(display_id: Any) -> Optional[str]:
    target = _to_int(display_id)
    if target is None:
        return None
    for sid, d in displays.items():
        if _to_int(d.get("id")) == target:
            return sid
    return None


@sio.event
async def connect(sid: str, environ: dict[str, Any], auth: Any = None) -> None:
    return None


@sio.on("registerControl")
async def on_register_control(sid: str) -> None:
    await sio.enter_room(sid, "control")
    await sio.emit("updateDisplays", list(displays.values()), room="control")


@sio.on("registerDisplay")
async def on_register_display(sid: str, data: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        data = {}
    previous = displays.get(sid, {})
    displays[sid] = {
        **previous,
        "id": data.get("id"),
        "width": data.get("width"),
        "height": data.get("height"),
        "socketId": sid,
        "connectedAt": previous.get("connectedAt") or int(time.time() * 1000),
    }
    await sio.enter_room(sid, "displays")
    await sio.emit("updateDisplays", list(displays.values()), room="control")


@sio.on("displayStatus")
async def on_display_status(sid: str, data: dict[str, Any]) -> None:
    if sid not in displays:
        return
    if not isinstance(data, dict):
        data = {}
    displays[sid] = {
        **displays[sid],
        **data,
        "socketId": sid,
        "lastSeen": int(time.time() * 1000),
    }
    await sio.emit("displayStatusUpdate", displays[sid], room="control")


@sio.on("displayCommand")
async def on_display_command(sid: str, data: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        return
    target_sid = _find_sid_by_display_id(data.get("id"))
    if target_sid is None:
        return
    await sio.emit("displayCommand", data, room=target_sid)


@sio.on("pingDisplay")
async def on_ping_display(sid: str, data: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        return
    target_sid = _find_sid_by_display_id(data.get("id"))
    if target_sid is None:
        return
    await sio.emit("pingFromControl", {"ts": data.get("ts")}, room=target_sid)


@sio.on("pongDisplay")
async def on_pong_display(sid: str, data: dict[str, Any]) -> None:
    if sid not in displays:
        return
    if not isinstance(data, dict):
        return
    await sio.emit(
        "pongFromDisplay",
        {"id": displays[sid].get("id"), "ts": data.get("ts")},
        room="control",
    )


@sio.on("controlEvent")
async def on_control_event(sid: str, data: dict[str, Any]) -> None:
    global master_time, current_video_src, current_stream_mode, is_playing
    if not isinstance(data, dict):
        data = {}
    if data.get("type") == "load":
        master_time = 0
        src = data.get("src")
        if isinstance(src, str) and src.strip():
            current_video_src = src
        current_stream_mode = data.get("mode") if data.get("mode") else "file"
    if data.get("type") == "seek":
        t = _to_float(data.get("time"), float("nan"))
        if t == t:  # not NaN
            master_time = t
    if data.get("type") == "play":
        is_playing = True
    if data.get("type") == "pause":
        is_playing = False
    await sio.emit("controlEvent", data, room="displays")


@sio.on("frameUpdate")
async def on_frame_update(sid: str, data: dict[str, Any]) -> None:
    normalized = normalize_frame_payload(data)
    if normalized is None:
        return
    layout_frames[normalized["id"]] = normalized
    # Broadcast to displays (for live rendering) AND to all OTHER controls
    # (so the sub-screen editor window stays in sync with the main control).
    await sio.emit("frameUpdate", normalized, room="displays")
    await sio.emit("frameUpdate", normalized, room="control", skip_sid=sid)


@sio.on("frameDelete")
async def on_frame_delete(sid: str, data: dict[str, Any]) -> None:
    frame_id = _to_int(data.get("id") if isinstance(data, dict) else None)
    if frame_id is not None and frame_id in layout_frames:
        del layout_frames[frame_id]
    await sio.emit("frameDelete", {"id": frame_id}, room="displays")


@sio.on("syncRequest")
async def on_sync_request(sid: str) -> None:
    await sio.emit("syncState", build_sync_state(), room=sid)


@sio.on("resyncAll")
async def on_resync_all(sid: str, payload: dict[str, Any]) -> None:
    global current_video_src, master_time, is_playing, current_stream_mode
    if not isinstance(payload, dict):
        payload = {}
    if isinstance(payload.get("src"), str):
        current_video_src = payload["src"]
    t = _to_float(payload.get("time"), float("nan"))
    if t == t:
        master_time = t
    if isinstance(payload.get("playing"), bool):
        is_playing = payload["playing"]
    if isinstance(payload.get("mode"), str):
        current_stream_mode = payload["mode"] or "file"
    if isinstance(payload.get("frames"), list):
        replace_layout_frames(payload["frames"])
    await sio.emit("syncState", build_sync_state(), room="displays")


@sio.on("reportTime")
async def on_report_time(sid: str, data: dict[str, Any]) -> None:
    global master_time
    if not isinstance(data, dict):
        return
    t = _to_float(data.get("time"), float("nan"))
    if t == t:
        master_time = t
    await sio.emit("reportTime", {"id": data.get("id"), "time": data.get("time")}, room="control")


@sio.event
async def disconnect(sid: str) -> None:
    if sid in displays:
        del displays[sid]
        await sio.emit("updateDisplays", list(displays.values()), room="control")


# ---------------------------------------------------------------------------
# ASGI app composition
# ---------------------------------------------------------------------------

asgi_app = socketio.ASGIApp(sio, fastapi_app)


def main() -> None:
    port = int(os.environ.get("PORT") or 3000)
    print(f"Listening on {port}", flush=True)
    uvicorn.run(asgi_app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()

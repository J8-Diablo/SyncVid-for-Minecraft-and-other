"""SyncVid desktop GUI — WebView2 (Edge) variant via pywebview.

Run:
    python gui_webview.py

Lighter alternative to gui.py: instead of bundling QtWebEngine/Chromium,
this version uses the system-installed Microsoft Edge WebView2 runtime.
Resulting exe is ~25-30 MB instead of ~250 MB, but requires WebView2 Runtime
on the target machine (included by default on Windows 10/11 21H2+).

The HTTP server is started in a background thread; the WebView window
loads http://127.0.0.1:3000/control. Display pop-up windows opened from the
control panel ("Add Display") are intercepted via a JS API bridge and shown
as separate pywebview windows.
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
import webview

import server as backend


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT") or 3000)
START_URL = f"http://{HOST}:{PORT}/control"
APP_NAME = "SyncVid"
APP_VERSION = "4.1.0"

IS_FROZEN = getattr(sys, "frozen", False)
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
ICON_ICO_PATH = str(RESOURCE_DIR / "public" / "favicon.ico")

SERVER_START_TIMEOUT = 20.0

_SERVER_READY = threading.Event()
_SERVER_FAILED = threading.Event()
_server_error: BaseException | None = None
_server_instance: uvicorn.Server | None = None


# ---------------------------------------------------------------------------
# Server lifecycle (uvicorn in a background thread)
# ---------------------------------------------------------------------------

def _run_server() -> None:
    global _server_instance, _server_error
    try:
        config = uvicorn.Config(
            backend.asgi_app,
            host="0.0.0.0",
            port=PORT,
            log_level="warning",
            loop="asyncio",
            lifespan="on",
            access_log=False,
            log_config=None,
        )
        _server_instance = uvicorn.Server(config)
        _server_instance.install_signal_handlers = lambda: None  # type: ignore[method-assign]
        _SERVER_READY.set()
        asyncio.run(_server_instance.serve())
    except BaseException as exc:
        _server_error = exc
        _SERVER_FAILED.set()
        _SERVER_READY.set()


def _wait_for_port(host: str, port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _wait_for_http(url: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _SERVER_FAILED.is_set():
            return False
        try:
            with urllib.request.urlopen(url, timeout=1.5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def wait_for_server_ready(timeout: float = SERVER_START_TIMEOUT) -> tuple[bool, str]:
    if not _SERVER_READY.wait(timeout):
        return False, f"Server start timed out after {timeout:.0f}s"
    if _SERVER_FAILED.is_set():
        return False, f"Server failed to start: {_server_error!r}"
    if not _wait_for_port(HOST, PORT, timeout=timeout):
        return False, f"Port {PORT} did not open in time"
    if not _wait_for_http(START_URL, timeout=timeout):
        if _SERVER_FAILED.is_set():
            return False, f"Server failed to start: {_server_error!r}"
        return False, "HTTP health check failed"
    return True, ""


def stop_server() -> None:
    if _server_instance is not None:
        _server_instance.should_exit = True


# ---------------------------------------------------------------------------
# JS bridge — intercept window.open() so display pop-ups become pywebview windows
# ---------------------------------------------------------------------------

_popup_windows: list[webview.Window] = []


def _absolute_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("/"):
        return f"http://{HOST}:{PORT}{url}"
    return f"http://{HOST}:{PORT}/{url}"


class Api:
    """Exposed to JS as window.pywebview.api.*"""

    def open_display(self, url: str) -> bool:
        if not isinstance(url, str) or not url:
            return False
        full_url = _absolute_url(url)
        title = f"{APP_NAME} — Display"
        win = webview.create_window(
            title,
            full_url,
            width=960,
            height=540,
            background_color="#000000",
            resizable=True,
        )
        _popup_windows.append(win)
        return True


_JS_WINDOW_OPEN_OVERRIDE = """
(function () {
  if (window.__syncvidOpenHook) return;
  window.__syncvidOpenHook = true;
  function tryOverride() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.open_display) {
      return false;
    }
    const stubWin = {
      closed: false,
      close: function () { this.closed = true; },
      focus: function () {},
      blur: function () {},
      postMessage: function () {}
    };
    window.open = function (url, name, features) {
      try {
        window.pywebview.api.open_display(String(url || ''));
      } catch (e) {
        console.error('[syncvid] open_display failed', e);
      }
      return stubWin;
    };
    return true;
  }
  if (!tryOverride()) {
    // pywebview API may not be injected yet — retry a few times
    let attempts = 0;
    const id = setInterval(function () {
      attempts++;
      if (tryOverride() || attempts > 40) clearInterval(id);
    }, 100);
  }
})();
"""


def _on_main_window_loaded(window: webview.Window) -> None:
    try:
        window.evaluate_js(_JS_WINDOW_OPEN_OVERRIDE)
    except Exception as exc:
        print(f"[gui_webview] failed to inject open() override: {exc}", flush=True)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def main() -> int:
    threading.Thread(target=_run_server, daemon=True, name="SyncVidServer").start()

    ready, err = wait_for_server_ready()
    if not ready:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, f"Backend startup failed.\n\n{err}", APP_NAME, 0x10)
        except Exception:
            print(f"Backend startup failed: {err}", flush=True)
        return 1

    api = Api()
    main_window = webview.create_window(
        APP_NAME,
        START_URL,
        width=1280,
        height=800,
        background_color="#05060a",
        js_api=api,
        resizable=True,
    )

    # Inject window.open() hook on every (re)load of the main window
    main_window.events.loaded += lambda: _on_main_window_loaded(main_window)

    icon_path = ICON_ICO_PATH if os.path.exists(ICON_ICO_PATH) else None

    try:
        webview.start(
            gui="edgechromium",
            debug=False,
            icon=icon_path,
        )
    except TypeError:
        # Older pywebview without `icon` kwarg
        webview.start(gui="edgechromium", debug=False)
    finally:
        stop_server()

    return 0


if __name__ == "__main__":
    sys.exit(main())

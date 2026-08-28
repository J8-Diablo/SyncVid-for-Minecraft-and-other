"""SyncVid desktop GUI — embeds the local FastAPI/Socket.IO web app in a Qt window.

Run:
    python gui.py

The HTTP server is started in a background thread; the QWebEngineView
loads http://127.0.0.1:3000/control. Display pop-up windows opened from the
control panel ("Add Display") are intercepted and shown as separate
QWebEngineView windows.
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

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QVBoxLayout,
    QWidget,
)

try:
    from PySide6.QtSvg import QSvgRenderer
except ImportError:  # PySide6-Essentials build without QtSvg
    QSvgRenderer = None  # type: ignore[assignment]

import uvicorn

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
ICON_SVG_PATH = str(RESOURCE_DIR / "public" / "favicon.svg")
ICON_ICO_PATH = str(RESOURCE_DIR / "public" / "favicon.ico")

SERVER_START_TIMEOUT = 20.0
GUI_SPLASH_MIN_VISIBLE_MS = 1400
MAX_LOAD_ATTEMPTS = 30
LOAD_RETRY_MS = 600

APP_ICON: QIcon | None = None
_popup_views: list[QWebEngineView] = []

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
        # Disable uvicorn's signal handlers — we shut it down via should_exit
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
# Icon helpers
# ---------------------------------------------------------------------------

def build_svg_pixmap(svg_path: str, size: int = 96) -> QPixmap:
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.transparent)
    if QSvgRenderer is None or not svg_path or not os.path.exists(svg_path):
        return pixmap
    renderer = QSvgRenderer(svg_path)
    if not renderer.isValid():
        return pixmap
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing, True)
    painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
    renderer.render(painter)
    painter.end()
    return pixmap


def build_app_icon() -> QIcon | None:
    if os.path.exists(ICON_ICO_PATH):
        return QIcon(ICON_ICO_PATH)
    if QSvgRenderer is None or not os.path.exists(ICON_SVG_PATH):
        return None
    icon = QIcon()
    renderer = QSvgRenderer(ICON_SVG_PATH)
    if not renderer.isValid():
        return None
    for size in (16, 24, 32, 48, 64, 128, 256):
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        renderer.render(painter)
        painter.end()
        icon.addPixmap(pixmap)
    return icon


def set_windows_app_id(app_id: str) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Splash
# ---------------------------------------------------------------------------

class StartupSplash(QWidget):
    def __init__(self, logo_pixmap: QPixmap | None) -> None:
        super().__init__()
        self.setWindowFlags(
            Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.SplashScreen
        )
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background-color: #05060a;")
        self.setFixedSize(560, 180)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(28, 28, 28, 28)
        layout.setSpacing(22)

        logo = QLabel(self)
        logo.setAlignment(Qt.AlignCenter)
        logo.setFixedSize(96, 96)
        if logo_pixmap is not None and not logo_pixmap.isNull():
            logo.setPixmap(logo_pixmap)

        text_wrap = QWidget(self)
        text_layout = QVBoxLayout(text_wrap)
        text_layout.setContentsMargins(0, 0, 0, 0)
        text_layout.setSpacing(4)
        text_layout.setAlignment(Qt.AlignVCenter)

        title = QLabel(APP_NAME, text_wrap)
        title.setStyleSheet("color: #e5e7eb;")
        title_font = QFont("Segoe UI", 28)
        title_font.setWeight(QFont.DemiBold)
        title.setFont(title_font)

        version = QLabel(f"v{APP_VERSION}", text_wrap)
        version.setStyleSheet("color: #64748b;")
        version_font = QFont("Segoe UI", 13)
        version_font.setWeight(QFont.Medium)
        version.setFont(version_font)

        self.status = QLabel("Starting backend…", text_wrap)
        self.status.setStyleSheet("color: #94a3b8;")
        status_font = QFont("Segoe UI", 11)
        self.status.setFont(status_font)

        text_layout.addWidget(title)
        text_layout.addWidget(version)
        text_layout.addWidget(self.status)
        layout.addWidget(logo, 0, Qt.AlignVCenter)
        layout.addWidget(text_wrap, 1, Qt.AlignVCenter)

    def center_on_primary_screen(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        rect = screen.availableGeometry()
        self.move(
            rect.x() + (rect.width() - self.width()) // 2,
            rect.y() + (rect.height() - self.height()) // 2,
        )


# ---------------------------------------------------------------------------
# Web pages with popup support (display windows)
# ---------------------------------------------------------------------------

class SyncVidPage(QWebEnginePage):
    def __init__(self, profile, parent=None):
        super().__init__(profile, parent)
        self.settings().setAttribute(QWebEngineSettings.JavascriptCanOpenWindows, True)
        self.settings().setAttribute(QWebEngineSettings.JavascriptCanAccessClipboard, True)
        self.settings().setAttribute(QWebEngineSettings.AllowRunningInsecureContent, True)
        self.settings().setAttribute(QWebEngineSettings.PlaybackRequiresUserGesture, False)
        self.featurePermissionRequested.connect(self._on_feature_permission)

    def javaScriptConsoleMessage(self, level, message, line_number, source_id):
        # Surface JS console to terminal — helpful while iterating.
        print(f"[JS {level}] {source_id}:{line_number} {message}", flush=True)

    def _on_feature_permission(self, origin, feature):
        # Auto-grant everything to localhost; deny elsewhere.
        if origin.host() in ("127.0.0.1", "localhost"):
            policy = QWebEnginePage.PermissionGrantedByUser
        else:
            policy = QWebEnginePage.PermissionDeniedByUser
        self.setFeaturePermission(origin, feature, policy)

    def createWindow(self, _type):
        view = QWebEngineView()
        if APP_ICON is not None:
            view.setWindowIcon(APP_ICON)
        page = SyncVidPage(self.profile(), view)
        page.setBackgroundColor(QColor("#000000"))
        view.setPage(page)
        view.resize(960, 540)
        view.setWindowTitle(f"{APP_NAME} — Display")
        view.setAttribute(Qt.WA_DeleteOnClose, True)
        view.show()
        _popup_views.append(view)
        view.destroyed.connect(
            lambda *_a, ref=view: _popup_views.remove(ref) if ref in _popup_views else None
        )
        return page


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def main() -> int:
    global APP_ICON

    qt_app = QApplication(sys.argv)
    set_windows_app_id("SyncVid")

    APP_ICON = build_app_icon()
    if APP_ICON is not None:
        qt_app.setWindowIcon(APP_ICON)

    splash = StartupSplash(build_svg_pixmap(ICON_SVG_PATH, 96))
    if APP_ICON is not None:
        splash.setWindowIcon(APP_ICON)
    splash.center_on_primary_screen()
    splash.show()
    qt_app.processEvents()

    threading.Thread(target=_run_server, daemon=True, name="SyncVidServer").start()

    server_ok, err = wait_for_server_ready()
    if not server_ok:
        splash.close()
        QMessageBox.critical(None, APP_NAME, f"Backend startup failed.\n\n{err}")
        return 1

    qt_app.aboutToQuit.connect(stop_server)

    view = QWebEngineView()
    view.setStyleSheet("background-color: #05060a;")
    view.setWindowTitle(APP_NAME)
    if APP_ICON is not None:
        view.setWindowIcon(APP_ICON)
    page = SyncVidPage(view.page().profile(), view)
    page.setBackgroundColor(QColor("#05060a"))
    page.profile().clearHttpCache()
    view.setPage(page)
    view.resize(1280, 800)

    def load_url(attempt: int = 0) -> None:
        view.load(QUrl(f"{START_URL}?gui=1&t={int(time.time())}&attempt={attempt}"))

    def retry_load(reason: str) -> None:
        attempt = int(view.property("load_attempt") or 0) + 1
        view.setProperty("load_attempt", attempt)
        if attempt <= MAX_LOAD_ATTEMPTS:
            QTimer.singleShot(LOAD_RETRY_MS, lambda: load_url(attempt))
        else:
            print(f"[GUI] load failed after retries: {reason}", flush=True)

    splash_min_deadline = time.monotonic() + (GUI_SPLASH_MIN_VISIBLE_MS / 1000.0)

    def finish_startup_now() -> None:
        if splash.isVisible():
            splash.close()
        if not view.isVisible():
            view.show()

    def schedule_finish() -> None:
        remaining_ms = max(0, int((splash_min_deadline - time.monotonic()) * 1000))
        QTimer.singleShot(remaining_ms, finish_startup_now)

    def on_load_finished(ok: bool) -> None:
        if not ok:
            retry_load("loadFinished=false")
            return
        schedule_finish()

    view.loadFinished.connect(on_load_finished)
    load_url()

    return qt_app.exec()


if __name__ == "__main__":
    sys.exit(main())

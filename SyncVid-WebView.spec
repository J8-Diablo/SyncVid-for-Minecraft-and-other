# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the WebView2 (pywebview / Edge) build.
# Resulting exe is ~25-30 MB instead of ~250 MB for the PySide6 build,
# but requires the Microsoft Edge WebView2 Runtime on the target machine
# (already shipped by default on Windows 10/11 21H2+).


a = Analysis(
    ['gui_webview.py'],
    pathex=[],
    binaries=[],
    datas=[('public', 'public'), ('locales', 'locales')],
    hiddenimports=[
        'engineio.async_drivers.asgi',
        'uvicorn.logging',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.lifespan.on',
        'webview.platforms.edgechromium',
        'clr_loader',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Don't bundle the heavy Qt/Chromium stack in the WebView2 build
        'PySide6',
        'PySide2',
        'PyQt5',
        'PyQt6',
        'shiboken6',
        'shiboken2',
        # numpy is pulled in transitively by some deps but unused here
        'numpy',
        # Common test/build frameworks that occasionally get scanned
        'tkinter',
        'matplotlib',
        'pandas',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='SyncVid-WebView',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['public\\favicon.ico'],
)

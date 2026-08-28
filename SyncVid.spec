# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['gui.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('public', 'public'),
        ('locales', 'locales'),
        # Le panneau « Serveur WebRTC » lance ce script dans un python
        # du systeme ; il doit donc etre present a cote de l'exe.
        ('webrtc_server/whep_server.py', 'webrtc_server'),
        ('webrtc_server/requirements.txt', 'webrtc_server'),
        ('webrtc_server/README.md', 'webrtc_server'),
    ],
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
        'cv2',
        'numpy',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
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
    name='SyncVid',
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

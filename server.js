const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { spawn, spawnSync } = require('child_process');

let currentVideoSrc = '';
let isPlaying = false;
let masterTime = 0;
let layoutFrames = {};
let currentStreamMode = 'file';
let rtmpProcess = null;
let rtmpSourceUrl = '';
const rtmpManifestUrl = '/streams/rtmp/index.m3u8';

const VALID_SUBSCREEN_SHAPES = new Set(['rect', 'circle', 'triangle', 'polygon']);

function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function normalizeSubScreenPayload(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const id = Number.parseInt(sub.id, 10);
  if (!Number.isFinite(id)) return null;
  const shape = VALID_SUBSCREEN_SHAPES.has(sub.shape) ? sub.shape : 'rect';
  const colorRaw = sub.color && typeof sub.color === 'object' ? sub.color : {};
  const color = {
    r: Math.round(clamp(Number.parseFloat(colorRaw.r) || 255, 0, 255)),
    g: Math.round(clamp(Number.parseFloat(colorRaw.g) || 255, 0, 255)),
    b: Math.round(clamp(Number.parseFloat(colorRaw.b) || 255, 0, 255))
  };
  const points = [];
  if (Array.isArray(sub.points)) {
    sub.points.forEach(p => {
      if (Array.isArray(p) && p.length >= 2) {
        points.push([Number.parseFloat(p[0]) || 0, Number.parseFloat(p[1]) || 0]);
      }
    });
  }
  const dmx = Number.parseInt(sub.dmxAddress, 10);
  return {
    id,
    shape,
    x: Number.parseFloat(sub.x) || 0,
    y: Number.parseFloat(sub.y) || 0,
    width: Number.parseFloat(sub.width) || 0,
    height: Number.parseFloat(sub.height) || 0,
    rotation: Number.parseFloat(sub.rotation) || 0,
    points,
    color,
    dimmer: Math.round(clamp(Number.parseFloat(sub.dimmer) || 255, 0, 255)),
    dmxAddress: Number.isFinite(dmx) ? dmx : null
  };
}

function normalizeFramePayload(frame) {
  const id = Number.parseInt(frame && frame.id, 10);
  const x = Number.parseFloat(frame && frame.x);
  const y = Number.parseFloat(frame && frame.y);
  const width = Number.parseFloat(frame && frame.width);
  const height = Number.parseFloat(frame && frame.height);
  if (!Number.isFinite(id)) return null;
  const subScreens = [];
  if (frame && Array.isArray(frame.subScreens)) {
    frame.subScreens.forEach(s => {
      const normalized = normalizeSubScreenPayload(s);
      if (normalized) subScreens.push(normalized);
    });
  }
  return {
    id,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    subScreens
  };
}

function updateLayoutFrame(frame) {
  const normalized = normalizeFramePayload(frame);
  if (!normalized) return;
  layoutFrames[normalized.id] = normalized;
}

function replaceLayoutFrames(frames) {
  const next = {};
  if (Array.isArray(frames)) {
    frames.forEach(frame => {
      const normalized = normalizeFramePayload(frame);
      if (normalized) next[normalized.id] = normalized;
    });
  }
  layoutFrames = next;
}

function buildSyncState() {
  return {
    src: currentVideoSrc || '',
    time: Number.isFinite(masterTime) ? masterTime : 0,
    playing: Boolean(isPlaying),
    frames: Object.values(layoutFrames),
    mode: currentStreamMode
  };
}

function ensureRtmpDir() {
  fs.mkdirSync(rtmpOutputDir, { recursive: true });
}

function clearRtmpDir() {
  fs.rmSync(rtmpOutputDir, { recursive: true, force: true });
  fs.mkdirSync(rtmpOutputDir, { recursive: true });
}

function stopRtmpTranscode() {
  if (!rtmpProcess) return;
  const proc = rtmpProcess;
  rtmpProcess = null;
  try {
    proc.kill('SIGKILL');
  } catch (err) {
    // ignore
  }
}

function hasFfmpeg() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    return result.status === 0;
  } catch (err) {
    return false;
  }
}

function toListenUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hostname = '0.0.0.0';
    return parsed.toString();
  } catch (err) {
    return url;
  }
}

function startRtmpTranscode(url, listenMode = true) {
  stopRtmpTranscode();
  clearRtmpDir();
  rtmpSourceUrl = url;
  const inputUrl = listenMode ? toListenUrl(url) : url;
  const args = [
    '-nostdin',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-rtmp_live', 'live',
    ...(listenMode ? ['-listen', '1'] : []),
    '-i', inputUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(rtmpOutputDir, 'seg_%05d.ts'),
    rtmpManifestPath
  ];
  rtmpProcess = spawn('ffmpeg', args, { windowsHide: true });
  rtmpProcess.stderr.on('data', data => {
    const msg = data.toString();
    if (msg.trim()) {
      console.log('[rtmp]', msg.trim());
    }
  });
  rtmpProcess.on('exit', code => {
    console.log(`[rtmp] ffmpeg exited with code ${code}`);
  });
}


// Détection si l'application est exécutée depuis un binaire pkg
const isPkg = typeof process.pkg !== 'undefined';
const resourceDir = __dirname;
const appDataRoot = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
const dataDir = isPkg ? path.join(appDataRoot, 'SyncVid') : resourceDir;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '2mb' }));

const corsOptions = {
  origin: ['http://127.0.0.1:5000', 'http://localhost:5000'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-token', 'Authorization'],
  credentials: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Définition des chemins en utilisant baseDir
const publicDir = path.join(resourceDir, 'public');
const localesDir = path.join(resourceDir, 'locales');
const resourceVideosDir = path.join(publicDir, 'videos');
const resourceStreamsDir = path.join(publicDir, 'streams');
const videosDir = isPkg ? path.join(dataDir, 'videos') : resourceVideosDir;
const uploadsDir = isPkg ? path.join(dataDir, 'uploads') : path.join(resourceDir, 'uploads');
const layoutsDir = isPkg ? path.join(dataDir, 'layouts') : path.join(resourceDir, 'layouts');
const streamsDir = isPkg ? path.join(dataDir, 'streams') : resourceStreamsDir;
const configDir = isPkg ? path.join(dataDir, 'config') : path.join(resourceDir, 'config');
const apiConfigPath = path.join(configDir, 'api.json');
const rtmpOutputDir = path.join(streamsDir, 'rtmp');
const rtmpManifestPath = path.join(rtmpOutputDir, 'index.m3u8');

// Création des dossiers nécessaires
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(layoutsDir, { recursive: true });
fs.mkdirSync(streamsDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

function seedVideos() {
  if (!isPkg) return;
  try {
    const existing = fs.readdirSync(videosDir).filter(f => /\.webm$/i.test(f));
    if (existing.length) return;
    if (!fs.existsSync(resourceVideosDir)) return;
    fs.readdirSync(resourceVideosDir)
      .filter(f => /\.webm$/i.test(f))
      .forEach(file => {
        const src = path.join(resourceVideosDir, file);
        const dst = path.join(videosDir, file);
        try {
          fs.copyFileSync(src, dst);
        } catch (err) {
          // Ignore copy errors and continue.
        }
      });
  } catch (err) {
    // Ignore seeding errors.
  }
}

seedVideos();

// Configuration de Multer
const upload = multer({ dest: uploadsDir });

// Servir les fichiers statiques
app.use('/videos', express.static(videosDir));
app.use('/streams', express.static(streamsDir));
app.use(express.static(publicDir));

function sanitizeLayoutId(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'layout';
}

const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// The multipart filename is attacker-controlled and path.join() resolves
// "..", so every path component has to be stripped before it reaches disk.
// Accents and spaces are kept; only what breaks a path or a filesystem goes.
// Mirrors sanitize_video_filename() in server.py — keep the two in sync.
function sanitizeVideoFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const stem = path.basename(base, path.extname(base));
  let cleaned = stem
    .replace(/[\x00-\x1f<>:"|?*]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 120);
  if (!cleaned) return 'video.webm';
  // CON.webm, NUL.webm… still address devices on Windows, not files.
  if (WIN_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`;
  return `${cleaned}.webm`;
}

function resolveLayoutPath(id) {
  if (!/^[a-z0-9_-]+$/i.test(id)) return null;
  return path.join(layoutsDir, `${id}.json`);
}

const apiConfig = {
  enabled: false,
  token: ''
};

function loadApiConfig() {
  if (!fs.existsSync(apiConfigPath)) return;
  try {
    const raw = fs.readFileSync(apiConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    apiConfig.enabled = Boolean(parsed.enabled);
    apiConfig.token = typeof parsed.token === 'string' ? parsed.token : '';
  } catch (err) {
    console.error('Failed to load API config:', err.message);
  }
}

function saveApiConfig() {
  fs.writeFileSync(apiConfigPath, JSON.stringify(apiConfig, null, 2), 'utf8');
}

function extractToken(req) {
  const headerToken = req.headers['x-api-token'];
  const authHeader = req.headers.authorization;
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.query && typeof req.query.token === 'string') return req.query.token.trim();
  if (req.body && typeof req.body.token === 'string') return req.body.token.trim();
  return '';
}

function isTokenValid(req) {
  if (!apiConfig.enabled) return true;
  if (!apiConfig.token) return false;
  const token = extractToken(req);
  return token && token === apiConfig.token;
}

function requireApiToken(req, res, next) {
  if (!apiConfig.enabled) return next();
  if (!apiConfig.token) return res.status(401).json({ error: 'API token not configured' });
  if (isTokenValid(req)) return next();
  return res.status(401).json({ error: 'Invalid API token' });
}

loadApiConfig();

// Upload route
app.post('/upload', upload.single('video'), (req, res) => {
  const temp       = req.file.path;
  const orig       = req.file.originalname;
  const clientId   = req.body.clientId;
  const safeName   = sanitizeVideoFilename(orig);
  const dest       = path.join(videosDir, safeName);


  // Fonction utilitaire pour convertir un « timemark » HH:MM:SS.xx en secondes float
  function timemarkToSeconds(tm) {
    const parts = tm.split(':').map(parseFloat);
    return parts[0]*3600 + parts[1]*60 + parts[2];
  }

  // Defence in depth: sanitizeVideoFilename already strips every path
  // component, so a dest outside videosDir means it regressed.
  if (path.relative(videosDir, dest).startsWith('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  fs.rename(temp, dest, err => {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`Upload terminé : ${safeName}`);
    return res.json({ filename: safeName });
  });
});

// Route pour lister les vidéos
app.get('/videos/list', (req, res) => {
  fs.readdir(videosDir, (e, files) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ videos: files.filter(f => /\.webm$/i.test(f)) });
  });
});

// Layouts
app.get('/layouts/list', (req, res) => {
  fs.readdir(layoutsDir, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const layouts = files
      .filter(file => /\.json$/i.test(file))
      .map(file => {
        const id = path.basename(file, '.json');
        let name = id;
        try {
          const raw = fs.readFileSync(path.join(layoutsDir, file), 'utf8');
          const data = JSON.parse(raw);
          if (data && data.name) name = data.name;
        } catch (e) {
          // ignore parse errors and keep filename
        }
        return { id, name };
      });
    res.json({ layouts });
  });
});

app.post('/layouts/save', (req, res) => {
  const { name, frames } = req.body || {};
  if (!Array.isArray(frames)) {
    return res.status(400).json({ error: 'Invalid layout frames' });
  }
  const layoutName = typeof name === 'string' && name.trim() ? name.trim() : `layout-${Date.now()}`;
  const baseId = sanitizeLayoutId(layoutName);
  let id = baseId;
  let filePath = path.join(layoutsDir, `${id}.json`);
  if (fs.existsSync(filePath)) {
    id = `${baseId}-${Date.now()}`;
    filePath = path.join(layoutsDir, `${id}.json`);
  }
  const payload = {
    id,
    name: layoutName,
    savedAt: new Date().toISOString(),
    frames
  };
  fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8', err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name: layoutName });
  });
});

app.get('/layouts/export/:id', (req, res) => {
  const filePath = resolveLayoutPath(req.params.id);
  if (!filePath) return res.status(400).json({ error: 'Invalid layout id' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Layout not found' });
  res.download(filePath, `${req.params.id}.json`);
});

app.get('/layouts/:id', (req, res) => {
  const filePath = resolveLayoutPath(req.params.id);
  if (!filePath) return res.status(400).json({ error: 'Invalid layout id' });
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Layout not found' });
    res.type('json').send(data);
  });
});

app.delete('/layouts/:id', (req, res) => {
  const filePath = resolveLayoutPath(req.params.id);
  if (!filePath) return res.status(400).json({ error: 'Invalid layout id' });
  fs.unlink(filePath, err => {
    if (err) return res.status(404).json({ error: 'Layout not found' });
    res.json({ ok: true });
  });
});

// API config
app.get('/api/config', (req, res) => {
  return res.json({ enabled: apiConfig.enabled, token: apiConfig.token || '' });
});

app.post('/api/config', (req, res) => {
  const enabled = Boolean(req.body && req.body.enabled);
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  if (enabled && !token) {
    return res.status(400).json({ error: 'Token required when API is enabled' });
  }
  apiConfig.enabled = enabled;
  apiConfig.token = enabled ? token : '';
  saveApiConfig();
  return res.json({ enabled: apiConfig.enabled, token: apiConfig.token || '' });
});

// RTMP -> HLS helper
app.post('/rtmp/start', (req, res) => {
  const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  const listenMode = req.body && typeof req.body.listen === 'boolean' ? req.body.listen : true;
  if (!url || !url.startsWith('rtmp://')) {
    return res.status(400).json({ error: 'Invalid RTMP url' });
  }
  if (!hasFfmpeg()) {
    return res.status(500).json({ error: 'ffmpeg not found in PATH' });
  }
  ensureRtmpDir();
  startRtmpTranscode(url, listenMode);
  currentVideoSrc = rtmpManifestUrl;
  currentStreamMode = 'rtmp';
  masterTime = 0;
  return res.json({ ok: true, hlsUrl: rtmpManifestUrl, listen: listenMode });
});

app.post('/rtmp/stop', (req, res) => {
  stopRtmpTranscode();
  rtmpSourceUrl = '';
  return res.json({ ok: true });
});

// API control endpoints
app.post('/api/play', requireApiToken, (req, res) => {
  io.to('displays').emit('controlEvent', { type: 'play' });
  isPlaying = true;
  res.json({ ok: true });
});

app.post('/api/pause', requireApiToken, (req, res) => {
  io.to('displays').emit('controlEvent', { type: 'pause' });
  isPlaying = false;
  res.json({ ok: true });
});

app.post('/api/seek', requireApiToken, (req, res) => {
  const time = parseFloat(req.body && req.body.time);
  if (!Number.isFinite(time)) {
    return res.status(400).json({ error: 'Invalid time' });
  }
  masterTime = time;
  io.to('displays').emit('controlEvent', { type: 'seek', time });
  res.json({ ok: true, time });
});

app.post('/api/load-video', requireApiToken, (req, res) => {
  const srcInput = (req.body && (req.body.src || req.body.name || req.body.filename)) || '';
  if (!srcInput) return res.status(400).json({ error: 'Missing src or name' });
  let src = String(srcInput);
  if (!src.startsWith('/videos/')) {
    if (src.includes('/') || src.includes('\\')) {
      return res.status(400).json({ error: 'Invalid video path' });
    }
    src = `/videos/${src}`;
  }
  masterTime = 0;
  currentVideoSrc = src;
  currentStreamMode = 'file';
  io.to('displays').emit('controlEvent', { type: 'load', src });
  res.json({ ok: true, src });
});

app.post('/api/load-layout', requireApiToken, (req, res) => {
  const id = req.body && req.body.id;
  const filePath = resolveLayoutPath(id);
  if (!filePath) return res.status(400).json({ error: 'Invalid layout id' });
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Layout not found' });
    let layout;
    try {
      layout = JSON.parse(data);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Invalid layout file' });
    }
    const frames = Array.isArray(layout.frames) ? layout.frames : [];
    replaceLayoutFrames(frames);
    frames.forEach(frame => {
      io.to('displays').emit('frameUpdate', frame);
    });
    res.json({ ok: true, frames: frames.length });
  });
});

// Pages HTML
app.get('/', (req, res) => res.redirect('/control'));
app.get('/control', (req, res) => res.sendFile(path.join(publicDir, 'control.html')));
app.get('/display/:id', (req, res) => res.sendFile(path.join(publicDir, 'display.html')));
app.get('/kicked', (req, res) => res.sendFile(path.join(publicDir, 'kicked.html')));

// Traduction locale
app.get('/locales/:lng/translation.json', (req, res) => {
  const lng = req.params.lng;
  const filePath = path.join(localesDir, lng, 'translation.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(JSON.parse(data));
  });
});

// Gestion des connexions WebSocket
let displays = {};

function findSocketIdByDisplayId(id) {
  const targetId = Number.parseInt(id, 10);
  if (!Number.isFinite(targetId)) return null;
  for (const [sid, d] of Object.entries(displays)) {
    if (Number.parseInt(d.id, 10) === targetId) return sid;
  }
  return null;
}

io.on('connection', socket => {
  socket.on('registerControl', () => {
    socket.join('control');
    io.to('control').emit('updateDisplays', Object.values(displays));
  });

  socket.on('registerDisplay', ({ id, width, height }) => {
    const previous = displays[socket.id] || {};
    displays[socket.id] = {
      ...previous,
      id,
      width,
      height,
      socketId: socket.id,
      connectedAt: previous.connectedAt || Date.now()
    };
    socket.join('displays');
    io.to('control').emit('updateDisplays', Object.values(displays));
  });

  socket.on('displayStatus', data => {
    if (!displays[socket.id]) return;
    displays[socket.id] = {
      ...displays[socket.id],
      ...(data || {}),
      socketId: socket.id,
      lastSeen: Date.now()
    };
    io.to('control').emit('displayStatusUpdate', displays[socket.id]);
  });

  socket.on('displayCommand', data => {
    if (!data) return;
    const sid = findSocketIdByDisplayId(data.id);
    if (!sid) return;
    io.to(sid).emit('displayCommand', data);
  });

  socket.on('pingDisplay', ({ id, ts }) => {
    const sid = findSocketIdByDisplayId(id);
    if (!sid) return;
    io.to(sid).emit('pingFromControl', { ts });
  });

  socket.on('pongDisplay', ({ ts }) => {
    if (!displays[socket.id]) return;
    io.to('control').emit('pongFromDisplay', { id: displays[socket.id].id, ts });
  });

  socket.on('controlEvent', data => {
    if (data && data.type === 'load') {
      masterTime = 0;
      if (typeof data.src === 'string' && data.src.trim()) {
        currentVideoSrc = data.src;
      }
      currentStreamMode = data && data.mode ? data.mode : 'file';
    }
    if (data && data.type === 'seek' && Number.isFinite(data.time)) {
      masterTime = data.time;
    }
    if (data && data.type === 'play') isPlaying = true;
    if (data && data.type === 'pause') isPlaying = false;
    io.to('displays').emit('controlEvent', data);
  });

  socket.on('frameUpdate', data => {
    const normalized = normalizeFramePayload(data);
    if (!normalized) return;
    layoutFrames[normalized.id] = normalized;
    io.to('displays').emit('frameUpdate', normalized);
  });

  socket.on('frameDelete', data => {
    const id = Number.parseInt(data && data.id, 10);
    if (Number.isFinite(id)) delete layoutFrames[id];
    io.to('displays').emit('frameDelete', { id });
  });

  socket.on('syncRequest', () => {
    socket.emit('syncState', buildSyncState());
  });

  socket.on('resyncAll', payload => {
    if (payload && typeof payload.src === 'string') {
      currentVideoSrc = payload.src;
    }
    if (payload && Number.isFinite(payload.time)) {
      masterTime = payload.time;
    }
    if (payload && typeof payload.playing === 'boolean') {
      isPlaying = payload.playing;
    }
    if (payload && typeof payload.mode === 'string') {
      currentStreamMode = payload.mode || 'file';
    }
    if (payload && Array.isArray(payload.frames)) {
      replaceLayoutFrames(payload.frames);
    }
    io.to('displays').emit('syncState', buildSyncState());
  });

  socket.on('reportTime', ({ id, time }) => {
    if (Number.isFinite(time)) {
      masterTime = time;
    }
    io.to('control').emit('reportTime', { id, time });
  });

  socket.on('disconnect', () => {
    delete displays[socket.id];
    io.to('control').emit('updateDisplays', Object.values(displays));
  });
});




// Démarrage du serveur sur le port 3000
const port = Number.parseInt(process.env.PORT, 10) || 3000;

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} already in use. Stop the existing process or start with PORT=<other port>.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => console.log(`Listening on ${port}`));

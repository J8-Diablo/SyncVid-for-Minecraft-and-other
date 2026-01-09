const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');


// Détection si l'application est exécutée depuis un binaire pkg
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? process.cwd() : __dirname; // Utilisation de process.cwd() si c'est un binaire

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
const videosDir = path.join(baseDir, 'public/videos');
const uploadsDir = path.join(baseDir, 'uploads');
const layoutsDir = path.join(baseDir, 'layouts');
const configDir = path.join(baseDir, 'config');
const apiConfigPath = path.join(configDir, 'api.json');

// Création des dossiers nécessaires
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(layoutsDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

// Configuration de Multer
const upload = multer({ dest: uploadsDir });

// Servir les fichiers statiques
app.use('/videos', express.static(videosDir));
app.use(express.static(path.join(baseDir, 'public')));

function sanitizeLayoutId(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'layout';
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
  const ext        = path.extname(orig).toLowerCase();
  const clientId   = req.body.clientId;
  const outputName = orig.replace(/\.[^/.]+$/, '.webm');
  const outputPath = path.join(videosDir, outputName);


  // Fonction utilitaire pour convertir un « timemark » HH:MM:SS.xx en secondes float
  function timemarkToSeconds(tm) { 
    const parts = tm.split(':').map(parseFloat);
    return parts[0]*3600 + parts[1]*60 + parts[2];
  }
  if (ext === '.webm') {
    // Déplace directement
    const dest = path.join(videosDir, orig);
    fs.rename(temp, dest, err => {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`Upload terminé : ${orig}`);
      return res.json({ filename: orig });
    });

  } else {
    // change the extension to webm
    const dest = path.join(videosDir, outputName);
    fs.rename(temp, dest, err => {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`Upload terminé : ${outputName}`);
      return res.json({ filename: outputName });
    });
  }
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

// API control endpoints
app.post('/api/play', requireApiToken, (req, res) => {
  io.to('displays').emit('controlEvent', { type: 'play' });
  res.json({ ok: true });
});

app.post('/api/pause', requireApiToken, (req, res) => {
  io.to('displays').emit('controlEvent', { type: 'pause' });
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
    frames.forEach(frame => {
      io.to('displays').emit('frameUpdate', frame);
    });
    res.json({ ok: true, frames: frames.length });
  });
});

// Pages HTML
app.get('/', (req, res) => res.redirect('/control'));
app.get('/control', (req, res) => res.sendFile(path.join(baseDir, 'public/control.html')));
app.get('/display/:id', (req, res) => res.sendFile(path.join(baseDir, 'public/display.html')));

// Traduction locale
app.get('/locales/:lng/translation.json', (req, res) => {
  const lng = req.params.lng;
  const filePath = path.join(baseDir, 'locales', lng, 'translation.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(JSON.parse(data));
  });
});

// Gestion des connexions WebSocket
let displays = {};
let masterTime = 0;

io.on('connection', socket => {
  socket.on('registerControl', () => {
    socket.join('control');
    io.to('control').emit('updateDisplays', Object.values(displays));
  });

  socket.on('registerDisplay', ({ id, width, height }) => {
    displays[socket.id] = { id, width, height };
    socket.join('displays');
    io.to('control').emit('updateDisplays', Object.values(displays));
  });

  socket.on('controlEvent', data => {
    if (data.type === 'load') masterTime = 0;
    io.to('displays').emit('controlEvent', data);
  });

  socket.on('frameUpdate', data => {
    io.to('displays').emit('frameUpdate', data);
  });

  socket.on('syncRequest', () => {
    io.to('displays').emit('controlEvent', { type: 'seek', time: masterTime });
  });

  socket.on('reportTime', ({ id, time }) => {
    masterTime = time;
    io.to('control').emit('reportTime', { id, time });
  });

  socket.on('disconnect', () => {
    delete displays[socket.id];
    io.to('control').emit('updateDisplays', Object.values(displays));
  });
});




// Démarrage du serveur sur le port 3000
server.listen(3000, () => console.log('Listening on 3000'));

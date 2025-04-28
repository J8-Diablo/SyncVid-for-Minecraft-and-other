const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure necessary directories exist
const videosDir = path.join(__dirname, 'public/videos');
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config
const upload = multer({ dest: uploadsDir });

// Serve static
app.use('/videos', express.static(videosDir));
app.use(express.static(path.join(__dirname, 'public')));

// Upload route
app.post('/upload', upload.single('video'), (req, res) => {
  const temp = req.file.path;
  const orig = req.file.originalname;
  const ext = path.extname(orig).toLowerCase();
  if (ext !== '.webm' || req.file.mimetype !== 'video/webm') {
    fs.unlink(temp, () => res.status(400).json({ error: 'Seuls les WebM sont autorisés.' }));
    return;
  }
  const dest = path.join(videosDir, orig);
  fs.rename(temp, dest, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ filename: orig });
  });
});

// List
app.get('/videos/list', (req, res) => {
  fs.readdir(videosDir, (e, files) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ videos: files.filter(f => /\.webm$/i.test(f)) });
  });
});

// Pages
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public/control.html')));
app.get('/display/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/display.html')));

// local translation
app.get('/locales/:lng/translation.json', (req, res) => {
  const lng = req.params.lng;
  const filePath = path.join(__dirname, 'locales', lng, 'translation.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(JSON.parse(data));
  });
});

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

server.listen(3000, () => console.log('Listening on 3000'));
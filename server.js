const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('ffprobe');
ffmpeg.setFfmpegPath(ffmpegPath);

// Détection si l'application est exécutée depuis un binaire pkg
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? process.cwd() : __dirname; // Utilisation de process.cwd() si c'est un binaire

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Définition des chemins en utilisant baseDir
const videosDir = path.join(baseDir, 'public/videos');
const uploadsDir = path.join(baseDir, 'uploads');

// Création des dossiers nécessaires
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

// Configuration de Multer
const upload = multer({ dest: uploadsDir });

// Servir les fichiers statiques
app.use('/videos', express.static(videosDir));
app.use(express.static(path.join(baseDir, 'public')));

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



//     //get the total duration of the video with ffprobe
//     // console.log the file sended
//     //rename temp file to the original name
//     console.log(`Fichier temporaire : ${temp}`);
//     console.log(`Fichier original : ${orig}`);
//     const ext = path.extname(orig).toLowerCase();
//     if (ext === '.mp4') {
//       console.log('Fichier MP4 détecté, renommage en WebM');
//     fs.rename(temp, path.join(uploadsDir, orig), err => {
//       if (err) {
//         console.error('Erreur lors du renommage du fichier temporaire :', err);
//         return res.status(500).json({ error: 'Erreur lors du renommage du fichier temporaire' });
//       }
//       console.log(`Fichier temporaire renommé : ${orig}`);
//     }
//     );
//     const temp = path.join(uploadsDir, orig);

//     ffprobe(temp, (err, data) => {
//       if (err) {
//         console.error('Erreur lors de la récupération des informations du fichier :', err);
//         return res.status(500).json({ error: 'Erreur lors de la récupération des informations du fichier' });
//       }
//       const duration = data.format.duration;
//       console.log(`Durée totale de la vidéo : ${duration} secondes`);
//     });

//     // Conversion vers WebM intégrale
//     res.json({ filename: outputName });

//     ffmpeg()
//       .input(temp)
//       .inputOptions([
//       '-probesize', '50M',
//       '-analyzeduration', '100M'
//       ])
//       .format('webm')
//       .videoCodec('libvpx')
//       .audioCodec('libvorbis')
//       .outputOptions([
//       '-b:v', '1M',
//       '-auto-alt-ref', '0',
//       '-pix_fmt', 'yuv420p',
//       '-movflags', '+faststart'
//       ])
//       .on('start', cmd => console.log('FFmpeg démarré :', cmd))
//       .on('progress', prog => {

//       const percent = (timemarkToSeconds(prog.timemark) / duration ) * 100;
      
//       console.log(`Progression de la conversion : ${percent}%`);
//       io.to('control').emit(`conversionProgress:${clientId}`, { percent });
//       })
//       .on('end', () => {
//         io.to('control').emit(`conversionDone:${clientId}`, { url: `/videos/${outputName}` });        console.log(`Conversion terminée pour ${outputName}`);
//         fs.unlink(temp, err => {
//           if (err) console.error('Erreur lors de la suppression du fichier temporaire :', err);
//           else console.log('Fichier temporaire supprimé :', temp);
//         });
//       })
//       .on('error', err => {
//         io.to('control').emit(`conversionError:${clientId}`, { message: err.message });
//         console.error(`Erreur de conversion pour ${outputName} :`, err);
//         fs.unlink(temp, err => {
//           if (err) console.error('Erreur lors de la suppression du fichier temporaire :', err);
//           else console.log('Fichier temporaire supprimé :', temp);
//         });
//       })
//       .save(outputPath);
//   }
// });



// Route pour lister les vidéos
app.get('/videos/list', (req, res) => {
  fs.readdir(videosDir, (e, files) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ videos: files.filter(f => /\.webm$/i.test(f)) });
  });
});

// Pages HTML
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

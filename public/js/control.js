const socket = io();
let masterPlayer;
const container = document.getElementById('canvasContainer');
let nextDisplayId = 1;
const frames = {};
const frameBackup = {};
const defaultFrame = { x:0, y:0, width:50, height:50 };
const volumes = {};


// ➤ Variables pour l’upload/conversion
let isUploading = false;
let currentClientId = null;

document.addEventListener('DOMContentLoaded', () => {
  // Initialisation du player
  masterPlayer = videojs('masterVideo', { fluid: false });
  socket.emit('registerControl');
  loadVideoList();
  renderDisplayList();

  // Synchronisation des événements du player
  masterPlayer.on('play',           () => socket.emit('controlEvent', { type: 'play' }));
  masterPlayer.on('pause',          () => socket.emit('controlEvent', { type: 'pause' }));
  masterPlayer.on('seeked',         () => socket.emit('controlEvent', { type: 'seek', time: masterPlayer.currentTime() }));
  masterPlayer.on('loadedmetadata', () => socket.emit('controlEvent', { type: 'load', src: masterPlayer.currentSrc() }));

  // Boutons UI
  document.getElementById('btnAddDisplay').addEventListener('click', addDisplayFrame);
  document.getElementById('btnUpload').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', uploadVideo);

  // Écoute globale des events conversion
  socket.on('conversionError', data => {
    if (data.clientId === currentClientId) {
      showConversionError(data.message);
    }
  });
});


// ==== GESTION DES FRAMES D’AFFICHAGE ====

function addDisplayFrame() {
  const id = nextDisplayId++;
  const frame = document.createElement('div');
  frame.classList.add('display-frame');
  frame.dataset.id = id;
  frame.textContent = id;
  frame.style.left   = defaultFrame.x + '%';
  frame.style.top    = defaultFrame.y + '%';
  frame.style.width  = defaultFrame.width + '%';
  frame.style.height = defaultFrame.height + '%';
  container.appendChild(frame);
  frames[id] = frame;
  setupInteractions(frame);
  renderDisplayList();
  sendFrameUpdate(frame);
  window.open(`/display/${id}`, `display-${id}`, `width=800,height=450`);
}

function setupInteractions(frame) {
  interact(frame)
    .resizable({
      margin: 10,
      edges: { left:true, right:true, bottom:true, top:true },
      listeners: { move: resizeListener },
      modifiers: [
        interact.modifiers.restrictSize({ min:{ width:10, height:10 }, max:{ width:container.clientWidth, height:container.clientHeight } }),
        interact.modifiers.restrictEdges({ outer: container, endOnly: true })
      ],
      inertia: false,
      styleCursor: true
    })
    .draggable({
      listeners: { move: dragMoveListener },
      modifiers: [ interact.modifiers.restrictRect({ restriction: container, endOnly: true }) ],
      inertia: false
    });
}

function renderDisplayList() {
  const ul = document.getElementById('displayList');
  ul.innerHTML = '';
  Object.keys(frames).forEach(id => {
    const frame = frames[id];
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';

    // Toggle visible
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = frame.style.width !== '0%' && frame.style.height !== '0%';
    chk.addEventListener('change', () => toggleDisplay(id, chk.checked));
    li.appendChild(chk);

    // Label
    const span = document.createElement('span');
    span.textContent = `Display ${id}`;
    li.appendChild(span);

    // Mute & volume
    const lblMute = document.createElement('span');
    lblMute.textContent = 'Mute';
    lblMute.classList.add('ms-2');
    li.appendChild(lblMute);

    const chkMute = document.createElement('input');
    chkMute.type = 'checkbox'; chkMute.checked = true; chkMute.classList.add('ms-2');
    chkMute.addEventListener('change', () => toggleMute(id, chkMute.checked, sliderVolume));
    li.appendChild(chkMute);

    const sliderVolume = document.createElement('input');
    sliderVolume.type = 'range'; sliderVolume.min = 0; sliderVolume.max = 1; sliderVolume.step = 0.01;
    sliderVolume.value = 1; sliderVolume.style.width = '100px'; sliderVolume.classList.add('ms-2');
    sliderVolume.style.display = 'none';
    sliderVolume.addEventListener('input', () => changeVolume(id, sliderVolume.value));
    li.appendChild(sliderVolume);

    // Reset & Delete
    const btnGroup = document.createElement('div');
    const btnReset = document.createElement('button');
    btnReset.className = 'btn btn-sm btn-secondary me-2';
    btnReset.textContent = 'Reset';
    btnReset.addEventListener('click', () => resetDisplay(id));
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-sm btn-danger';
    btnDelete.textContent = 'Delete';
    btnDelete.addEventListener('click', () => deleteDisplay(id));
    btnGroup.append(btnReset, btnDelete);
    li.appendChild(btnGroup);

    ul.appendChild(li);
  });
}

function toggleDisplay(id, visible) {
  const frame = frames[id];
  if (visible) {
    const b = frameBackup[id] || defaultFrame;
    frame.style.left   = b.x + '%';
    frame.style.top    = b.y + '%';
    frame.style.width  = b.width + '%';
    frame.style.height = b.height + '%';
    delete frameBackup[id];
  } else {
    frameBackup[id] = {
      x: parseFloat(frame.style.left),
      y: parseFloat(frame.style.top),
      width: parseFloat(frame.style.width),
      height: parseFloat(frame.style.height)
    };
    frame.style.left = '0%'; frame.style.top = '0%'; frame.style.width = '0%'; frame.style.height = '0%';
  }
  sendFrameUpdate(frame);
}

function resetDisplay(id) {
  const frame = frames[id];
  frame.style.left   = defaultFrame.x + '%';
  frame.style.top    = defaultFrame.y + '%';
  frame.style.width  = defaultFrame.width + '%';
  frame.style.height = defaultFrame.height + '%';
  delete frameBackup[id];
  renderDisplayList();
  sendFrameUpdate(frame);
}

function deleteDisplay(id) {
  frames[id].remove();
  delete frames[id];
  delete frameBackup[id];
  renderDisplayList();
  socket.emit('frameDelete', { id });
}

function dragMoveListener(event) {
  const el = event.target;
  const cr = container.getBoundingClientRect();
  const leftPct = ((parseFloat(el.style.left)/100)*cr.width + event.dx) / cr.width * 100;
  const topPct  = ((parseFloat(el.style.top)/100)*cr.height + event.dy) / cr.height * 100;
  el.style.left = `${Math.max(0, Math.min(leftPct, 100 - parseFloat(el.style.width)))}%`;
  el.style.top  = `${Math.max(0, Math.min(topPct, 100 - parseFloat(el.style.height)))}%`;
  sendFrameUpdate(el);
}

function resizeListener(event) {
  const el = event.target;
  const cr = container.getBoundingClientRect();
  const r = event.rect;
  let wPct = r.width / cr.width * 100;
  let hPct = r.height / cr.height * 100;
  const xPct = (r.left - cr.left) / cr.width * 100;
  const yPct = (r.top  - cr.top)  / cr.height * 100;
  wPct = Math.min(wPct, 100 - xPct);
  hPct = Math.min(hPct, 100 - yPct);
  el.style.left   = `${xPct}%`;
  el.style.top    = `${yPct}%`;
  el.style.width  = `${wPct}%`;
  el.style.height = `${hPct}%`;
  sendFrameUpdate(el);
}

function toggleMute(id, muted, slider) {
  slider.style.display = muted ? 'none' : 'inline-block';
  socket.emit('controlEvent', { type: 'mute', muted, id });
}

function changeVolume(id, volume) {
  volumes[id] = volume;
  socket.emit('controlEvent', { type: 'volume', volume, id });
}

function sendFrameUpdate(el) {
  const id = parseInt(el.dataset.id, 10);
  socket.emit('frameUpdate', {
    id,
    x: parseFloat(el.style.left),
    y: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height)
  });
}


// ==== VIDEO LIST ====

function loadVideoList() {
  fetch('/videos/list')
    .then(res => res.json())
    .then(({ videos }) => {
      const ul = document.getElementById('videoList');
      ul.innerHTML = '';
      videos.forEach(name => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';
        li.textContent = name;
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary ms-2';
        btn.textContent = 'Play';
        btn.addEventListener('click', () => {
          masterPlayer.src({ type: 'video/webm', src: `/videos/${name}` });
          masterPlayer.play();
          socket.emit('controlEvent', { type: 'load', src: `/videos/${name}` });
        });
        li.appendChild(btn);
        ul.appendChild(li);
      });
    })
    .catch(console.error);
}


// ==== UPLOAD & CONVERSION ====

function uploadVideo() {
  showUploadToast();
  const file = document.getElementById('fileInput').files[0];
  if (!file) {document.getElementById('fileInput').value = ''; return; }
  const form = new FormData(); form.append('video', file);
  fetch('/upload', { method: 'POST', body: form }).then(finishUpload);
}


function showUploadToast(clientId) {
  const html = `
    <div class="toast show" style="position:fixed; top:4rem; right:1rem; z-index:9999;">
      <div class="toast-body d-flex align-items-center">
        <img src="/assets/loading.gif" alt="Loading" style="width:24px; height:24px; margin-right:10px;">
        <span data-i18n="convert.text">Uploading en cours, cela peut prendre jusqu'à 10 minutes selon la taille de la vidéo (ou plus)</span>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}


function finishUpload() {
  loadVideoList();                        
  const toast = document.querySelector('.toast.show');
  if (toast) toast.remove();
  isUploading = false;
  document.getElementById('btnUpload').disabled = false;
}

// ==== i18n TOAST ====

$(document).ready(function() {
  $('#languageSwitcher').on('change', function() {
    const lang = $(this).val();
    i18next.changeLanguage(lang, function(err, t) {
      if (!err) {
        $('body').localize();
        const msg = lang === 'fr'
          ? 'Langue changée : Français'
          : lang === 'en'
            ? 'Language changed: English'
            : 'Language changed : ' + lang;
        showToast(msg);
      }
    });
  });
});

function showToast(message) {
  const html = `
    <div class="toast align-items-center text-white bg-primary border-0"
         role="alert" aria-live="assertive" aria-atomic="true"
         style="position:absolute; top:4rem; right:1rem; z-index:9999;">
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto"
                data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    </div>`;
  const $t = $(html);
  $('body').append($t);
  new bootstrap.Toast($t[0]).show();
  $t.on('hidden.bs.toast', () => $t.remove());
}

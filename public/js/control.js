const socket = io();
let masterPlayer;
const container = document.getElementById('canvasContainer');
let nextDisplayId = 1;
const frames = {};
const frameBackup = {};
const defaultFrame = { x:0, y:0, width:50, height:50 };
const volumes = {};
const layoutList = document.getElementById('layoutList');


function t(key, fallback, options = {}) {
  if (window.i18next && typeof i18next.t === 'function') {
    return i18next.t(key, { defaultValue: fallback, ...options });
  }
  return fallback || key;
}


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
  const btnSaveLayout = document.getElementById('btnSaveLayout');
  const btnImportLayout = document.getElementById('btnImportLayout');
  const layoutImportInput = document.getElementById('layoutImportInput');
  if (btnSaveLayout) btnSaveLayout.addEventListener('click', saveLayout);
  if (btnImportLayout && layoutImportInput) {
    btnImportLayout.addEventListener('click', () => layoutImportInput.click());
    layoutImportInput.addEventListener('change', importLayout);
  }
  loadLayoutList();
  initApiConfigModal();

  // Écoute globale des events conversion
  socket.on('conversionError', data => {
    if (data.clientId === currentClientId) {
      showConversionError(data.message);
    }
  });
});


// ==== GESTION DES FRAMES D’AFFICHAGE ====

function createDisplayFrame(options = {}) {
  const parsedId = Number.parseInt(options.id, 10);
  const frameId = Number.isFinite(parsedId) ? parsedId : nextDisplayId++;
  if (Number.isFinite(parsedId)) {
    nextDisplayId = Math.max(nextDisplayId, frameId + 1);
  }

  const frame = document.createElement('div');
  frame.classList.add('display-frame');
  frame.dataset.id = frameId;
  frame.textContent = frameId;

  const left = Number.isFinite(parseFloat(options.x)) ? parseFloat(options.x) : defaultFrame.x;
  const top = Number.isFinite(parseFloat(options.y)) ? parseFloat(options.y) : defaultFrame.y;
  const width = Number.isFinite(parseFloat(options.width)) ? parseFloat(options.width) : defaultFrame.width;
  const height = Number.isFinite(parseFloat(options.height)) ? parseFloat(options.height) : defaultFrame.height;

  frame.style.left = `${left}%`;
  frame.style.top = `${top}%`;
  frame.style.width = `${width}%`;
  frame.style.height = `${height}%`;

  container.appendChild(frame);
  frames[frameId] = frame;
  setupInteractions(frame);

  if (options.openWindow) {
    window.open(`/display/${frameId}`, `display-${frameId}`, `width=800,height=450`);
  }

  return frame;
}

function addDisplayFrame() {
  const frame = createDisplayFrame({ openWindow: true });
  renderDisplayList();
  sendFrameUpdate(frame);
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
    li.className = 'list-group-item';

    const row1 = document.createElement('div');
    row1.className = 'd-flex justify-content-between';

    const row2 = document.createElement('div');
    row2.className = 'd-flex justify-content-between align-items-center';

    const row3 = document.createElement('div');
    row3.className = 'd-flex justify-content-between align-items-center';

    // Screen Label
    const span = document.createElement('span');
    span.textContent = t('display.item', `Display ${id}`, { id });
    row1.appendChild(span);

    // Edit label + toggle visible (inline, sans marge)
    const editWrapper = document.createElement('div');
    editWrapper.className = 'd-flex align-items-center';
    const editLabel = document.createElement('label');
    editLabel.textContent = t('display.edit', 'Edit');
    editLabel.style.marginRight = '4px';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = frame.style.width !== '0%' && frame.style.height !== '0%';
    chk.addEventListener('change', () => toggleDisplay(id, chk.checked));
    editWrapper.append(editLabel, chk);
    row2.appendChild(editWrapper);

    // Mute + volume slider collés
    const muteWrapper = document.createElement('div');
    muteWrapper.className = 'd-flex align-items-center';
    const lblMute = document.createElement('label');
    lblMute.textContent = t('display.mute', 'Mute');
    lblMute.style.marginRight = '4px';
    const chkMute = document.createElement('input');
    chkMute.type = 'checkbox';
    chkMute.checked = true;
    chkMute.addEventListener('change', () => {
      toggleMute(id, chkMute.checked, sliderVolume);
    });

    const sliderVolume = document.createElement('input');
    sliderVolume.type = 'range';
    sliderVolume.min = 0;
    sliderVolume.max = 1;
    sliderVolume.step = 0.01;
    sliderVolume.value = 1;
    sliderVolume.style.width = '100px';
    sliderVolume.style.marginLeft = '4px';  // réduit l’espace
    sliderVolume.style.display = 'none';
    sliderVolume.addEventListener('input', () => changeVolume(id, sliderVolume.value));

    muteWrapper.append(lblMute, chkMute, sliderVolume);
    row2.appendChild(muteWrapper);

    // Brightness control (inline)
    const brightWrapper = document.createElement('div');
    brightWrapper.className = 'd-flex align-items-center';
    const lblBrightness = document.createElement('label');
    lblBrightness.textContent = t('display.brightness', 'Brightness');
    lblBrightness.style.marginRight = '4px';
    const sliderBrightness = document.createElement('input');
    sliderBrightness.type = 'range';
    sliderBrightness.min = 0;
    sliderBrightness.max = 1;
    sliderBrightness.step = 0.01;
    sliderBrightness.value = 1;
    sliderBrightness.style.width = '100px';
    sliderBrightness.addEventListener('input', () => {
      const brightness = sliderBrightness.value;
      frame.style.filter = `brightness(${brightness})`;
      socket.emit('controlEvent', { type: 'brightness', brightness, id });
    });
    brightWrapper.append(lblBrightness, sliderBrightness);
    row3.appendChild(brightWrapper);

    // Reset & Delete buttons
    const btnGroup = document.createElement('div');
    const btnReset = document.createElement('button');
    btnReset.className = 'btn btn-sm btn-secondary me-2';
    btnReset.textContent = t('display.reset', 'Reset');
    btnReset.addEventListener('click', () => resetDisplay(id));
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-sm btn-danger';
    btnDelete.textContent = t('display.delete', 'Delete');
    btnDelete.addEventListener('click', () => deleteDisplay(id));
    btnGroup.append(btnReset, btnDelete);
    row3.appendChild(btnGroup);

    li.append(row1, row2, row3);
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

function changeBrightness(id, brightness) {
  socket.emit('controlEvent', { type: 'brightness', brightness, id });
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


// ==== LAYOUTS ====

function captureLayoutFrames() {
  return Object.values(frames).map(frame => ({
    id: parseInt(frame.dataset.id, 10),
    x: parseFloat(frame.style.left),
    y: parseFloat(frame.style.top),
    width: parseFloat(frame.style.width),
    height: parseFloat(frame.style.height)
  }));
}

function defaultLayoutName() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `layout-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function saveLayout() {
  const framesData = captureLayoutFrames();
  if (!framesData.length) {
    showToast('Aucun display à sauvegarder');
    return;
  }
  const name = window.prompt(t('layout.promptName', 'Layout name'), defaultLayoutName());
  if (!name) return;
  fetch('/layouts/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, frames: framesData })
  })
    .then(res => {
      if (!res.ok) throw new Error('save failed');
      return res.json();
    })
    .then(() => {
      loadLayoutList();
      showToast('Layout sauvegardé');
    })
    .catch(console.error);
}

function importLayout(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const name = (data && data.name) || file.name.replace(/\.json$/i, '') || defaultLayoutName();
      const framesData = Array.isArray(data.frames) ? data.frames : [];
      if (!framesData.length) {
        showToast(t('layout.invalidFile', 'Invalid layout file'));
        return;
      }
      fetch('/layouts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, frames: framesData })
      })
        .then(res => {
          if (!res.ok) throw new Error('import failed');
          return res.json();
        })
        .then(() => {
          loadLayoutList();
          showToast('Layout importé');
        })
        .catch(console.error);
    } catch (err) {
      console.error(err);
      showToast(t('layout.readError', 'Unable to read layout'));
    }
  };
  reader.readAsText(file);
}

function loadLayoutList() {
  if (!layoutList) return;
  fetch('/layouts/list')
    .then(res => {
      if (!res.ok) throw new Error('list failed');
      return res.json();
    })
    .then(({ layouts }) => renderLayoutList(layouts || []))
    .catch(console.error);
}

function renderLayoutList(layouts) {
  if (!layoutList) return;
  layoutList.innerHTML = '';
  if (!layouts.length) {
    const empty = document.createElement('li');
    empty.className = 'list-group-item text-body-secondary';
    empty.textContent = 'Aucun layout sauvegardé';
    layoutList.appendChild(empty);
    return;
  }
  layouts.forEach(layout => {
    const li = document.createElement('li');
    li.className = 'list-group-item layout-item';

    const title = document.createElement('div');
    title.className = 'layout-title';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'layout-name';
    const name = layout.name || layout.id;
    nameSpan.textContent = name;
    nameSpan.title = name;

    const idSpan = document.createElement('span');
    idSpan.className = 'layout-id';
    idSpan.textContent = layout.id ? `ID: ${layout.id}` : '';

    title.append(nameSpan, idSpan);

    const actions = document.createElement('div');
    actions.className = 'layout-actions';

    const btnLoad = document.createElement('button');
    btnLoad.className = 'btn btn-sm btn-primary';
    btnLoad.textContent = t('layout.load', 'Load');
    btnLoad.addEventListener('click', () => loadLayout(layout.id));

    const btnExport = document.createElement('button');
    btnExport.className = 'btn btn-sm btn-secondary';
    btnExport.textContent = t('layout.export', 'Export');
    btnExport.addEventListener('click', () => exportLayout(layout.id));

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-sm btn-danger';
    btnDelete.textContent = t('display.delete', 'Delete');
    btnDelete.addEventListener('click', () => deleteLayout(layout.id));

    actions.append(btnLoad, btnExport, btnDelete);
    li.append(title, actions);
    layoutList.appendChild(li);
  });
}

function loadLayout(id) {
  fetch(`/layouts/${encodeURIComponent(id)}`)
    .then(res => {
      if (!res.ok) throw new Error('load failed');
      return res.json();
    })
    .then(layout => applyLayout(layout))
    .catch(console.error);
}

function applyLayout(layout) {
  const layoutFrames = Array.isArray(layout.frames) ? layout.frames : [];
  if (!layoutFrames.length) {
    showToast(t('layout.emptyLayout', 'Empty layout'));
    return;
  }
  Object.values(frames).forEach(frame => frame.remove());
  Object.keys(frames).forEach(key => delete frames[key]);
  Object.keys(frameBackup).forEach(key => delete frameBackup[key]);

  let maxId = 0;
  layoutFrames.forEach(item => {
    const frame = createDisplayFrame({
      id: item.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      openWindow: true
    });
    maxId = Math.max(maxId, parseInt(frame.dataset.id, 10));
    sendFrameUpdate(frame);
  });
  nextDisplayId = Math.max(nextDisplayId, maxId + 1);
  renderDisplayList();
}

function exportLayout(id) {
  window.location.href = `/layouts/export/${encodeURIComponent(id)}`;
}

function deleteLayout(id) {
  fetch(`/layouts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(res => {
      if (!res.ok) throw new Error('delete failed');
      loadLayoutList();
    })
    .catch(console.error);
}


// ==== API CONFIG ====

let apiConfigModal = null;
const apiStorageKeys = {
  token: 'dmxApiToken'
};

function getStoredValue(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (err) {
    return '';
  }
}

function setStoredValue(key, value) {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch (err) {
    // ignore storage issues
  }
}

function initApiConfigModal() {
  const modalEl = document.getElementById('apiConfigModal');
  const btnOpen = document.getElementById('btnApiConfig');
  const btnSave = document.getElementById('apiSaveBtn');
  const btnGenerate = document.getElementById('apiGenerateToken');
  const btnCopy = document.getElementById('apiCopyToken');
  const apiEnabled = document.getElementById('apiEnabled');
  const tokenInput = document.getElementById('apiToken');

  if (modalEl && typeof bootstrap !== 'undefined') {
    apiConfigModal = new bootstrap.Modal(modalEl);
  }

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      if (tokenInput && !tokenInput.value) {
        tokenInput.value = getStoredValue(apiStorageKeys.token);
      }
      loadApiConfig();
      if (apiConfigModal) apiConfigModal.show();
    });
  }

  if (btnSave) btnSave.addEventListener('click', saveApiConfig);
  if (btnGenerate) btnGenerate.addEventListener('click', generateApiToken);
  if (btnCopy) btnCopy.addEventListener('click', copyApiToken);
  if (apiEnabled) apiEnabled.addEventListener('change', updateApiTokenState);
  if (tokenInput) tokenInput.addEventListener('input', () => setStoredValue(apiStorageKeys.token, tokenInput.value.trim()));

  updateApiTokenState();
}

function updateApiTokenState() {
  const apiEnabled = document.getElementById('apiEnabled');
  const tokenInput = document.getElementById('apiToken');
  if (!apiEnabled || !tokenInput) return;
  tokenInput.placeholder = apiEnabled.checked ? 'token requis' : 'token optionnel';
}

function loadApiConfig() {
  fetch('/api/config')
    .then(res => res.json())
    .then(config => {
      const apiEnabled = document.getElementById('apiEnabled');
      const tokenInput = document.getElementById('apiToken');
      const tokenHint = document.getElementById('apiTokenHint');

      if (apiEnabled) apiEnabled.checked = Boolean(config.enabled);
      if (tokenInput && typeof config.token === 'string') {
        tokenInput.value = config.token;
        setStoredValue(apiStorageKeys.token, config.token);
      }
      if (tokenHint) {
        tokenHint.textContent = '';
      }
      updateApiTokenState();
    })
    .catch(console.error);
}

function saveApiConfig() {
  const apiEnabled = document.getElementById('apiEnabled');
  const tokenInput = document.getElementById('apiToken');

  if (!apiEnabled || !tokenInput) return;
  const enabled = Boolean(apiEnabled.checked);
  const token = tokenInput.value.trim();

  if (enabled && !token) {
    showToast(t('api.tokenRequired', 'Token required to enable API'));
    return;
  }

  fetch('/api/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ enabled, token })
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'save failed');
      return data;
    })
    .then(data => {
      if (tokenInput && data.token) tokenInput.value = data.token;
      setStoredValue(apiStorageKeys.token, data.token || token);
      showToast(t('api.updated', 'API updated'));
      loadApiConfig();
    })
    .catch(err => {
      console.error(err);
      showToast(t('api.saveError', 'API save error'));
    });
}

function generateApiToken() {
  const tokenInput = document.getElementById('apiToken');
  if (!tokenInput) return;
  let token = '';
  if (window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  tokenInput.value = token;
  setStoredValue(apiStorageKeys.token, token);
}

function copyApiToken() {
  const tokenInput = document.getElementById('apiToken');
  if (!tokenInput || !tokenInput.value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(tokenInput.value).then(() => {
      showToast(t('api.tokenCopied', 'Token copied'));
    });
  } else {
    tokenInput.select();
    document.execCommand('copy');
    showToast(t('api.tokenCopied', 'Token copied'));
  }
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
        li.className = 'list-group-item video-item';

        const title = document.createElement('span');
        title.className = 'video-title';
        title.textContent = name;
        title.title = name;

        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary ms-2 video-play-btn';
        btn.textContent = t('video.play', 'Play');
        btn.addEventListener('click', () => {
          masterPlayer.src({ type: 'video/webm', src: `/videos/${name}` });
          masterPlayer.play();
          socket.emit('controlEvent', { type: 'load', src: `/videos/${name}` });
        });

        li.append(title, btn);
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
        <span data-i18n="convert.text">Uploading en cours, cela peut prendre un certain temps</span>
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
        loadVideoList();
        renderDisplayList();
        loadLayoutList();
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

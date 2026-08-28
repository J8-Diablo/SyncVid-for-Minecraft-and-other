const socket = io();
let masterPlayer;
const container = document.getElementById('canvasContainer');
let nextDisplayId = 1;
const frames = {};
const frameBackup = {};
const defaultFrame = { x:0, y:0, width:50, height:50 };
const volumes = {};
const layoutList = document.getElementById('layoutList');
const connectedDisplays = {};
const displayPings = {};
const deletedDisplayIds = new Set();
const PING_INTERVAL_MS = 3000;

// subScreens per panel id, kept in sync with the frame payloads sent to the server.
const subScreensByFrame = {};
const nextSubScreenIdByFrame = {};
let subScreensModal = null;
let subScreensEditingFrameId = null;

function getSubScreens(frameId) {
  const key = String(frameId);
  if (!subScreensByFrame[key]) subScreensByFrame[key] = [];
  return subScreensByFrame[key];
}

function setSubScreens(frameId, list) {
  subScreensByFrame[String(frameId)] = Array.isArray(list) ? list : [];
}

function nextSubScreenId(frameId) {
  const key = String(frameId);
  const current = nextSubScreenIdByFrame[key] || 1;
  nextSubScreenIdByFrame[key] = current + 1;
  return current;
}
let streamUrlInput = null;
let streamTypeSelect = null;
let activeStreamMode = 'file';
let activeStreamUrl = '';
let whepSession = null;
const streamStorageKeys = {
  url: 'syncvidStreamUrl',
  type: 'syncvidStreamType'
};


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
  initStreamControls();
  loadVideoList();
  renderDisplayList();
  updatePlayPauseButton(!masterPlayer.paused());

  // Synchronisation des événements du player
  masterPlayer.on('play',           () => {
    updatePlayPauseButton(true);
    socket.emit('controlEvent', { type: 'play' });
  });
  masterPlayer.on('pause',          () => {
    updatePlayPauseButton(false);
    socket.emit('controlEvent', { type: 'pause' });
  });
  masterPlayer.on('seeked',         () => socket.emit('controlEvent', { type: 'seek', time: masterPlayer.currentTime() }));
  masterPlayer.on('loadedmetadata', () => {
    const src = masterPlayer.currentSrc();
    if (!src) return;
    const mime = guessStreamType(src);
    setActiveStreamUrl(src);
    socket.emit('controlEvent', { type: 'load', src, mime: mime || undefined, mode: activeStreamMode });
  });

  // Boutons UI
  document.getElementById('btnAddDisplay').addEventListener('click', addDisplayFrame);
  document.getElementById('btnUpload').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', uploadVideo);
  const btnPlayPause = document.getElementById('btnPlayPause');
  const btnResync = document.getElementById('btnResync');
  const btnSaveLayout = document.getElementById('btnSaveLayout');
  const btnImportLayout = document.getElementById('btnImportLayout');
  const layoutImportInput = document.getElementById('layoutImportInput');
  if (btnPlayPause) btnPlayPause.addEventListener('click', togglePlayPause);
  if (btnResync) btnResync.addEventListener('click', resyncAll);
  if (btnSaveLayout) btnSaveLayout.addEventListener('click', saveLayout);
  if (btnImportLayout && layoutImportInput) {
    btnImportLayout.addEventListener('click', () => layoutImportInput.click());
    layoutImportInput.addEventListener('change', importLayout);
  }
  loadLayoutList();
  initApiConfigModal();
  initSubScreensModal();
  initCalibrationModal();

  // Écoute globale des events conversion
  socket.on('conversionError', data => {
    if (data.clientId === currentClientId) {
      showConversionError(data.message);
    }
  });

  // Receive frame updates broadcast by the server when ANOTHER control
  // (e.g., the sub-screen editor window) modifies a frame. Keep our local
  // sub-screen cache in sync so "Save layout" picks up those edits.
  socket.on('frameUpdate', frame => {
    if (!frame || frame.id === undefined) return;
    const id = parseInt(frame.id, 10);
    if (!Number.isFinite(id)) return;
    if (Array.isArray(frame.subScreens)) {
      setSubScreens(id, frame.subScreens);
      // Bump the local next-id counter past what's been received
      let maxSub = 0;
      frame.subScreens.forEach(s => {
        const sid = parseInt(s.id, 10);
        if (Number.isFinite(sid)) maxSub = Math.max(maxSub, sid);
      });
      nextSubScreenIdByFrame[String(id)] = maxSub + 1;
    }
    // Also reflect any position/size change on the master canvas frame element
    const frameEl = frames[id];
    if (frameEl) {
      const x = parseFloat(frame.x);
      const y = parseFloat(frame.y);
      const w = parseFloat(frame.width);
      const h = parseFloat(frame.height);
      if (Number.isFinite(x)) frameEl.style.left = `${x}%`;
      if (Number.isFinite(y)) frameEl.style.top = `${y}%`;
      if (Number.isFinite(w)) frameEl.style.width = `${w}%`;
      if (Number.isFinite(h)) frameEl.style.height = `${h}%`;
    }
  });

  socket.on('updateDisplays', list => {
    const seen = new Set();
    const newlyArrived = [];
    (list || []).forEach(d => {
      if (!d || d.id === undefined || d.id === null) return;
      const key = String(d.id);
      const wasConnected = Object.prototype.hasOwnProperty.call(connectedDisplays, key);
      seen.add(key);
      connectedDisplays[key] = { ...connectedDisplays[key], ...d };
      if (!wasConnected) newlyArrived.push(parseInt(d.id, 10));
    });
    Object.keys(connectedDisplays).forEach(key => {
      if (!seen.has(key)) {
        delete connectedDisplays[key];
        delete displayPings[key];
        // a disconnected id can be auto-created again next time it shows up
        deletedDisplayIds.delete(parseInt(key, 10));
      }
    });
    newlyArrived.forEach(id => {
      if (!Number.isFinite(id)) return;
      if (frames[id]) return;
      if (deletedDisplayIds.has(id)) return;
      const frame = createDisplayFrame({ id, x: 0, y: 0, width: 100, height: 100 });
      sendFrameUpdate(frame);
    });
    renderDisplayList();
  });

  socket.on('displayStatusUpdate', status => {
    if (!status || status.id === undefined || status.id === null) return;
    const key = String(status.id);
    connectedDisplays[key] = { ...connectedDisplays[key], ...status };
    updateDisplayInfoRow(key);
  });

  socket.on('pongFromDisplay', ({ id, ts }) => {
    if (id === undefined || id === null) return;
    const key = String(id);
    if (!displayPings[key]) displayPings[key] = {};
    displayPings[key].rtt = Date.now() - ts;
    displayPings[key].at = Date.now();
    updateDisplayInfoRow(key);
  });

  setInterval(() => {
    Object.keys(connectedDisplays).forEach(key => {
      socket.emit('pingDisplay', { id: Number(key), ts: Date.now() });
    });
  }, PING_INTERVAL_MS);
});


function updatePlayPauseButton(isPlaying) {
  const btn = document.getElementById('btnPlayPause');
  if (!btn) return;
  if (isPlaying) {
    btn.textContent = t('controls.pause', 'Pause');
  } else {
    btn.textContent = t('controls.play', 'Play');
  }
}

function togglePlayPause() {
  if (!masterPlayer) return;
  if (masterPlayer.paused()) {
    masterPlayer.play();
  } else {
    masterPlayer.pause();
  }
}

function resyncAll() {
  if (!masterPlayer) return;
  const payload = {
    src: activeStreamUrl || masterPlayer.currentSrc() || '',
    time: masterPlayer.currentTime() || 0,
    playing: !masterPlayer.paused(),
    frames: captureLayoutFrames(),
    mode: activeStreamMode
  };
  socket.emit('resyncAll', payload);
}

function initStreamControls() {
  streamUrlInput = document.getElementById('streamUrlInput');
  const btnLoadStream = document.getElementById('btnLoadStream');
  streamTypeSelect = document.getElementById('streamType');
  if (streamUrlInput) {
    const saved = getStoredValue(streamStorageKeys.url);
    if (saved) streamUrlInput.value = saved;
    streamUrlInput.addEventListener('input', () => {
      const next = streamUrlInput.value.trim();
      setStoredValue(streamStorageKeys.url, next);
      updateStreamItemLabel(next);
    });
  }
  if (streamTypeSelect) {
    const savedType = getStoredValue(streamStorageKeys.type);
    if (savedType) streamTypeSelect.value = savedType;
    streamTypeSelect.addEventListener('change', () => {
      setStoredValue(streamStorageKeys.type, streamTypeSelect.value);
      updateStreamItemLabel(getStreamUrl());
    });
  }
  if (btnLoadStream) btnLoadStream.addEventListener('click', loadStreamFromInput);
}

function getStreamUrl() {
  if (!streamUrlInput) return '';
  return String(streamUrlInput.value || '').trim();
}

function getStreamType() {
  if (!streamTypeSelect) return 'auto';
  return String(streamTypeSelect.value || 'auto');
}

function guessStreamType(url) {
  const value = String(url || '');
  const hasExt = ext => new RegExp(`\\.${ext}(\\?|#|$)`, 'i').test(value);
  if (hasExt('m3u8')) return 'application/x-mpegURL';
  if (hasExt('mpd')) return 'application/dash+xml';
  if (hasExt('mp4')) return 'video/mp4';
  if (hasExt('webm')) return 'video/webm';
  return '';
}

function isLikelyUnsupportedStream(url) {
  const lower = url.toLowerCase();
  return lower.startsWith('srt://') || lower.startsWith('webrtc://');
}

function updateStreamItemLabel(url) {
  const item = document.querySelector('.stream-item .video-title');
  if (!item) return;
  const existing = item.querySelector('.stream-url');
  if (!url) {
    if (existing) existing.remove();
    return;
  }
  const typeTag = getStreamType() === 'whep' ? 'WebRTC' : getStreamType() === 'rtmp' ? 'RTMP' : '';
  const displayText = typeTag ? `${typeTag}: ${url}` : url;
  if (existing) {
    existing.textContent = displayText;
    existing.title = url;
    return;
  }
  const urlSpan = document.createElement('span');
  urlSpan.className = 'stream-url';
  urlSpan.textContent = displayText;
  urlSpan.title = url;
  item.appendChild(urlSpan);
}

function setActiveStreamMode(mode) {
  activeStreamMode = mode || 'file';
}

function setActiveStreamUrl(url) {
  activeStreamUrl = String(url || '').trim();
}

function loadStreamFromInput() {
  if (!masterPlayer) return;
  const url = getStreamUrl();
  if (!url) {
    showToast(t('stream.missing', 'Enter a stream URL'));
    return;
  }
  setStoredValue(streamStorageKeys.url, url);
  const streamType = getStreamType();
  if (streamType === 'rtmp') {
    stopWhepSession();
    setActiveStreamMode('rtmp');
    showToast(t('stream.rtmpHint', 'OBS must stream to this RTMP URL'));
    fetch('/rtmp/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, listen: true })
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'rtmp start failed');
        return data;
      })
      .then(data => {
        const hlsUrl = data.hlsUrl || '';
        if (!hlsUrl) throw new Error('Missing HLS url');
        setActiveStreamUrl(hlsUrl);
        masterPlayer.src({ src: hlsUrl, type: 'application/x-mpegURL' });
        masterPlayer.play().catch(() => {});
        socket.emit('controlEvent', { type: 'load', src: hlsUrl, mime: 'application/x-mpegURL', mode: 'rtmp' });
      })
      .catch(err => {
        console.error(err);
        showToast(t('stream.rtmpError', 'RTMP start failed'));
      });
    return;
  }
  if (streamType === 'whep') {
    stopWhepSession();
    setActiveStreamMode('whep');
    setActiveStreamUrl(url);
    startWhepSession(url).catch(err => {
      console.error(err);
      showToast(t('stream.whepError', 'WHEP connection failed'));
    });
    socket.emit('controlEvent', { type: 'load', src: url, mode: 'whep' });
    return;
  }
  if (isLikelyUnsupportedStream(url)) {
    showToast(t('stream.unsupported', 'SRT/WebRTC not supported in browsers. Use HLS/MP4/WebM URL.'));
  }
  stopWhepSession();
  setActiveStreamMode('file');
  setActiveStreamUrl(url);
  const type = guessStreamType(url);
  if (type) {
    masterPlayer.src({ src: url, type });
  } else {
    masterPlayer.src({ src: url });
  }
  masterPlayer.play().catch(() => {});
  socket.emit('controlEvent', { type: 'load', src: url, mime: type || undefined, mode: 'file' });
}

function getVideoElement(player) {
  if (!player) return null;
  const root = player.el ? player.el() : null;
  if (!root) return null;
  return root.querySelector('video');
}

function clearVideoElement(videoEl) {
  if (!videoEl) return;
  try {
    videoEl.srcObject = null;
  } catch (err) {
    // ignore
  }
  videoEl.removeAttribute('src');
  videoEl.load();
}

function parseIceServers(linkHeader) {
  if (!linkHeader) return [];
  const servers = [];
  const segments = linkHeader.split(',');
  segments.forEach(segment => {
    const parts = segment.split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const urlPart = parts[0];
    if (!urlPart.startsWith('<') || !urlPart.endsWith('>')) return;
    const rel = parts.find(p => p.toLowerCase() === 'rel=\"ice-server\"' || p.toLowerCase() === 'rel=ice-server');
    if (!rel) return;
    const server = { urls: urlPart.slice(1, -1) };
    parts.slice(1).forEach(param => {
      const [key, rawVal] = param.split('=');
      if (!key || rawVal === undefined) return;
      const value = rawVal.replace(/^\"|\"$/g, '');
      if (key === 'username') server.username = value;
      if (key === 'credential') server.credential = value;
    });
    servers.push(server);
  });
  return servers;
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

// Chrome sizes its jitter buffer from the observed packet arrival jitter. A
// bursty sender (aiortc is single-threaded Python) reads as an unstable
// network, so Chrome inflates the buffer to 1-2 s even on a clean LAN. These
// hints ask it to keep the buffer minimal instead.
function applyLowLatencyPlayout(pc, tag) {
  const applied = [];
  pc.getReceivers().forEach(r => {
    try {
      if ('jitterBufferTarget' in r) {
        r.jitterBufferTarget = 0;
        applied.push('jitterBufferTarget');
      } else if ('playoutDelayHint' in r) {
        r.playoutDelayHint = 0;
        applied.push('playoutDelayHint');
      }
    } catch (err) {
      // not supported in this browser
    }
  });
  console.log(`[whep:${tag}] low-latency playout:`, applied.length ? applied.join(', ') : 'NON SUPPORTE');
}

async function startWhepSession(url) {
  const videoEl = getVideoElement(masterPlayer);
  if (!videoEl) return;
  clearVideoElement(videoEl);
  let iceServers = [];
  try {
    const optionsRes = await fetch(url, { method: 'OPTIONS' });
    iceServers = parseIceServers(optionsRes.headers.get('Link'));
  } catch (err) {
    // ignore options errors
  }
  const pc = new RTCPeerConnection({ iceServers });
  const mediaStream = new MediaStream();
  pc.addEventListener('track', event => {
    if (event.track) mediaStream.addTrack(event.track);
  });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  whepSession = { pc, resourceUrl: null };
  videoEl.srcObject = mediaStream;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      'Accept': 'application/sdp'
    },
    body: pc.localDescription.sdp
  });
  if (!response.ok) {
    throw new Error(`WHEP failed: ${response.status}`);
  }
  const locationHeader = response.headers.get('Location');
  if (locationHeader) {
    try {
      whepSession.resourceUrl = new URL(locationHeader, url).toString();
    } catch (err) {
      whepSession.resourceUrl = locationHeader;
    }
  }
  const answerSdp = await response.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  applyLowLatencyPlayout(pc, 'control');
  videoEl.play().catch(() => {});
}

function stopWhepSession() {
  if (!whepSession) return;
  const session = whepSession;
  whepSession = null;
  try {
    session.pc.getSenders().forEach(sender => {
      if (sender.track) sender.track.stop();
    });
    session.pc.close();
  } catch (err) {
    // ignore close errors
  }
  if (session.resourceUrl) {
    fetch(session.resourceUrl, { method: 'DELETE' }).catch(() => {});
  }
  const videoEl = getVideoElement(masterPlayer);
  clearVideoElement(videoEl);
}


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

    // Status badge in header row
    const statusBadge = document.createElement('span');
    statusBadge.className = 'display-status-badge';
    statusBadge.dataset.role = 'status-badge';
    row1.appendChild(statusBadge);

    // Real-display info row
    const infoRow = document.createElement('div');
    infoRow.className = 'display-info-row';
    infoRow.dataset.role = 'info-row';
    infoRow.dataset.id = id;

    // Command buttons row
    const cmdRow = document.createElement('div');
    cmdRow.className = 'display-cmd-row';

    const btnFullscreen = document.createElement('button');
    btnFullscreen.className = 'btn btn-sm btn-outline-light';
    btnFullscreen.textContent = t('display.fullscreen', 'Fullscreen');
    btnFullscreen.title = t('display.fullscreenTip', 'Toggle fullscreen on this display');
    btnFullscreen.addEventListener('click', () => sendDisplayCommand(id, 'toggleFullscreen'));

    const btnReload = document.createElement('button');
    btnReload.className = 'btn btn-sm btn-outline-light';
    btnReload.textContent = t('display.reload', 'Reload');
    btnReload.title = t('display.reloadTip', 'Reload the display page');
    btnReload.addEventListener('click', () => sendDisplayCommand(id, 'reload'));

    const btnIdentify = document.createElement('button');
    btnIdentify.className = 'btn btn-sm btn-outline-light';
    btnIdentify.textContent = t('display.identify', 'Identify');
    btnIdentify.title = t('display.identifyTip', 'Flash a marker on this display');
    btnIdentify.addEventListener('click', () => sendDisplayCommand(id, 'identify'));

    const btnStats = document.createElement('button');
    btnStats.className = 'btn btn-sm btn-outline-light';
    btnStats.textContent = t('display.stats', 'Stats');
    btnStats.title = t('display.statsTip', 'Toggle stats overlay on display');
    btnStats.addEventListener('click', () => sendDisplayCommand(id, 'stats'));

    const btnSub = document.createElement('button');
    btnSub.className = 'btn btn-sm btn-outline-light';
    btnSub.textContent = t('subscreen.button', 'Sub-screens');
    btnSub.title = t('subscreen.buttonTip', 'Edit sub-screens within this display');
    btnSub.addEventListener('click', () => openSubScreensEditorWindow(id));

    const btnKick = document.createElement('button');
    btnKick.className = 'btn btn-sm btn-danger';
    btnKick.textContent = t('display.kick', 'Kick');
    btnKick.title = t('display.kickTip', 'Disconnect this display (redirect to /kicked)');
    btnKick.addEventListener('click', () => kickDisplay(id));

    const rateWrapper = document.createElement('div');
    rateWrapper.className = 'd-flex align-items-center display-rate';
    const rateLabel = document.createElement('label');
    rateLabel.textContent = t('display.rate', 'Rate');
    rateLabel.style.marginRight = '4px';
    const rateSelect = document.createElement('select');
    rateSelect.className = 'form-select form-select-sm';
    ['0.5', '0.75', '1', '1.25', '1.5', '2'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = `×${v}`;
      if (v === '1') opt.selected = true;
      rateSelect.appendChild(opt);
    });
    rateSelect.addEventListener('change', () => {
      sendDisplayCommand(id, 'playbackRate', parseFloat(rateSelect.value));
    });
    rateWrapper.append(rateLabel, rateSelect);

    cmdRow.append(btnFullscreen, btnReload, btnIdentify, btnStats, btnSub, btnKick, rateWrapper);

    li.append(row1, row2, row3, infoRow, cmdRow);
    ul.appendChild(li);
  });
  Object.keys(connectedDisplays).forEach(updateDisplayInfoRow);
}

function sendDisplayCommand(id, action, value) {
  const payload = { id: Number(id), action };
  if (value !== undefined) payload.value = value;
  socket.emit('displayCommand', payload);
}

function kickDisplay(id) {
  const numericId = parseInt(id, 10);
  if (!Number.isFinite(numericId)) return;
  const promptDefault = '/kicked';
  const url = window.prompt(t('display.kickPrompt', 'Redirect URL'), promptDefault);
  if (url === null) return;
  const target = url.trim() || promptDefault;
  socket.emit('displayCommand', { id: numericId, action: 'kick', url: target });
  deletedDisplayIds.add(numericId);
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '–';
  return digits ? value.toFixed(digits) : String(Math.round(value));
}

function getDisplayStatusLevel(key) {
  const info = connectedDisplays[key];
  if (!info) return 'offline';
  const ping = displayPings[key];
  if (!ping || !Number.isFinite(ping.rtt)) return 'unknown';
  if (ping.rtt > 400) return 'bad';
  if (ping.rtt > 150) return 'warn';
  return 'good';
}

function updateDisplayInfoRow(key) {
  const ul = document.getElementById('displayList');
  if (!ul) return;
  const li = ul.querySelector(`[data-role="info-row"][data-id="${key}"]`);
  if (!li) return;
  const info = connectedDisplays[key];
  const ping = displayPings[key];
  const item = li.closest('.list-group-item');
  const badge = item ? item.querySelector('[data-role="status-badge"]') : null;

  if (!info) {
    li.innerHTML = `<span class="display-info-empty">${t('display.offline', 'Offline')}</span>`;
    if (badge) {
      badge.className = 'display-status-badge offline';
      badge.textContent = t('display.offline', 'Offline');
    }
    return;
  }

  const level = getDisplayStatusLevel(key);
  if (badge) {
    badge.className = `display-status-badge ${level}`;
    const rttText = ping && Number.isFinite(ping.rtt) ? `${ping.rtt} ms` : '…';
    badge.textContent = `● ${rttText}`;
  }

  const win = `${info.width || '?'}×${info.height || '?'}`;
  const scr = info.screenWidth ? `${info.screenWidth}×${info.screenHeight}` : '–';
  const hz = info.refreshRate ? `${info.refreshRate} Hz` : '–';
  const dpr = info.devicePixelRatio ? `×${info.devicePixelRatio}` : '–';
  const fs = info.fullscreen ? '⛶' : '⛶ off';
  const onl = info.online === false ? '⚠ offline' : '';
  const buf = Number.isFinite(info.bufferedEnd) ? `${info.bufferedEnd.toFixed(1)}s` : '–';
  const dropped = info.quality ? `${info.quality.dropped}/${info.quality.total}` : '–';
  const rate = info.playbackRate ? `×${info.playbackRate}` : '×1';
  const mode = info.streamMode || 'file';

  li.innerHTML = `
    <span class="info-cell"><b>${t('display.window', 'Win')}</b> ${win}</span>
    <span class="info-cell"><b>${t('display.screen', 'Screen')}</b> ${scr}</span>
    <span class="info-cell"><b>Hz</b> ${hz}</span>
    <span class="info-cell"><b>DPR</b> ${dpr}</span>
    <span class="info-cell">${fs}</span>
    <span class="info-cell"><b>${t('display.buffer', 'Buf')}</b> ${buf}</span>
    <span class="info-cell"><b>${t('display.dropped', 'Drop')}</b> ${dropped}</span>
    <span class="info-cell"><b>${t('display.rate', 'Rate')}</b> ${rate}</span>
    <span class="info-cell"><b>${t('display.mode', 'Mode')}</b> ${mode}</span>
    ${onl ? `<span class="info-cell info-warn">${onl}</span>` : ''}
  `;
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
  delete subScreensByFrame[String(id)];
  delete nextSubScreenIdByFrame[String(id)];
  const numericId = parseInt(id, 10);
  if (Number.isFinite(numericId)) {
    deletedDisplayIds.add(numericId);
  }
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
    height: parseFloat(el.style.height),
    subScreens: getSubScreens(id)
  });
}

// Throttle frame pushes so slider/colour-picker bursts don't flood socket.io.
const PUSH_THROTTLE_MS = 50;
let pushLastSentAt = 0;
let pushTimer = null;
let pushPendingFrameId = null;

function pushSubScreensUpdate(frameId) {
  pushPendingFrameId = frameId;
  const now = Date.now();
  const elapsed = now - pushLastSentAt;
  if (elapsed >= PUSH_THROTTLE_MS) {
    pushLastSentAt = now;
    const id = pushPendingFrameId;
    pushPendingFrameId = null;
    const el = frames[id];
    if (el) sendFrameUpdate(el);
    return;
  }
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushLastSentAt = Date.now();
    const id = pushPendingFrameId;
    pushPendingFrameId = null;
    const el = frames[id];
    if (el) sendFrameUpdate(el);
  }, PUSH_THROTTLE_MS - elapsed);
}


// ==== LAYOUTS ====

function captureLayoutFrames() {
  return Object.values(frames).map(frame => {
    const id = parseInt(frame.dataset.id, 10);
    return {
      id,
      x: parseFloat(frame.style.left),
      y: parseFloat(frame.style.top),
      width: parseFloat(frame.style.width),
      height: parseFloat(frame.style.height),
      subScreens: getSubScreens(id)
    };
  });
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
    const numericId = parseInt(frame.dataset.id, 10);
    maxId = Math.max(maxId, numericId);
    if (Array.isArray(item.subScreens) && item.subScreens.length) {
      setSubScreens(numericId, item.subScreens.map(s => ({ ...s })));
      let maxSubId = 0;
      item.subScreens.forEach(s => {
        const sid = parseInt(s.id, 10);
        if (Number.isFinite(sid)) maxSubId = Math.max(maxSubId, sid);
      });
      nextSubScreenIdByFrame[String(numericId)] = maxSubId + 1;
    }
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


// ==== SUB-SCREENS EDITOR ====

function initSubScreensModal() {
  const modalEl = document.getElementById('subScreensModal');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  subScreensModal = new bootstrap.Modal(modalEl);
  modalEl.querySelectorAll('[data-add-shape]').forEach(btn => {
    btn.addEventListener('click', () => {
      const shape = btn.getAttribute('data-add-shape') || 'rect';
      addSubScreen(shape);
    });
  });
  const autoBtn = document.getElementById('subScreenAutoCalibrateBtn');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      if (subScreensEditingFrameId === null) return;
      // Hide the sub-screens modal so the calibration modal isn't stacked on top.
      if (subScreensModal) subScreensModal.hide();
      openCalibration(subScreensEditingFrameId);
    });
  }
  const identifyToggle = document.getElementById('subScreenIdentifyToggle');
  if (identifyToggle) {
    identifyToggle.addEventListener('change', () => {
      setIdentifyMode(identifyToggle.checked);
    });
  }
  // Stop identify mode when the modal closes.
  modalEl.addEventListener('hidden.bs.modal', () => {
    if (identifyMode) {
      setIdentifyMode(false);
      const toggle = document.getElementById('subScreenIdentifyToggle');
      if (toggle) toggle.checked = false;
    }
  });
}

function openSubScreensEditor(frameId) {
  subScreensEditingFrameId = frameId;
  editorSelectedSubId = null;
  const label = document.getElementById('subScreensModalLabel');
  if (label) label.textContent = `Display ${frameId}`;
  renderSubScreenList();
  renderSubScreenCanvas();
  if (subScreensModal) subScreensModal.show();
}

function openSubScreensEditorWindow(frameId) {
  // Open the full editor in a dedicated window. The editor talks to the
  // server directly via its own socket.io connection and stays in sync with
  // the control panel through frameUpdate broadcasts.
  const url = `/subscreen-editor?frame=${encodeURIComponent(frameId)}`;
  const features = 'width=1280,height=820,menubar=no,toolbar=no,location=no';
  const win = window.open(url, `subscreen-editor-${frameId}`, features);
  if (win) {
    try { win.focus(); } catch (e) { /* ignore */ }
  }
}

function defaultPolygonPoints() {
  return [[50, 0], [100, 100], [0, 100]];
}

function addSubScreen(shape) {
  if (subScreensEditingFrameId === null) return;
  const list = getSubScreens(subScreensEditingFrameId);
  const newSub = {
    id: nextSubScreenId(subScreensEditingFrameId),
    shape,
    x: 10,
    y: 10,
    width: 30,
    height: 30,
    color: { r: 255, g: 255, b: 255 },
    dimmer: 255,
    points: shape === 'polygon' ? defaultPolygonPoints() : [],
    dmxAddress: null
  };
  list.push(newSub);
  setSubScreens(subScreensEditingFrameId, list);
  renderSubScreenList();
  pushSubScreensUpdate(subScreensEditingFrameId);
}

function deleteSubScreen(subId) {
  if (subScreensEditingFrameId === null) return;
  const list = getSubScreens(subScreensEditingFrameId).filter(s => s.id !== subId);
  setSubScreens(subScreensEditingFrameId, list);
  renderSubScreenList();
  pushSubScreensUpdate(subScreensEditingFrameId);
  renderSubScreenCanvas();
}

function updateSubScreenField(subId, mutator) {
  if (subScreensEditingFrameId === null) return;
  const list = getSubScreens(subScreensEditingFrameId);
  const idx = list.findIndex(s => s.id === subId);
  if (idx < 0) return;
  mutator(list[idx]);
  pushSubScreensUpdate(subScreensEditingFrameId);
}

function rgbToHex(c) {
  const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function hexToRgb(hex) {
  const s = String(hex || '').replace(/^#/, '');
  if (s.length !== 6) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16)
  };
}

function formatPolygonPoints(points) {
  if (!Array.isArray(points)) return '';
  return points.map(p => `${Math.round(p[0])},${Math.round(p[1])}`).join(' ; ');
}

function parsePolygonPoints(text) {
  const parts = String(text || '').split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  parts.forEach(part => {
    const tokens = part.split(/[ ,]+/).map(s => parseFloat(s));
    if (tokens.length >= 2 && Number.isFinite(tokens[0]) && Number.isFinite(tokens[1])) {
      out.push([tokens[0], tokens[1]]);
    }
  });
  return out;
}

// ==== VISUAL EDITOR (SVG canvas) ====
const SVG_NS = 'http://www.w3.org/2000/svg';
let editorSelectedSubId = null;
let editorDragState = null; // { kind: 'sub'|'vertex', subId, vertexIdx?, startX, startY, origValues }
let identifyMode = false;

function renderSubScreenCanvas() {
  const svg = document.getElementById('subScreenCanvas');
  if (!svg || subScreensEditingFrameId === null) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const list = getSubScreens(subScreensEditingFrameId);

  // Background grid
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '100'); bg.setAttribute('height', '100');
  bg.setAttribute('class', 'editor-bg');
  bg.addEventListener('mousedown', evt => { if (evt.target === bg) editorSelectedSubId = null; renderSubScreenCanvas(); });
  svg.appendChild(bg);

  // Grid lines every 10%
  for (let i = 10; i < 100; i += 10) {
    const vl = document.createElementNS(SVG_NS, 'line');
    vl.setAttribute('x1', i); vl.setAttribute('y1', 0);
    vl.setAttribute('x2', i); vl.setAttribute('y2', 100);
    vl.setAttribute('class', 'editor-grid');
    svg.appendChild(vl);
    const hl = document.createElementNS(SVG_NS, 'line');
    hl.setAttribute('x1', 0); hl.setAttribute('y1', i);
    hl.setAttribute('x2', 100); hl.setAttribute('y2', i);
    hl.setAttribute('class', 'editor-grid');
    svg.appendChild(hl);
  }

  // Sub-screens
  list.forEach((sub, idx) => {
    const group = document.createElementNS(SVG_NS, 'g');
    group.dataset.subId = sub.id;
    const isSelected = sub.id === editorSelectedSubId;
    group.classList.add('editor-sub');
    if (isSelected) group.classList.add('selected');

    const hue = (idx * 360 / Math.max(1, list.length)) % 360;
    const fillColor = `hsl(${hue}, 60%, 50%)`;

    // Shape rendering
    let shapeEl;
    const x = sub.x, y = sub.y, w = sub.width, h = sub.height;
    if (sub.shape === 'circle') {
      shapeEl = document.createElementNS(SVG_NS, 'ellipse');
      shapeEl.setAttribute('cx', x + w/2);
      shapeEl.setAttribute('cy', y + h/2);
      shapeEl.setAttribute('rx', w/2);
      shapeEl.setAttribute('ry', h/2);
    } else if (sub.shape === 'triangle') {
      shapeEl = document.createElementNS(SVG_NS, 'polygon');
      shapeEl.setAttribute('points', `${x+w/2},${y} ${x+w},${y+h} ${x},${y+h}`);
    } else if (sub.shape === 'polygon' && Array.isArray(sub.points) && sub.points.length >= 3) {
      shapeEl = document.createElementNS(SVG_NS, 'polygon');
      shapeEl.setAttribute('points', sub.points.map(p => `${x + (p[0]/100)*w},${y + (p[1]/100)*h}`).join(' '));
    } else {
      shapeEl = document.createElementNS(SVG_NS, 'rect');
      shapeEl.setAttribute('x', x); shapeEl.setAttribute('y', y);
      shapeEl.setAttribute('width', w); shapeEl.setAttribute('height', h);
    }
    shapeEl.setAttribute('fill', fillColor);
    shapeEl.setAttribute('fill-opacity', isSelected ? '0.6' : '0.4');
    shapeEl.setAttribute('stroke', isSelected ? '#fff' : '#000');
    shapeEl.setAttribute('stroke-width', isSelected ? '0.6' : '0.25');
    shapeEl.style.cursor = 'move';
    shapeEl.addEventListener('mousedown', evt => {
      evt.preventDefault();
      editorSelectedSubId = sub.id;
      startEditorDrag(evt, { kind: 'sub', subId: sub.id });
    });
    group.appendChild(shapeEl);

    // ID label
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', x + w/2);
    label.setAttribute('y', y + h/2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('class', 'editor-label');
    label.textContent = `#${sub.id}`;
    label.style.pointerEvents = 'none';
    group.appendChild(label);

    // Polygon vertices (only when selected)
    if (isSelected && sub.shape === 'polygon' && Array.isArray(sub.points)) {
      sub.points.forEach((p, vIdx) => {
        const vx = x + (p[0]/100) * w;
        const vy = y + (p[1]/100) * h;
        const vert = document.createElementNS(SVG_NS, 'circle');
        vert.setAttribute('cx', vx);
        vert.setAttribute('cy', vy);
        vert.setAttribute('r', '1.0');
        vert.setAttribute('class', 'editor-vertex');
        vert.addEventListener('mousedown', evt => {
          evt.preventDefault();
          evt.stopPropagation();
          startEditorDrag(evt, { kind: 'vertex', subId: sub.id, vertexIdx: vIdx });
        });
        vert.addEventListener('contextmenu', evt => {
          evt.preventDefault();
          deletePolygonVertex(sub.id, vIdx);
        });
        group.appendChild(vert);
      });
      // Click on a polygon edge to insert a new vertex
      const edges = [];
      for (let i = 0; i < sub.points.length; i++) {
        const next = (i + 1) % sub.points.length;
        const p1 = sub.points[i], p2 = sub.points[next];
        const x1 = x + (p1[0]/100) * w;
        const y1 = y + (p1[1]/100) * h;
        const x2 = x + (p2[0]/100) * w;
        const y2 = y + (p2[1]/100) * h;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x1); line.setAttribute('y1', y1);
        line.setAttribute('x2', x2); line.setAttribute('y2', y2);
        line.setAttribute('class', 'editor-edge');
        line.addEventListener('click', evt => {
          evt.stopPropagation();
          const { x: cx, y: cy } = svgPointFromEvent(evt);
          insertPolygonVertex(sub.id, i, cx, cy);
        });
        group.appendChild(line);
      }
    }

    svg.appendChild(group);
  });
}

function svgPointFromEvent(evt) {
  const svg = document.getElementById('subScreenCanvas');
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const transformed = pt.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

function startEditorDrag(evt, params) {
  const list = getSubScreens(subScreensEditingFrameId);
  const sub = list.find(s => s.id === params.subId);
  if (!sub) return;
  const { x: cx, y: cy } = svgPointFromEvent(evt);
  editorDragState = {
    ...params,
    startCanvasX: cx,
    startCanvasY: cy,
    origSub: JSON.parse(JSON.stringify(sub)),
  };
  document.addEventListener('mousemove', onEditorDragMove);
  document.addEventListener('mouseup', onEditorDragEnd);
}

function onEditorDragMove(evt) {
  if (!editorDragState) return;
  const { x: cx, y: cy } = svgPointFromEvent(evt);
  const dx = cx - editorDragState.startCanvasX;
  const dy = cy - editorDragState.startCanvasY;
  const list = getSubScreens(subScreensEditingFrameId);
  const sub = list.find(s => s.id === editorDragState.subId);
  if (!sub) return;
  if (editorDragState.kind === 'sub') {
    const o = editorDragState.origSub;
    sub.x = Math.max(0, Math.min(100 - o.width, o.x + dx));
    sub.y = Math.max(0, Math.min(100 - o.height, o.y + dy));
  } else if (editorDragState.kind === 'vertex') {
    const o = editorDragState.origSub;
    const oldX = o.x + (o.points[editorDragState.vertexIdx][0]/100) * o.width;
    const oldY = o.y + (o.points[editorDragState.vertexIdx][1]/100) * o.height;
    const newX = oldX + dx;
    const newY = oldY + dy;
    const w = sub.width || 1;
    const h = sub.height || 1;
    const rx = ((newX - sub.x) / w) * 100;
    const ry = ((newY - sub.y) / h) * 100;
    sub.points[editorDragState.vertexIdx] = [
      Math.max(0, Math.min(100, rx)),
      Math.max(0, Math.min(100, ry)),
    ];
  }
  renderSubScreenCanvas();
  pushSubScreensUpdate(subScreensEditingFrameId);
}

function onEditorDragEnd() {
  document.removeEventListener('mousemove', onEditorDragMove);
  document.removeEventListener('mouseup', onEditorDragEnd);
  if (editorDragState) {
    editorDragState = null;
    renderSubScreenList(); // refresh numeric inputs
  }
}

function deletePolygonVertex(subId, vertexIdx) {
  const list = getSubScreens(subScreensEditingFrameId);
  const sub = list.find(s => s.id === subId);
  if (!sub || sub.shape !== 'polygon' || !Array.isArray(sub.points)) return;
  if (sub.points.length <= 3) return; // keep at least a triangle
  sub.points.splice(vertexIdx, 1);
  renderSubScreenCanvas();
  renderSubScreenList();
  pushSubScreensUpdate(subScreensEditingFrameId);
}

function insertPolygonVertex(subId, edgeIdx, canvasX, canvasY) {
  const list = getSubScreens(subScreensEditingFrameId);
  const sub = list.find(s => s.id === subId);
  if (!sub || sub.shape !== 'polygon' || !Array.isArray(sub.points)) return;
  const w = sub.width || 1;
  const h = sub.height || 1;
  const rx = ((canvasX - sub.x) / w) * 100;
  const ry = ((canvasY - sub.y) / h) * 100;
  sub.points.splice(edgeIdx + 1, 0, [
    Math.max(0, Math.min(100, rx)),
    Math.max(0, Math.min(100, ry)),
  ]);
  renderSubScreenCanvas();
  renderSubScreenList();
  pushSubScreensUpdate(subScreensEditingFrameId);
}

function setIdentifyMode(on) {
  identifyMode = !!on;
  if (subScreensEditingFrameId !== null) {
    socket.emit('displayCommand', {
      id: Number(subScreensEditingFrameId),
      action: 'identifyMode',
      value: identifyMode,
    });
  }
}

function renderSubScreenList() {
  const ul = document.getElementById('subScreenList');
  if (!ul || subScreensEditingFrameId === null) return;
  ul.innerHTML = '';
  const list = getSubScreens(subScreensEditingFrameId);
  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'list-group-item text-body-secondary';
    empty.textContent = t('subscreen.empty', 'No sub-screens yet. Use + buttons above.');
    ul.appendChild(empty);
    return;
  }
  list.forEach(sub => {
    const li = document.createElement('li');
    li.className = 'list-group-item subscreen-item';

    const head = document.createElement('div');
    head.className = 'd-flex justify-content-between align-items-center mb-1';
    const title = document.createElement('strong');
    title.textContent = `#${sub.id} — ${sub.shape}`;
    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-sm btn-danger';
    btnDel.textContent = t('display.delete', 'Delete');
    btnDel.addEventListener('click', () => deleteSubScreen(sub.id));
    head.append(title, btnDel);

    const geom = document.createElement('div');
    geom.className = 'subscreen-grid';
    geom.append(
      buildNumberInput('X%', sub.x, v => updateSubScreenField(sub.id, s => { s.x = v; })),
      buildNumberInput('Y%', sub.y, v => updateSubScreenField(sub.id, s => { s.y = v; })),
      buildNumberInput('W%', sub.width, v => updateSubScreenField(sub.id, s => { s.width = v; })),
      buildNumberInput('H%', sub.height, v => updateSubScreenField(sub.id, s => { s.height = v; }))
    );

    const fx = document.createElement('div');
    fx.className = 'subscreen-grid';

    const colorWrap = document.createElement('label');
    colorWrap.className = 'subscreen-field';
    const colorLbl = document.createElement('span');
    colorLbl.textContent = 'Color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = rgbToHex(sub.color || { r: 255, g: 255, b: 255 });
    colorInput.addEventListener('input', () => {
      const rgb = hexToRgb(colorInput.value);
      updateSubScreenField(sub.id, s => { s.color = rgb; });
    });
    colorWrap.append(colorLbl, colorInput);

    const dimWrap = document.createElement('label');
    dimWrap.className = 'subscreen-field';
    const dimLbl = document.createElement('span');
    dimLbl.textContent = `Dim (${sub.dimmer || 0})`;
    const dimInput = document.createElement('input');
    dimInput.type = 'range';
    dimInput.min = 0;
    dimInput.max = 255;
    dimInput.value = sub.dimmer || 0;
    dimInput.addEventListener('input', () => {
      const val = parseInt(dimInput.value, 10);
      dimLbl.textContent = `Dim (${val})`;
      updateSubScreenField(sub.id, s => { s.dimmer = val; });
    });
    dimWrap.append(dimLbl, dimInput);

    const dmxWrap = document.createElement('label');
    dmxWrap.className = 'subscreen-field';
    const dmxLbl = document.createElement('span');
    dmxLbl.textContent = t('subscreen.dmxAddr', 'DMX addr');
    const dmxInput = document.createElement('input');
    dmxInput.type = 'number';
    dmxInput.min = 1;
    dmxInput.max = 512;
    dmxInput.placeholder = '—';
    dmxInput.value = sub.dmxAddress != null ? sub.dmxAddress : '';
    dmxInput.addEventListener('change', () => {
      const v = parseInt(dmxInput.value, 10);
      updateSubScreenField(sub.id, s => { s.dmxAddress = Number.isFinite(v) ? v : null; });
    });
    dmxWrap.append(dmxLbl, dmxInput);

    fx.append(colorWrap, dimWrap, dmxWrap);

    li.append(head, geom, fx);

    if (sub.shape === 'polygon') {
      const polyWrap = document.createElement('div');
      polyWrap.className = 'subscreen-poly';
      const polyLbl = document.createElement('span');
      polyLbl.className = 'small text-body-secondary';
      polyLbl.textContent = t('subscreen.polygonHint', 'Points (% of bbox, format "x,y ; x,y ; …")');
      const polyInput = document.createElement('textarea');
      polyInput.className = 'form-control form-control-sm';
      polyInput.rows = 2;
      polyInput.value = formatPolygonPoints(sub.points);
      polyInput.addEventListener('change', () => {
        const pts = parsePolygonPoints(polyInput.value);
        updateSubScreenField(sub.id, s => { s.points = pts; });
      });
      polyWrap.append(polyLbl, polyInput);
      li.append(polyWrap);
    }

    ul.appendChild(li);
  });
}

function buildNumberInput(label, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'subscreen-field';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.5';
  input.value = Number.isFinite(value) ? value : 0;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  wrap.append(lbl, input);
  return wrap;
}


// ==== AUTO-CALIBRATION (ArUco grid + RGB sequence) ====

let calibModal = null;
let calibStream = null;
let calibTargetFrameId = null;
let calibRunning = false;

// Gray code structured light sequence — the robust primary method.
// Order: long-settle black ref first (lets AE adapt), then white ref, then
// 5 X-axis bit patterns + 5 Y-axis bit patterns. Each Gray bit pattern only
// needs short settle since it's still mostly black/white.
const CALIB_GRAY_BITS_X = 6;
const CALIB_GRAY_BITS_Y = 6;
const CALIB_SEQUENCE = (() => {
  const seq = [];
  seq.push(['black', 1500, 'black']);
  seq.push(['white', 1000, 'white']);
  for (let i = 0; i < CALIB_GRAY_BITS_X; i++) {
    seq.push([`gray_x_${i}`, 500, `gray_x_${i}`]);
  }
  for (let i = 0; i < CALIB_GRAY_BITS_Y; i++) {
    seq.push([`gray_y_${i}`, 500, `gray_y_${i}`]);
  }
  return seq;
})();

function initCalibrationModal() {
  const modalEl = document.getElementById('calibrateModal');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  calibModal = new bootstrap.Modal(modalEl);
  document.getElementById('calibStartCamera').addEventListener('click', startCalibrationCamera);
  document.getElementById('calibRun').addEventListener('click', runCalibrationSequence);
  modalEl.addEventListener('hidden.bs.modal', () => {
    stopCalibrationCamera();
    sendCalibrationPattern(null);
  });
}

function openCalibration(frameId) {
  calibTargetFrameId = frameId;
  setCalibrationStatus('');
  setCalibrationProgress(0);
  document.getElementById('calibRun').disabled = true;
  const label = document.getElementById('calibrateModalLabel');
  if (label) label.textContent = `Display ${frameId}`;
  populateCameraSelect();
  if (calibModal) calibModal.show();
}

function setCalibrationStatus(msg) {
  const el = document.getElementById('calibStatus');
  if (el) el.textContent = msg || '';
}

function setCalibrationProgress(pct) {
  const bar = document.getElementById('calibProgressBar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

async function populateCameraSelect() {
  const select = document.getElementById('calibCameraSelect');
  if (!select) return;
  select.innerHTML = '';
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      devices
        .filter(d => d.kind === 'videoinput')
        .forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Camera ${i + 1}`;
          select.appendChild(opt);
        });
    }
  } catch (err) {
    console.error('enumerateDevices', err);
  }
  if (!select.options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('calibrate.noCamera', 'No camera detected');
    select.appendChild(opt);
  }
}

async function startCalibrationCamera() {
  stopCalibrationCamera();
  const select = document.getElementById('calibCameraSelect');
  const deviceId = select && select.value ? select.value : undefined;
  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  };
  try {
    calibStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('calibVideo');
    video.srcObject = calibStream;
    await video.play();
    populateCameraSelect();
    document.getElementById('calibRun').disabled = false;
    setCalibrationStatus(t('calibrate.cameraReady', 'Camera live. Aim at the panel covering all physical screens, then click "Run calibration".'));
  } catch (err) {
    console.error('getUserMedia', err);
    setCalibrationStatus(`${t('calibrate.cameraError', 'Camera error')}: ${err.message || err.name}`);
  }
}

function stopCalibrationCamera() {
  if (calibStream) {
    calibStream.getTracks().forEach(track => track.stop());
    calibStream = null;
  }
  const video = document.getElementById('calibVideo');
  if (video) video.srcObject = null;
}

function sendCalibrationPattern(pattern) {
  if (calibTargetFrameId === null) return;
  socket.emit('displayCommand', {
    id: Number(calibTargetFrameId),
    action: 'calibrationPattern',
    value: pattern
  });
}

function snapVideoFrame() {
  const video = document.getElementById('calibVideo');
  if (!video || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92));
}

function setCalibrationDebugLink(debugUrl) {
  const link = document.getElementById('calibDebugLink');
  if (!link) return;
  if (debugUrl) {
    link.href = debugUrl;
    link.style.display = 'inline-block';
  } else {
    link.removeAttribute('href');
    link.style.display = 'none';
  }
}

async function runCalibrationSequence() {
  if (calibRunning || calibTargetFrameId === null) return;
  if (!calibStream) {
    setCalibrationStatus(t('calibrate.cameraNotReady', 'Start the camera first'));
    return;
  }
  calibRunning = true;
  document.getElementById('calibRun').disabled = true;
  setCalibrationProgress(0);
  setCalibrationDebugLink(null);

  const fd = new FormData();
  let lastDebugUrl = null;
  try {
    const steps = CALIB_SEQUENCE.length;
    for (let i = 0; i < steps; i++) {
      const [patternName, settleMs, fieldName] = CALIB_SEQUENCE[i];
      setCalibrationStatus(
        `${t('calibrate.showing', 'Showing pattern')} ${patternName} (${i + 1}/${steps})…`
      );
      sendCalibrationPattern(patternName);
      await wait(settleMs);
      const blob = await snapVideoFrame();
      if (!blob) {
        throw new Error('Failed to capture camera frame');
      }
      fd.append(fieldName, blob, `${fieldName}.jpg`);
      setCalibrationProgress(((i + 1) / (steps + 1)) * 100);
    }
    sendCalibrationPattern(null);
    setCalibrationStatus(t('calibrate.detecting', 'Detecting sub-screens…'));

    const res = await fetch('/api/calibrate', { method: 'POST', body: fd });
    const data = await res.json();
    lastDebugUrl = data.debugUrl || null;
    setCalibrationDebugLink(lastDebugUrl);
    if (!res.ok) throw new Error(data.error || 'calibration failed');
    const detected = Array.isArray(data.subScreens) ? data.subScreens : [];
    setCalibrationProgress(100);

    if (!detected.length) {
      setCalibrationStatus(t('calibrate.nothingFound', 'No sub-screens detected. Make sure the panel fills the camera frame and physical screens are visible.'));
      return;
    }

    // Phase 2 — verification — DISABLED in v2 pipeline.
    // The new cell-cluster-first detection already produces deduplicated
    // sub-screens with proper shapes; the verify pass was overwriting
    // those shapes with "rect" and reintroducing duplicates. We keep the
    // server endpoint for backwards-compat but no longer call it.
    let finalSubs = detected;
    let verifyRan = false;
    let verifySplitCount = 0;
    const sessionId = lastDebugUrl
      ? lastDebugUrl.replace(/^\/debug\/calibration\//, '').replace(/\/$/, '')
      : null;
    if (false && sessionId) {
      try {
        setCalibrationStatus(t('calibrate.verifying', 'Verifying screens with colour test…'));
        const colored = detected.map((s, i) => ({
          ...s,
          color: hueToRgb((i * 360 / detected.length) % 360),
        }));
        sendCalibrationPattern({
          type: 'colorMap',
          regions: colored.map(s => ({
            x: s.x, y: s.y, width: s.width, height: s.height, color: s.color,
          })),
        });
        await wait(1500);
        const verifyBlob = await snapVideoFrame();
        // Send the clear twice to mitigate any lost socket.io message
        sendCalibrationPattern(null);
        if (verifyBlob) {
          const vfd = new FormData();
          vfd.append('frame', verifyBlob, 'verify.jpg');
          vfd.append('session_id', sessionId);
          vfd.append('sub_screens', JSON.stringify(colored));
          const vres = await fetch('/api/calibrate/verify', { method: 'POST', body: vfd });
          const vdata = await vres.json();
          if (vres.ok && Array.isArray(vdata.refined) && vdata.refined.length) {
            finalSubs = vdata.refined;
            verifyRan = true;
            verifySplitCount = vdata.splitCount || 0;
          } else if (!vres.ok) {
            console.warn('[calibrate] verify endpoint error:', vdata && vdata.error);
          }
        }
      } catch (verifyErr) {
        console.warn('[calibrate] verification skipped:', verifyErr);
      } finally {
        // Double-send to make sure the colour overlay is gone.
        sendCalibrationPattern(null);
        await wait(150);
        sendCalibrationPattern(null);
      }
    }

    // Apply: either replace existing sub-screens or append to them.
    const appendModeEl = document.getElementById('calibAppendMode');
    const appendMode = !!(appendModeEl && appendModeEl.checked);
    let combined;
    if (appendMode) {
      const existing = getSubScreens(calibTargetFrameId).slice();
      let maxId = 0;
      existing.forEach(s => { if (s.id > maxId) maxId = s.id; });
      const renumbered = finalSubs.map((s, idx) => ({ ...s, id: maxId + idx + 1 }));
      combined = existing.concat(renumbered);
    } else {
      combined = finalSubs.map((s, idx) => ({ ...s, id: idx + 1 }));
    }
    setSubScreens(calibTargetFrameId, combined);
    nextSubScreenIdByFrame[String(calibTargetFrameId)] = combined.length + 1;
    pushSubScreensUpdate(calibTargetFrameId);
    renderSubScreenList();

    // Auto-save as a new layout
    const layoutName = await saveCalibrationLayout();
    let detailInfo = '';
    if (data.method === 'gray-code') {
      detailInfo = ` (Gray code, ${data.brightPixels} bright px)`;
    } else if (data.markersDetected) {
      detailInfo = ` (${data.markersDetected} markers)`;
    }
    let verifyInfo = '';
    if (verifyRan) {
      verifyInfo = `, verify: ${detected.length}→${finalSubs.length}`;
      if (verifySplitCount > 0) verifyInfo += ` (${verifySplitCount} split)`;
    } else {
      verifyInfo = ` [verify skipped]`;
    }
    setCalibrationStatus(
      `${finalSubs.length} ${t('calibrate.found', 'sub-screen(s) detected')}${detailInfo}${verifyInfo}. ${t('calibrate.savedAs', 'Saved as layout')} "${layoutName}".`
    );
    showToast(`${finalSubs.length} ${t('calibrate.applied', 'sub-screen(s) applied')}`);
    if (verifySplitCount > 0) {
      showToast(`${verifySplitCount} ${t('calibrate.split', 'fused screen(s) split')}`);
    }

    if (Array.isArray(data.warnings) && data.warnings.length) {
      console.warn('[calibrate] warnings:', data.warnings);
    }
  } catch (err) {
    console.error('calibrate', err);
    setCalibrationStatus(`${t('calibrate.error', 'Detection failed')}: ${err.message || err}`);
    sendCalibrationPattern(null);
  } finally {
    calibRunning = false;
    document.getElementById('calibRun').disabled = !calibStream;
  }
}

function saveCalibrationLayout() {
  const framesData = captureLayoutFrames();
  if (!framesData.length) return Promise.resolve('(none)');
  const now = new Date();
  const pad = v => String(v).padStart(2, '0');
  const name = `calib-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return fetch('/layouts/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, frames: framesData })
  })
    .then(res => res.ok ? res.json() : Promise.reject(new Error('save failed')))
    .then(() => {
      loadLayoutList();
      return name;
    })
    .catch(err => {
      console.error('saveCalibrationLayout', err);
      return name;
    });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hueToRgb(hue) {
  // hue in [0, 360). Returns { r, g, b } in 0-255. Saturation = value = 1.
  const h = ((hue % 360) + 360) % 360;
  const c = 255;
  const x = Math.round((1 - Math.abs(((h / 60) % 2) - 1)) * 255);
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return { r, g, b };
}


// ==== VIDEO LIST ====

function renderStreamItem(ul) {
  const li = document.createElement('li');
  li.className = 'list-group-item video-item stream-item';

  const title = document.createElement('span');
  title.className = 'video-title';
  title.textContent = t('stream.label', 'Stream');

  const url = getStreamUrl();
  if (url) {
    const urlSpan = document.createElement('span');
    urlSpan.className = 'stream-url';
    const typeTag = getStreamType() === 'whep' ? 'WebRTC: ' : getStreamType() === 'rtmp' ? 'RTMP: ' : '';
    urlSpan.textContent = `${typeTag}${url}`;
    urlSpan.title = url;
    title.appendChild(urlSpan);
  }

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-secondary ms-2 video-play-btn';
  btn.textContent = t('stream.load', 'Load');
  btn.addEventListener('click', loadStreamFromInput);

  li.append(title, btn);
  ul.appendChild(li);
}

function loadVideoList() {
  fetch('/videos/list')
    .then(res => res.json())
    .then(({ videos }) => {
      const ul = document.getElementById('videoList');
      ul.innerHTML = '';
      renderStreamItem(ul);
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
          stopWhepSession();
          setActiveStreamMode('file');
          setActiveStreamUrl(`/videos/${name}`);
          masterPlayer.src({ type: 'video/webm', src: `/videos/${name}` });
          masterPlayer.play();
          socket.emit('controlEvent', { type: 'load', src: `/videos/${name}`, mime: 'video/webm', mode: 'file' });
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
        updatePlayPauseButton(masterPlayer && !masterPlayer.paused());
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




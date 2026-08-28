const socket = io();
let slavePlayer;
const displayId = parseInt(window.location.pathname.split('/').pop(), 10);
let activeStreamMode = 'file';
let whepSession = null;
let measuredRefreshRate = 0;
let statsOverlayVisible = false;
let statsOverlayTimer = null;
let identifyModeActive = false;
let outlinesModeActive = false;
let lastFrameForRedraw = null;

function guessStreamType(url) {
  const value = String(url || '');
  const hasExt = ext => new RegExp(`\\.${ext}(\\?|#|$)`, 'i').test(value);
  if (hasExt('m3u8')) return 'application/x-mpegURL';
  if (hasExt('mpd')) return 'application/dash+xml';
  if (hasExt('mp4')) return 'video/mp4';
  if (hasExt('webm')) return 'video/webm';
  return '';
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

// ---------------------------------------------------------------------------
// WHEP receive-side metrics
// ---------------------------------------------------------------------------
// jitterBufferDelay / jitterBufferEmittedCount is the number that matters: it
// is how long Chrome holds each frame before painting it. On a clean LAN it
// should sit well under 100 ms; if it climbs to 1-2 s, the latency is Chrome
// buffering against a bursty sender, not the network.

let whepStats = null;
let whepStatsPrevInbound = null;

async function sampleWhepStats() {
  if (!whepSession || !whepSession.pc) {
    whepStats = null;
    whepStatsPrevInbound = null;
    return;
  }
  let report;
  try {
    report = await whepSession.pc.getStats();
  } catch (err) {
    return;
  }
  let inbound = null;
  let pair = null;
  const candidates = {};
  report.forEach(s => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    if (s.type === 'candidate-pair' && s.nominated) pair = s;
    if (s.type === 'local-candidate' || s.type === 'remote-candidate') candidates[s.id] = s;
  });
  if (!inbound) return;

  const prev = whepStatsPrevInbound;
  let kbps = null;
  if (prev && inbound.timestamp > prev.timestamp) {
    kbps = ((inbound.bytesReceived - prev.bytesReceived) * 8)
      / ((inbound.timestamp - prev.timestamp) / 1000) / 1000;
  }
  const local = pair && candidates[pair.localCandidateId];

  whepStats = {
    jitterMs: inbound.jitterBufferEmittedCount
      ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
      : null,
    fps: inbound.framesPerSecond || 0,
    size: `${inbound.frameWidth || 0}×${inbound.frameHeight || 0}`,
    lost: inbound.packetsLost || 0,
    received: inbound.packetsReceived || 0,
    freezes: inbound.freezeCount || 0,
    freezeSec: inbound.totalFreezesDuration || 0,
    pli: inbound.pliCount || 0,
    nack: inbound.nackCount || 0,
    decoded: inbound.framesDecoded || 0,
    dropped: inbound.framesDropped || 0,
    kbps,
    rttMs: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    iceLocal: local ? `${local.address || '?'} (${local.candidateType || '?'})` : '–'
  };
  whepStatsPrevInbound = inbound;
}

function logWhepStats() {
  if (!whepStats) return;
  const s = whepStats;
  const lossPct = s.received ? (s.lost / (s.lost + s.received) * 100) : 0;
  console.log(
    `[whep] jitterBuffer=${s.jitterMs != null ? s.jitterMs.toFixed(0) : '?'}ms  ` +
    `fps=${s.fps}  ${s.size}  ${s.kbps != null ? s.kbps.toFixed(0) : '?'}kbps  ` +
    `perte=${lossPct.toFixed(2)}%  gels=${s.freezes} (${s.freezeSec.toFixed(1)}s)  ` +
    `pli=${s.pli}  nack=${s.nack}  trames_perdues=${s.dropped}  ` +
    `rtt=${s.rttMs != null ? s.rttMs.toFixed(0) : '?'}ms  ice=${s.iceLocal}`
  );
}

// Chrome sizes its jitter buffer from the observed packet arrival jitter. A
// bursty sender (aiortc is single-threaded Python) reads as an unstable
// network, so Chrome inflates the buffer to 1-2 s even on a clean LAN. These
// hints ask it to keep the buffer minimal instead.
// A/B switch: append ?lowlat=0 to the display URL to skip the hint entirely,
// so the low-latency tweak can be ruled in or out as the cause of a problem.
const LOWLAT_ENABLED = new URLSearchParams(window.location.search).get('lowlat') !== '0';

function applyLowLatencyPlayout(pc, tag) {
  if (!LOWLAT_ENABLED) {
    console.log(`[whep:${tag}] low-latency playout: DESACTIVE via ?lowlat=0`);
    return;
  }
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
  const videoEl = getVideoElement(slavePlayer);
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
  applyLowLatencyPlayout(pc, `display-${displayId}`);
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
  const videoEl = getVideoElement(slavePlayer);
  clearVideoElement(videoEl);
}

window.addEventListener('DOMContentLoaded', () => {
  slavePlayer = videojs('slaveVideo', { controls:false, fluid:false });
  socket.emit('registerDisplay', { id: displayId, width: window.innerWidth, height: window.innerHeight });
  socket.emit('syncRequest');
  measureRefreshRate(rate => {
    measuredRefreshRate = rate;
    emitDisplayStatus();
  });
  setInterval(emitDisplayStatus, 2000);
  document.addEventListener('fullscreenchange', emitDisplayStatus);
  window.addEventListener('online', emitDisplayStatus);
  window.addEventListener('offline', emitDisplayStatus);
  setInterval(updateStatsOverlay, 500);
  setInterval(sampleWhepStats, 1000);
  setInterval(logWhepStats, 2000);
});

function measureRefreshRate(callback) {
  let frames = 0;
  let startTs = 0;
  function tick(ts) {
    if (!startTs) startTs = ts;
    frames++;
    if (ts - startTs >= 1000) {
      const rate = Math.round((frames * 1000) / (ts - startTs));
      callback(rate);
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function collectDisplayInfo() {
  const videoEl = getVideoElement(slavePlayer);
  let quality = null;
  if (videoEl && typeof videoEl.getVideoPlaybackQuality === 'function') {
    try {
      const q = videoEl.getVideoPlaybackQuality();
      quality = {
        dropped: q.droppedVideoFrames || 0,
        total: q.totalVideoFrames || 0
      };
    } catch (err) { /* ignore */ }
  }
  let bufferedEnd = 0;
  let videoWidth = 0;
  let videoHeight = 0;
  if (videoEl) {
    try {
      const b = videoEl.buffered;
      if (b && b.length) bufferedEnd = b.end(b.length - 1);
    } catch (err) { /* ignore */ }
    videoWidth = videoEl.videoWidth || 0;
    videoHeight = videoEl.videoHeight || 0;
  }
  const screenObj = window.screen || {};
  return {
    id: displayId,
    width: window.innerWidth,
    height: window.innerHeight,
    screenWidth: screenObj.width || 0,
    screenHeight: screenObj.height || 0,
    availWidth: screenObj.availWidth || 0,
    availHeight: screenObj.availHeight || 0,
    devicePixelRatio: Number((window.devicePixelRatio || 1).toFixed(2)),
    colorDepth: screenObj.colorDepth || 0,
    refreshRate: measuredRefreshRate,
    fullscreen: !!document.fullscreenElement,
    online: navigator.onLine,
    videoWidth,
    videoHeight,
    currentTime: slavePlayer ? slavePlayer.currentTime() || 0 : 0,
    duration: slavePlayer ? slavePlayer.duration() || 0 : 0,
    playing: slavePlayer ? !slavePlayer.paused() : false,
    muted: slavePlayer ? slavePlayer.muted() : false,
    volume: slavePlayer ? slavePlayer.volume() : 1,
    playbackRate: slavePlayer ? slavePlayer.playbackRate() : 1,
    bufferedEnd,
    quality,
    streamMode: activeStreamMode,
    visibility: document.visibilityState
  };
}

function emitDisplayStatus() {
  socket.emit('displayStatus', collectDisplayInfo());
}

function requestFullscreenDisplay() {
  const el = document.documentElement;
  if (document.fullscreenElement) return;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (fn) fn.call(el).catch(() => {});
}

function exitFullscreenDisplay() {
  if (!document.fullscreenElement) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (fn) fn.call(document).catch(() => {});
}

function flashIdentify() {
  const overlay = document.getElementById('identifyOverlay');
  if (!overlay) return;
  overlay.textContent = String(displayId);
  overlay.classList.remove('show');
  // force reflow so the animation can replay
  void overlay.offsetWidth;
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 2500);
}

// Calibration markers are inset from each corner by CALIB_MARKER_INSET_PCT
// (in % of the panel width/height). The server MUST mirror this constant when
// mapping detected sub-screens back from the warped canvas to panel coords.
const CALIB_MARKER_INSET_PCT = 5;
const CALIB_MARKER_COLORS = {
  TL: '#ff0000',
  TR: '#00ff00',
  BR: '#0000ff',
  BL: '#ffff00'
};

function setCalibrationPattern(pattern) {
  // pattern values: null | 'white' | 'black' | 'red' | 'green' | 'blue' | 'corners' | 'aruco' | 'gray_x_N' | 'gray_y_N'
  //   or an object { type: 'colorMap', regions: [{x, y, width, height, color}] } for the verification phase.
  let layer = document.getElementById('calibrationLayer');
  if (!pattern) {
    if (layer) layer.remove();
    return;
  }
  // Object form: colour map (verification step)
  if (typeof pattern === 'object' && pattern.type === 'colorMap') {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'calibrationLayer';
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '9997',
        pointerEvents: 'none',
        overflow: 'hidden'
      });
      document.body.appendChild(layer);
    }
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    layer.style.background = '#000000';
    (pattern.regions || []).forEach(region => {
      const c = region.color || { r: 255, g: 255, b: 255 };
      const div = document.createElement('div');
      Object.assign(div.style, {
        position: 'absolute',
        left: `${region.x}%`,
        top: `${region.y}%`,
        width: `${region.width}%`,
        height: `${region.height}%`,
        background: `rgb(${c.r}, ${c.g}, ${c.b})`
      });
      layer.appendChild(div);
    });
    return;
  }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'calibrationLayer';
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9997',
      pointerEvents: 'none',
      overflow: 'hidden'
    });
    document.body.appendChild(layer);
  }
  // Clear children
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  // Solid colors
  const solidColors = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    blue: '#0000ff'
  };
  if (solidColors[pattern]) {
    layer.style.background = solidColors[pattern];
    return;
  }
  // Gray code patterns: load the corresponding baked PNG and render pixel-perfect.
  const grayMatch = /^gray_(x|y)_(\d+)$/.exec(pattern);
  if (grayMatch) {
    const axis = grayMatch[1];
    const bit = grayMatch[2];
    layer.style.background = '#000000';
    const img = document.createElement('img');
    img.src = `/calibration-gray-${axis}-${bit}.png?_=${Date.now()}`;
    Object.assign(img.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      imageRendering: 'pixelated'
    });
    layer.appendChild(img);
    return;
  }

  if (pattern === 'aruco') {
    // The server bakes the ArUco grid PNG at startup and serves it from /.
    // Use an <img> with pixelated rendering to prevent the browser from
    // bilinear-smoothing the markers — smoothing softens the black borders
    // that the ArUco detector relies on for edge contrast.
    layer.style.background = '#ffffff';
    const img = document.createElement('img');
    img.src = `/calibration-grid.png?_=${Date.now()}`;
    Object.assign(img.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      imageRendering: 'pixelated'
    });
    // Some browsers prefer the WebKit / vendor variant
    img.style.imageRendering = 'crisp-edges';
    img.style.imageRendering = '-moz-crisp-edges';
    img.style.imageRendering = 'pixelated';
    layer.appendChild(img);
    return;
  }
  // Fallback: treat as raw CSS color
  layer.style.background = pattern;
}

function setStatsOverlay(visible) {
  statsOverlayVisible = !!visible;
  const el = document.getElementById('statsOverlay');
  if (!el) return;
  el.classList.toggle('show', statsOverlayVisible);
  if (statsOverlayVisible) updateStatsOverlay();
}

function updateStatsOverlay() {
  if (!statsOverlayVisible) return;
  const el = document.getElementById('statsOverlay');
  if (!el) return;
  const info = collectDisplayInfo();
  const drop = info.quality ? `${info.quality.dropped}/${info.quality.total}` : '–';
  const lines = [
    `<b>ID</b> ${info.id} ${info.fullscreen ? '⛶' : ''}`,
    `<b>Win</b> ${info.width}×${info.height}  <b>Scr</b> ${info.screenWidth}×${info.screenHeight}`,
    `<b>DPR</b> ${info.devicePixelRatio}  <b>Hz</b> ${info.refreshRate || '?'}`,
    `<b>Video</b> ${info.videoWidth}×${info.videoHeight}  <b>Mode</b> ${info.streamMode}`,
    `<b>Time</b> ${info.currentTime.toFixed(2)}/${info.duration.toFixed(2)}`,
    `<b>Buf</b> ${info.bufferedEnd.toFixed(2)}s  <b>Drop</b> ${drop}`,
    `<b>Rate</b> ×${info.playbackRate}  <b>Vol</b> ${info.muted ? 'M' : info.volume.toFixed(2)}`
  ];
  if (whepStats) {
    const s = whepStats;
    const lossPct = s.received ? (s.lost / (s.lost + s.received) * 100) : 0;
    const jb = s.jitterMs != null ? s.jitterMs.toFixed(0) : '?';
    // Colour the headline number: this is the measurement the test is about.
    const jbColor = s.jitterMs == null ? '#94a3b8'
      : s.jitterMs < 150 ? '#22c55e'
      : s.jitterMs < 500 ? '#f59e0b' : '#ef4444';
    lines.push(
      '<hr style="border:0;border-top:1px solid rgba(148,163,184,.35);margin:6px 0">',
      `<b>JITTER BUF</b> <span style="color:${jbColor};font-weight:700">${jb} ms</span>`,
      `<b>FPS</b> ${s.fps}  <b>${s.size}</b>  ${s.kbps != null ? s.kbps.toFixed(0) : '?'} kbps`,
      `<b>Perte</b> ${lossPct.toFixed(2)}%  <b>Gels</b> ${s.freezes} (${s.freezeSec.toFixed(1)}s)`,
      `<b>PLI</b> ${s.pli}  <b>NACK</b> ${s.nack}  <b>Trames perdues</b> ${s.dropped}`,
      `<b>RTT</b> ${s.rttMs != null ? s.rttMs.toFixed(0) : '?'} ms`,
      `<b>ICE</b> ${s.iceLocal}`
    );
  }
  el.innerHTML = lines.join('<br>');
}

socket.on('displayCommand', cmd => {
  if (!cmd) return;
  const targetId = parseInt(cmd.id, 10);
  if (Number.isFinite(targetId) && targetId !== displayId) return;
  switch (cmd.action) {
    case 'fullscreen':
      requestFullscreenDisplay();
      break;
    case 'exitFullscreen':
      exitFullscreenDisplay();
      break;
    case 'toggleFullscreen':
      if (document.fullscreenElement) exitFullscreenDisplay();
      else requestFullscreenDisplay();
      break;
    case 'reload':
      window.location.reload();
      break;
    case 'kick': {
      const target = (cmd.url && typeof cmd.url === 'string') ? cmd.url : '/kicked';
      window.location.href = target;
      return;
    }
    case 'calibrationPattern':
      setCalibrationPattern(cmd.value || null);
      break;
    case 'identifyMode':
      setIdentifyMode(!!cmd.value);
      break;
    case 'outlines':
      setOutlinesMode(!!cmd.value);
      break;
    case 'identify':
      flashIdentify();
      break;
    case 'stats':
      setStatsOverlay(cmd.value === undefined ? !statsOverlayVisible : !!cmd.value);
      break;
    case 'playbackRate':
      if (slavePlayer && Number.isFinite(cmd.value) && cmd.value > 0) {
        slavePlayer.playbackRate(cmd.value);
      }
      break;
    case 'requestStatus':
      emitDisplayStatus();
      break;
    default:
      break;
  }
  emitDisplayStatus();
});

socket.on('pingFromControl', ({ ts }) => {
  socket.emit('pongDisplay', { ts });
});

function applyFrameTransform(frame) {
  if (!slavePlayer) return;
  const int_id = parseInt(frame && frame.id, 10);
  if (int_id !== displayId) return;
  const width = Number.parseFloat(frame.width);
  const height = Number.parseFloat(frame.height);
  const x = Number.parseFloat(frame.x);
  const y = Number.parseFloat(frame.y);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  // x,y,width,height in % of container
  const W = window.innerWidth;
  const H = window.innerHeight;
  const scaleX = 100 / width;
  const scaleY = 100 / height;
  const offsetX = -x * (W / 100) * scaleX;
  const offsetY = -y * (H / 100) * scaleY;
  const container = slavePlayer.el();
  if (!container) return;
  const vidEl = container.querySelector('video');
  if (!vidEl) return;
  vidEl.style.transformOrigin = 'top left';
  vidEl.style.transform = `translate(${offsetX}px,${offsetY}px) scale(${scaleX},${scaleY})`;
  applySubScreens(frame);
}

// ---------------------------------------------------------------------------
// Sub-screens rendering
// ---------------------------------------------------------------------------
// Each sub-screen is rendered as:
//  - a "hole" in a fullscreen black mask (so video shows only inside)
//  - a tint overlay div (mix-blend-mode: multiply, color from DMX R/G/B)
//  - a dim overlay div (black, opacity = 1 - dimmer/255)
//
// The "hole" trick is done with a single SVG clip-path applied to the black
// mask: we generate a polygon path that covers the whole window minus the
// sub-screens (even-odd fill rule punches the holes out).

const SUBSCREEN_NS = 'http://www.w3.org/2000/svg';

function buildShapePath(sub, panelWidth, panelHeight) {
  // Returns an SVG path string for one sub-screen, in window coordinates.
  const x = (sub.x / 100) * panelWidth;
  const y = (sub.y / 100) * panelHeight;
  const w = (sub.width / 100) * panelWidth;
  const h = (sub.height / 100) * panelHeight;
  switch (sub.shape) {
    case 'circle': {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      return `M ${cx - rx},${cy} a ${rx},${ry} 0 1,0 ${rx * 2},0 a ${rx},${ry} 0 1,0 ${-rx * 2},0 Z`;
    }
    case 'triangle': {
      return `M ${x + w / 2},${y} L ${x + w},${y + h} L ${x},${y + h} Z`;
    }
    case 'polygon': {
      const pts = Array.isArray(sub.points) ? sub.points : [];
      if (pts.length < 3) return '';
      const cmds = pts.map((p, i) => {
        const px = x + (p[0] / 100) * w;
        const py = y + (p[1] / 100) * h;
        return `${i === 0 ? 'M' : 'L'} ${px},${py}`;
      });
      return `${cmds.join(' ')} Z`;
    }
    case 'rect':
    default:
      return `M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z`;
  }
}

function setIdentifyMode(on) {
  identifyModeActive = !!on;
  if (lastFrameForRedraw) {
    applySubScreens(lastFrameForRedraw);
  }
}

function setOutlinesMode(on) {
  outlinesModeActive = !!on;
  if (lastFrameForRedraw) {
    applySubScreens(lastFrameForRedraw);
  }
}

function applySubScreens(frame) {
  lastFrameForRedraw = frame;
  const subScreens = (frame && Array.isArray(frame.subScreens)) ? frame.subScreens : [];
  const overlaysHost = document.getElementById('subScreenOverlays');
  const mask = document.getElementById('panelMask');
  const clipPath = document.getElementById('panelClip');
  const holeMask = document.getElementById('panelHoleMask');
  const outlineLayer = document.getElementById('outlineLayer');
  if (!overlaysHost || !mask || !clipPath) return;

  if (!subScreens.length) {
    mask.classList.remove('active');
    mask.style.clipPath = '';
    mask.style.webkitMask = '';
    mask.style.mask = '';
    overlaysHost.innerHTML = '';
    if (holeMask) holeMask.innerHTML = '';
    if (outlineLayer) {
      outlineLayer.classList.remove('active');
      outlineLayer.innerHTML = '';
    }
    return;
  }

  const W = window.innerWidth;
  const H = window.innerHeight;

  // Build the black mask via an SVG <mask>:
  //   - White rectangle covering the whole viewport (mask shown everywhere).
  //   - Each sub-screen drawn as its OWN black <path> on top (mask hidden).
  // Each shape paints black independently — overlapping shapes stay black,
  // and winding-direction issues (rect CW vs triangle CCW vs polygon ?)
  // can't cancel out the fill, because they're separate elements.
  if (holeMask) {
    holeMask.setAttribute('x', '0');
    holeMask.setAttribute('y', '0');
    holeMask.setAttribute('width', String(W));
    holeMask.setAttribute('height', String(H));
    holeMask.innerHTML = '';
    const bg = document.createElementNS(SUBSCREEN_NS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(W));
    bg.setAttribute('height', String(H));
    bg.setAttribute('fill', '#fff');
    holeMask.appendChild(bg);
    let pathCount = 0;
    subScreens.forEach(sub => {
      const d = buildShapePath(sub, W, H);
      if (!d) return;
      const p = document.createElementNS(SUBSCREEN_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', '#000');
      p.setAttribute('fill-rule', 'nonzero');
      holeMask.appendChild(p);
      pathCount++;
    });
    mask.style.clipPath = '';
    mask.style.webkitClipPath = '';
    mask.style.mask = 'url(#panelHoleMask)';
    mask.style.webkitMask = 'url(#panelHoleMask)';
    if (window.SUBSCREEN_DEBUG) {
      console.log(`[applySubScreens] subs=${subScreens.length} paths=${pathCount}`);
    }
  }
  mask.classList.add('active');

  // Now overlay tint + dim per sub-screen.
  // Reconcile DOM: keep elements by id, update or create as needed.
  const existing = {};
  Array.from(overlaysHost.children).forEach(el => {
    existing[el.dataset.id] = el;
  });
  const seen = new Set();
  subScreens.forEach(sub => {
    const key = String(sub.id);
    seen.add(key);
    let host = existing[key];
    if (!host) {
      host = document.createElement('div');
      host.className = 'sub-screen';
      host.dataset.id = key;
      const tint = document.createElement('div');
      tint.className = 'tint';
      const dim = document.createElement('div');
      dim.className = 'dim';
      const ident = document.createElement('div');
      ident.className = 'ident';
      const identLabel = document.createElement('div');
      identLabel.className = 'ident-label';
      host.append(tint, dim, ident, identLabel);
      overlaysHost.appendChild(host);
    }
    // Position bounding box.
    host.style.left = `${sub.x}%`;
    host.style.top = `${sub.y}%`;
    host.style.width = `${sub.width}%`;
    host.style.height = `${sub.height}%`;

    // Apply shape via clip-path on the host (so tint & dim inherit it).
    host.style.clipPath = shapeToClipPath(sub);
    host.style.webkitClipPath = host.style.clipPath;

    const tintEl = host.querySelector('.tint');
    const dimEl = host.querySelector('.dim');
    const identEl = host.querySelector('.ident');
    const identLabel = host.querySelector('.ident-label');
    const color = sub.color || { r: 255, g: 255, b: 255 };
    const isFullWhite = color.r >= 254 && color.g >= 254 && color.b >= 254;
    if (tintEl) {
      tintEl.style.backgroundColor = isFullWhite ? 'transparent' : `rgb(${color.r}, ${color.g}, ${color.b})`;
    }
    if (dimEl) {
      const dim = Number.isFinite(sub.dimmer) ? sub.dimmer : 255;
      const opacity = Math.max(0, Math.min(1, 1 - dim / 255));
      dimEl.style.opacity = opacity.toFixed(3);
    }
    // Identify mode overlay: bright checker per sub-screen + large ID text.
    if (identEl && identLabel) {
      if (identifyModeActive) {
        // Per-sub-screen hue so each LCD has a unique colour
        const hue = (sub.id * 47) % 360;
        identEl.style.background = `
          repeating-conic-gradient(
            hsl(${hue}, 80%, 55%) 0% 25%,
            hsl(${hue}, 80%, 25%) 0% 50%
          ) 50% 50% / 8% 8%`;
        identEl.style.display = 'block';
        identLabel.textContent = `#${sub.id}`;
        identLabel.style.display = 'flex';
      } else {
        identEl.style.display = 'none';
        identLabel.style.display = 'none';
      }
    }
  });
  Object.keys(existing).forEach(key => {
    if (!seen.has(key)) existing[key].remove();
  });

  // Outline layer — thin colored borders + small ID text per sub-screen.
  // Useful when the underlying video is dark (e.g. night Minecraft) and you
  // want to visually verify every sub-screen is rendered without occluding
  // the video like identify mode does.
  if (outlineLayer) {
    if (outlinesModeActive) {
      outlineLayer.setAttribute('viewBox', `0 0 ${W} ${H}`);
      outlineLayer.setAttribute('width', String(W));
      outlineLayer.setAttribute('height', String(H));
      outlineLayer.setAttribute('preserveAspectRatio', 'none');
      outlineLayer.innerHTML = '';
      subScreens.forEach(sub => {
        const d = buildShapePath(sub, W, H);
        if (!d) return;
        const path = document.createElementNS(SUBSCREEN_NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'outline');
        outlineLayer.appendChild(path);
        // ID label at the bounding-box centre
        const cx = (sub.x + sub.width / 2) / 100 * W;
        const cy = (sub.y + sub.height / 2) / 100 * H;
        const text = document.createElementNS(SUBSCREEN_NS, 'text');
        text.setAttribute('x', String(cx));
        text.setAttribute('y', String(cy));
        text.setAttribute('class', 'outline-label');
        text.textContent = `#${sub.id}`;
        outlineLayer.appendChild(text);
      });
      outlineLayer.classList.add('active');
    } else {
      outlineLayer.classList.remove('active');
      outlineLayer.innerHTML = '';
    }
  }
}

function shapeToClipPath(sub) {
  switch (sub.shape) {
    case 'circle':
      return 'ellipse(50% 50% at 50% 50%)';
    case 'triangle':
      return 'polygon(50% 0%, 100% 100%, 0% 100%)';
    case 'polygon': {
      const pts = Array.isArray(sub.points) ? sub.points : [];
      if (pts.length < 3) return 'inset(0)';
      return `polygon(${pts.map(p => `${p[0]}% ${p[1]}%`).join(', ')})`;
    }
    case 'rect':
    default:
      return 'inset(0)';
  }
}

function applySyncState(state) {
  if (!slavePlayer) return;
  if (!state) return;
  const src = typeof state.src === 'string' ? state.src : '';
  const time = Number.isFinite(state.time) ? state.time : 0;
  const playing = Boolean(state.playing);
  const mode = typeof state.mode === 'string' ? state.mode : 'file';
  if (mode === 'whep') {
    activeStreamMode = 'whep';
    stopWhepSession();
    if (src) {
      startWhepSession(src).catch(err => console.error('[whep] echec de session:', err));
    }
    if (Array.isArray(state.frames)) {
      const frame = state.frames.find(item => parseInt(item.id, 10) === displayId);
      if (frame) applyFrameTransform(frame);
    }
    return;
  }
  activeStreamMode = 'file';
  stopWhepSession();
  if (src) {
    if (slavePlayer.currentSrc() !== src) {
      const guessed = guessStreamType(src);
      if (guessed) {
        slavePlayer.src({ type: guessed, src });
      } else {
        slavePlayer.src({ src });
      }
      slavePlayer.one('loadedmetadata', () => {
        slavePlayer.currentTime(time);
        if (playing) {
          slavePlayer.play();
        } else {
          slavePlayer.pause();
        }
      });
    } else {
      slavePlayer.currentTime(time);
      if (playing) {
        slavePlayer.play();
      } else {
        slavePlayer.pause();
      }
    }
  } else {
    slavePlayer.currentTime(time);
    if (playing) {
      slavePlayer.play();
    } else {
      slavePlayer.pause();
    }
  }
  if (Array.isArray(state.frames)) {
    const frame = state.frames.find(item => parseInt(item.id, 10) === displayId);
    if (frame) applyFrameTransform(frame);
  }
}

socket.on('controlEvent', ({ type, src, time, muted, volume,id, brightness, mime, mode }) => {
  if (type === 'load') {
    if (mode === 'whep') {
      activeStreamMode = 'whep';
      stopWhepSession();
      if (src) startWhepSession(src).catch(err => console.error('[whep] echec de session:', err));
      return;
    }
    activeStreamMode = 'file';
    stopWhepSession();
    const guessed = guessStreamType(src);
    const finalType = mime || guessed;
    if (finalType) {
      slavePlayer.src({ type: finalType, src });
    } else {
      slavePlayer.src({ src });
    }
    slavePlayer.ready(() => { slavePlayer.currentTime(0); slavePlayer.play(); });
  } else if (type === 'play') {
    slavePlayer.play();
  } else if (type === 'pause') {
    slavePlayer.pause();
  } else if (type === 'seek') {
    if (activeStreamMode === 'whep') return;
    slavePlayer.currentTime(time);
  } else if (type === 'volume') {
    const int_id = parseInt(id, 10);
    if (int_id !== displayId) return;
    slavePlayer.volume(volume);
  } else if (type === 'mute') {
    const int_id = parseInt(id, 10);
    if (int_id !== displayId) return;
    slavePlayer.muted(muted);
  } else if (type === 'brightness') {
    const int_id = parseInt(id, 10);
    if (int_id !== displayId) return;
    // change opacity of "video-js" css with value
    const videoContainer = slavePlayer.el();               // le conteneur principal Video.js
    videoContainer.style.opacity = brightness;              // on ajuste l'opacité  
  }
});

socket.on('syncState', state => {
  applySyncState(state);
});




socket.on('frameUpdate', frame => {
  applyFrameTransform(frame);
});

setInterval(()=> socket.emit('reportTime',{ id:displayId, time:slavePlayer.currentTime() }),10000);
window.addEventListener('resize', ()=> socket.emit('registerDisplay',{ id:displayId, width:window.innerWidth, height:window.innerHeight }));

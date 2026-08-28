/* SyncVid — WebRTC (WHIP/WHEP) server panel.
 *
 * Supervises the whep_server.py process through /webrtc/* on the SyncVid
 * server: start / stop / restart, live stats and a tail of its console.
 * Polling only runs while the tab is on screen.
 */
(function () {
  const POLL_MS = 2000;
  const LOG_MAX_CHARS = 200000;

  let pollTimer = null;
  let logCursor = 0;
  let logBuffer = '';
  let busy = false;

  const $ = id => document.getElementById(id);

  function t(key, fallback) {
    if (window.i18next && typeof i18next.t === 'function') {
      return i18next.t(key, { defaultValue: fallback });
    }
    return fallback;
  }

  // The app is served over a domain in production, so every URL shown here is
  // derived from the page's own host — never hardcoded to localhost.
  function serverHost() {
    return window.location.hostname || '127.0.0.1';
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min ${s} s`;
    return `${s} s`;
  }

  function setBadge(state, label) {
    const badge = $('webrtcBadge');
    const dot = $('webrtcTabDot');
    if (badge) {
      badge.className = `webrtc-badge ${state}`;
      badge.textContent = label;
    }
    if (dot) {
      dot.className = `webrtc-dot ${state}`;
      dot.title = label;
    }
  }

  function renderStatus(status) {
    const meta = $('webrtcMeta');
    const port = status.port;
    const host = serverHost();

    if (status.reachable) {
      const owned = status.owned;
      setBadge('up', owned
        ? t('webrtc.running', 'En marche')
        : t('webrtc.runningExternal', 'En marche (hors application)'));
      const bits = [];
      if (status.pid) bits.push(`PID ${status.pid}`);
      if (status.uptime) bits.push(formatUptime(status.uptime));
      const h = status.health || {};
      bits.push(h.ingest_connected
        ? t('webrtc.ingestOn', 'flux entrant connecté')
        : t('webrtc.ingestOff', 'aucun flux entrant'));
      bits.push(`${h.active_viewers || 0} ${t('webrtc.viewers', 'viewer(s)')}`);
      if (meta) meta.textContent = bits.join(' · ');
    } else {
      setBadge('down', t('webrtc.stopped', 'Arrêté'));
      if (meta) {
        meta.textContent = !status.scriptFound
          ? t('webrtc.noScript', 'whep_server.py introuvable dans cette installation')
          : !status.canLaunch
            ? t('webrtc.noPython', 'aucun interpréteur Python disponible')
            : `port ${port}`;
      }
    }

    const startBtn = $('webrtcStart');
    const stopBtn = $('webrtcStop');
    const restartBtn = $('webrtcRestart');
    const launchable = status.scriptFound && status.canLaunch && !busy;
    if (startBtn) startBtn.disabled = status.reachable || !launchable;
    if (stopBtn) stopBtn.disabled = !status.owned || busy;
    if (restartBtn) restartBtn.disabled = !launchable;

    const whip = $('webrtcWhipUrl');
    const whep = $('webrtcWhepUrl');
    if (whip) whip.textContent = `http://${host}:${port}/whip`;
    if (whep) whep.textContent = `http://${host}:${port}/whep`;

    const opts = status.options || {};
    if (!document.activeElement || !document.activeElement.closest('.webrtc-options')) {
      if ($('webrtcVideoBitrate') && opts.videoBitrate) $('webrtcVideoBitrate').value = opts.videoBitrate;
      if ($('webrtcAudioBitrate') && opts.audioBitrate) $('webrtcAudioBitrate').value = opts.audioBitrate;
      if ($('webrtcCodec') && opts.codec) $('webrtcCodec').value = opts.codec;
      if ($('webrtcVerbose') && typeof opts.verbose === 'boolean') $('webrtcVerbose').checked = opts.verbose;
    }
  }

  function cell(label, value, cls) {
    const span = document.createElement('span');
    span.className = `webrtc-cell${cls ? ' ' + cls : ''}`;
    const b = document.createElement('b');
    b.textContent = label;
    span.append(b, document.createTextNode(' ' + value));
    return span;
  }

  function renderStats(stats) {
    const host = $('webrtcStats');
    if (!host) return;
    host.innerHTML = '';
    if (!stats || !stats.peers) {
      const empty = document.createElement('div');
      empty.className = 'webrtc-empty';
      empty.textContent = t('webrtc.noStats', 'Serveur injoignable.');
      host.appendChild(empty);
      return;
    }

    const peers = Object.entries(stats.peers);
    const ingest = peers.filter(([, p]) => p.role === 'whip');
    const viewers = peers.filter(([, p]) => p.role === 'whep');
    const active = viewers.filter(([, p]) => (p.out_video_pkts || 0) > 0);

    const summary = document.createElement('div');
    summary.className = 'webrtc-summary';
    summary.append(
      cell(t('webrtc.ingest', 'Entrée'), stats.ingest_active
        ? t('webrtc.connected', 'connectée') : t('webrtc.none', 'aucune'),
        stats.ingest_active ? 'good' : 'muted'),
      cell(t('webrtc.viewersActive', 'Viewers actifs'), `${active.length} / ${viewers.length}`)
    );
    host.appendChild(summary);

    ingest.forEach(([sid, p]) => {
      const row = document.createElement('div');
      row.className = 'webrtc-row';
      const loss = p.in_video_pkts
        ? (p.in_video_lost / (p.in_video_lost + p.in_video_pkts) * 100) : 0;
      row.append(
        cell('WHIP', sid.slice(0, 8), 'id'),
        cell(t('webrtc.packets', 'Paquets'), (p.in_video_pkts || 0).toLocaleString('fr-FR')),
        cell(t('webrtc.loss', 'Perte'), `${loss.toFixed(2)} %`, loss > 1 ? 'bad' : 'good'),
        cell('Jitter', p.in_video_jitter != null ? p.in_video_jitter : '–')
      );
      host.appendChild(row);
    });

    if (!viewers.length) {
      const empty = document.createElement('div');
      empty.className = 'webrtc-empty';
      empty.textContent = t('webrtc.noViewers', 'Aucun viewer connecté.');
      host.appendChild(empty);
    }

    viewers.forEach(([sid, p]) => {
      const sent = p.out_video_pkts || 0;
      const row = document.createElement('div');
      row.className = `webrtc-row${sent ? '' : ' idle'}`;
      const loss = sent ? (p.out_video_lost / (p.out_video_lost + sent) * 100) : 0;
      row.append(
        cell('WHEP', sid.slice(0, 8), 'id'),
        cell(t('webrtc.sent', 'Envoyés'), sent.toLocaleString('fr-FR')),
        cell(t('webrtc.loss', 'Perte'), `${loss.toFixed(2)} %`, loss > 1 ? 'bad' : 'good'),
        cell('PLI', p.out_video_pli || 0, (p.out_video_pli || 0) > 0 ? 'warn' : 'good'),
        cell('NACK', p.out_video_nack || 0, (p.out_video_nack || 0) > 0 ? 'warn' : 'good'),
        cell(t('webrtc.rate', 'Débit'), p.eff_kbps ? `${p.eff_kbps} kbps` : '–'),
        cell('RTT', p.rtt_ms != null ? `${p.rtt_ms} ms` : '–')
      );
      if (!sent) row.append(cell('', t('webrtc.idle', 'inactif'), 'muted'));
      host.appendChild(row);
    });
  }

  function appendLog(lines) {
    if (!lines.length) return;
    const pre = $('webrtcConsole');
    if (!pre) return;
    logBuffer += lines.join('\n') + '\n';
    if (logBuffer.length > LOG_MAX_CHARS) {
      logBuffer = logBuffer.slice(logBuffer.length - LOG_MAX_CHARS);
      const nl = logBuffer.indexOf('\n');
      if (nl > 0) logBuffer = logBuffer.slice(nl + 1);
    }
    pre.textContent = logBuffer;
    const auto = $('webrtcAutoscroll');
    if (!auto || auto.checked) pre.scrollTop = pre.scrollHeight;
  }

  // The interval and the post-action refresh can overlap. Two polls reading the
  // same logCursor both fetch the same slice and append it twice, which showed
  // up as a duplicated startup banner in the console.
  let polling = false;

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const status = await fetch('/webrtc/status').then(r => r.json());
      renderStatus(status);

      if (status.reachable) {
        const stats = await fetch('/webrtc/stats')
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null);
        renderStats(stats);
      } else {
        renderStats(null);
      }

      const logs = await fetch(`/webrtc/logs?since=${logCursor}`).then(r => r.json());
      if (logs.truncated) {
        logBuffer = '';
        appendLog([t('webrtc.truncated', '--- lignes plus anciennes perdues ---')]);
      }
      appendLog(logs.lines || []);
      logCursor = logs.next || logCursor;
    } catch (err) {
      console.error('[webrtc-panel]', err);
    } finally {
      polling = false;
    }
  }

  function currentOptions() {
    return {
      videoBitrate: parseInt($('webrtcVideoBitrate').value, 10) || 15000,
      audioBitrate: parseInt($('webrtcAudioBitrate').value, 10) || 192,
      codec: $('webrtcCodec').value,
      verbose: $('webrtcVerbose').checked,
    };
  }

  async function action(path, withOptions) {
    busy = true;
    setBadge('busy', t('webrtc.working', 'En cours…'));
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withOptions ? currentOptions() : {}),
      });
      const data = await res.json().catch(() => ({}));
      appendLog([`--- ${data.message || (res.ok ? 'ok' : 'echec')} ---`]);
    } catch (err) {
      appendLog([`--- erreur : ${err.message || err} ---`]);
    } finally {
      busy = false;
      await poll();
    }
  }

  function startPolling() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const tabBtn = $('tabBtnWebrtc');
    if (!tabBtn) return;

    $('webrtcStart').addEventListener('click', () => action('/webrtc/start', true));
    $('webrtcStop').addEventListener('click', () => action('/webrtc/stop', false));
    $('webrtcRestart').addEventListener('click', () => action('/webrtc/restart', true));
    $('webrtcClearLog').addEventListener('click', () => {
      logBuffer = '';
      $('webrtcConsole').textContent = '';
    });

    tabBtn.addEventListener('shown.bs.tab', startPolling);
    tabBtn.addEventListener('hidden.bs.tab', stopPolling);

    // One status read on load so the tab dot reflects reality before it is opened.
    fetch('/webrtc/status').then(r => r.json()).then(renderStatus).catch(() => {});
  });
})();

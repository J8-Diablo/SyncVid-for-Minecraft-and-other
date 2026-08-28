/* SyncVid sub-screen editor — full window editor with zoom/pan + clean drag. */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const params = new URLSearchParams(window.location.search);
  const frameId = Number.parseInt(params.get('frame'), 10);
  if (!Number.isFinite(frameId)) {
    document.body.innerHTML = '<p style="padding:30px;font-family:monospace">Missing ?frame=N parameter.</p>';
    return;
  }
  document.getElementById('editorTitle').textContent = `— Display ${frameId}`;

  const svg = document.getElementById('editorCanvas');
  const propertyPanel = document.getElementById('propertyPanel');
  const listEl = document.getElementById('editorList');
  const statusEl = document.getElementById('editorStatus');
  const zoomReadout = document.getElementById('zoomReadout');
  const subCountEl = document.getElementById('subCount');

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let subScreens = [];          // local cache, source of truth while editing
  let frameMeta = { id: frameId, x: 0, y: 0, width: 100, height: 100, subScreens: [] };
  let nextSubId = 1;
  let selectedId = null;
  let tool = 'select';
  let creatingPolygonPoints = null; // null or list of [x,y] points being built

  // Zoom / pan: viewBox = [vbX, vbY, vbW, vbH] in panel-% units.
  let viewBox = { x: -2, y: -2, w: 104, h: 104 };

  // Drag state
  let drag = null;

  // -------------------------------------------------------------------------
  // Socket.IO — register as a control and listen for frame updates
  // -------------------------------------------------------------------------
  const socket = io();
  socket.on('connect', () => {
    socket.emit('registerControl');
    socket.emit('syncRequest');
    setStatus(`Connected — frame ${frameId}`);
  });
  socket.on('disconnect', () => setStatus('Disconnected', true));

  socket.on('syncState', state => {
    if (!state || !Array.isArray(state.frames)) return;
    const f = state.frames.find(fr => Number.parseInt(fr.id, 10) === frameId);
    if (!f) return;
    frameMeta = { ...frameMeta, ...f };
    setSubScreensFromServer(f.subScreens || []);
  });
  socket.on('frameUpdate', f => {
    if (!f || Number.parseInt(f.id, 10) !== frameId) return;
    frameMeta = { ...frameMeta, ...f };
    if (drag) return; // don't overwrite mid-drag
    setSubScreensFromServer(f.subScreens || []);
  });

  function setSubScreensFromServer(serverSubs) {
    subScreens = (serverSubs || []).map(s => ({
      id: Number.parseInt(s.id, 10),
      shape: s.shape || 'rect',
      x: Number.parseFloat(s.x) || 0,
      y: Number.parseFloat(s.y) || 0,
      width: Number.parseFloat(s.width) || 0,
      height: Number.parseFloat(s.height) || 0,
      color: s.color || { r: 255, g: 255, b: 255 },
      dimmer: Number.isFinite(s.dimmer) ? s.dimmer : 255,
      points: Array.isArray(s.points) ? s.points.map(p => [
        Number.parseFloat(p[0]) || 0, Number.parseFloat(p[1]) || 0,
      ]) : [],
      dmxAddress: s.dmxAddress != null ? Number.parseInt(s.dmxAddress, 10) : null,
    }));
    nextSubId = subScreens.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    render();
  }

  // Throttled push of the whole frame state to the server.
  let pushTimer = null;
  let pushPending = false;
  function pushNow() {
    socket.emit('frameUpdate', {
      id: frameMeta.id,
      x: frameMeta.x,
      y: frameMeta.y,
      width: frameMeta.width,
      height: frameMeta.height,
      subScreens: subScreens,
    });
    pushPending = false;
  }
  function push() {
    pushPending = true;
    if (pushTimer) return;
    pushNow();
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (pushPending) pushNow();
    }, 60);
  }

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------
  function clientToPanel(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const r = pt.matrixTransform(ctm.inverse());
    return { x: r.x, y: r.y };
  }
  function applyViewBox() {
    svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
    const pct = Math.round((100 / viewBox.w) * 100);
    zoomReadout.textContent = `${pct}%`;
    // Re-render so handles / vertices / labels resize to stay constant in
    // screen pixels (their sizes scale with viewBox.w).
    render();
  }
  // Scale factor for visual handles/markers — keeps them ~constant in screen
  // pixels regardless of zoom. Reference: full panel = 104 viewBox units.
  function zoomScale() {
    return viewBox.w / 104;
  }
  function zoomAt(clientX, clientY, factor) {
    const before = clientToPanel(clientX, clientY);
    viewBox.w = Math.max(2, Math.min(400, viewBox.w / factor));
    viewBox.h = Math.max(2, Math.min(400, viewBox.h / factor));
    applyViewBox();
    const after = clientToPanel(clientX, clientY);
    viewBox.x += before.x - after.x;
    viewBox.y += before.y - after.y;
    applyViewBox();
  }
  function fitView() {
    viewBox = { x: -2, y: -2, w: 104, h: 104 };
    applyViewBox();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Panel background
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('class', 'bg');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', '100'); bg.setAttribute('height', '100');
    bg.addEventListener('mousedown', onBackgroundMouseDown);
    svg.appendChild(bg);

    // Grid
    for (let i = 5; i < 100; i += 5) {
      const major = (i % 10 === 0);
      const cls = major ? 'grid-major' : 'grid';
      const vl = document.createElementNS(SVG_NS, 'line');
      vl.setAttribute('class', cls);
      vl.setAttribute('x1', i); vl.setAttribute('y1', 0);
      vl.setAttribute('x2', i); vl.setAttribute('y2', 100);
      svg.appendChild(vl);
      const hl = document.createElementNS(SVG_NS, 'line');
      hl.setAttribute('class', cls);
      hl.setAttribute('x1', 0); hl.setAttribute('y1', i);
      hl.setAttribute('x2', 100); hl.setAttribute('y2', i);
      svg.appendChild(hl);
    }

    const zs = zoomScale();
    const handleSize = 1.4 * zs;
    const vertexRadius = 0.9 * zs;
    const labelSize = 3 * zs;
    const edgeStrokeHover = 1.2 * zs;

    // Sub-screens
    subScreens.forEach((sub, idx) => {
      const hue = (idx * 360 / Math.max(1, subScreens.length)) % 360;
      const isSel = sub.id === selectedId;
      const shapeEl = buildShapeElement(sub);
      shapeEl.classList.add('sub-shape');
      if (isSel) shapeEl.classList.add('selected');
      shapeEl.setAttribute('fill', `hsl(${hue}, 60%, 50%)`);
      shapeEl.setAttribute('fill-opacity', isSel ? '0.6' : '0.35');
      shapeEl.setAttribute('stroke', isSel ? '#fff' : 'rgba(0,0,0,0.7)');
      shapeEl.setAttribute('stroke-width', isSel ? 2 : 1);
      shapeEl.setAttribute('vector-effect', 'non-scaling-stroke');
      shapeEl.style.cursor = 'move';
      shapeEl.addEventListener('mousedown', evt => onSubMouseDown(evt, sub));
      svg.appendChild(shapeEl);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'sub-label');
      label.setAttribute('x', sub.x + sub.width / 2);
      label.setAttribute('y', sub.y + sub.height / 2);
      label.setAttribute('font-size', labelSize);
      label.setAttribute('stroke-width', 0.3 * zs);
      label.textContent = `#${sub.id}`;
      svg.appendChild(label);

      // Resize handles (always for the selected sub-screen, regardless of shape)
      if (isSel) {
        const w = sub.width, h = sub.height;
        const handleSpecs = [
          { n: 'nw', cx: sub.x,       cy: sub.y,       cur: 'nwse-resize' },
          { n: 'n',  cx: sub.x + w/2, cy: sub.y,       cur: 'ns-resize' },
          { n: 'ne', cx: sub.x + w,   cy: sub.y,       cur: 'nesw-resize' },
          { n: 'e',  cx: sub.x + w,   cy: sub.y + h/2, cur: 'ew-resize' },
          { n: 'se', cx: sub.x + w,   cy: sub.y + h,   cur: 'nwse-resize' },
          { n: 's',  cx: sub.x + w/2, cy: sub.y + h,   cur: 'ns-resize' },
          { n: 'sw', cx: sub.x,       cy: sub.y + h,   cur: 'nesw-resize' },
          { n: 'w',  cx: sub.x,       cy: sub.y + h/2, cur: 'ew-resize' },
        ];
        const bboxLine = document.createElementNS(SVG_NS, 'rect');
        bboxLine.setAttribute('x', sub.x);
        bboxLine.setAttribute('y', sub.y);
        bboxLine.setAttribute('width', sub.width);
        bboxLine.setAttribute('height', sub.height);
        bboxLine.setAttribute('fill', 'none');
        bboxLine.setAttribute('stroke', 'rgba(255,255,255,0.6)');
        bboxLine.setAttribute('stroke-width', 1);
        bboxLine.setAttribute('vector-effect', 'non-scaling-stroke');
        bboxLine.setAttribute('stroke-dasharray', '4 3');
        bboxLine.style.pointerEvents = 'none';
        svg.appendChild(bboxLine);
        handleSpecs.forEach(hs => {
          const handle = document.createElementNS(SVG_NS, 'rect');
          handle.setAttribute('x', hs.cx - handleSize / 2);
          handle.setAttribute('y', hs.cy - handleSize / 2);
          handle.setAttribute('width', handleSize);
          handle.setAttribute('height', handleSize);
          handle.setAttribute('class', 'resize-handle');
          handle.setAttribute('stroke-width', 1.2);
          handle.setAttribute('vector-effect', 'non-scaling-stroke');
          handle.setAttribute('data-handle', hs.n);
          handle.style.cursor = hs.cur;
          handle.addEventListener('mousedown', evt => onResizeMouseDown(evt, sub, hs.n));
          svg.appendChild(handle);
        });
      }

      if (isSel && sub.shape === 'polygon' && Array.isArray(sub.points)) {
        // Edges drawn first as thick invisible hit areas (click anywhere on
        // the edge to insert a vertex at that exact position).
        for (let i = 0; i < sub.points.length; i++) {
          const next = (i + 1) % sub.points.length;
          const p1 = sub.points[i], p2 = sub.points[next];
          const x1 = sub.x + (p1[0] / 100) * sub.width;
          const y1 = sub.y + (p1[1] / 100) * sub.height;
          const x2 = sub.x + (p2[0] / 100) * sub.width;
          const y2 = sub.y + (p2[1] / 100) * sub.height;
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('class', 'edge');
          line.setAttribute('x1', x1); line.setAttribute('y1', y1);
          line.setAttribute('x2', x2); line.setAttribute('y2', y2);
          // Wider hit area in screen pixels — non-scaling-stroke means
          // stroke-width is in screen pixels regardless of zoom.
          line.setAttribute('stroke-width', 12);
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          line.addEventListener('click', evt => {
            evt.stopPropagation();
            const p = clientToPanel(evt.clientX, evt.clientY);
            const rx = ((p.x - sub.x) / Math.max(1e-6, sub.width)) * 100;
            const ry = ((p.y - sub.y) / Math.max(1e-6, sub.height)) * 100;
            sub.points.splice(i + 1, 0, [
              Math.max(0, Math.min(100, rx)),
              Math.max(0, Math.min(100, ry)),
            ]);
            push();
            render();
            renderSide();
          });
          svg.appendChild(line);
        }
        // Explicit "+" buttons at each edge midpoint — always visible, easy
        // to click. Quick way to insert a vertex without aiming at the line.
        for (let i = 0; i < sub.points.length; i++) {
          const next = (i + 1) % sub.points.length;
          const p1 = sub.points[i], p2 = sub.points[next];
          const midRx = (p1[0] + p2[0]) / 2;
          const midRy = (p1[1] + p2[1]) / 2;
          const mx = sub.x + (midRx / 100) * sub.width;
          const my = sub.y + (midRy / 100) * sub.height;
          const grp = document.createElementNS(SVG_NS, 'g');
          grp.setAttribute('class', 'plus-btn');
          grp.style.cursor = 'copy';
          const circle = document.createElementNS(SVG_NS, 'circle');
          circle.setAttribute('cx', mx);
          circle.setAttribute('cy', my);
          circle.setAttribute('r', vertexRadius * 1.1);
          circle.setAttribute('fill', 'rgba(34, 197, 94, 0.85)');
          circle.setAttribute('stroke', '#bbf7d0');
          circle.setAttribute('stroke-width', 1.5);
          circle.setAttribute('vector-effect', 'non-scaling-stroke');
          grp.appendChild(circle);
          const text = document.createElementNS(SVG_NS, 'text');
          text.setAttribute('x', mx);
          text.setAttribute('y', my);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dominant-baseline', 'central');
          text.setAttribute('font-size', vertexRadius * 1.8);
          text.setAttribute('font-weight', 'bold');
          text.setAttribute('fill', '#fff');
          text.style.pointerEvents = 'none';
          text.style.userSelect = 'none';
          text.textContent = '+';
          grp.appendChild(text);
          grp.addEventListener('click', evt => {
            evt.stopPropagation();
            sub.points.splice(i + 1, 0, [midRx, midRy]);
            push();
            render();
            renderSide();
          });
          svg.appendChild(grp);
        }
        // Existing vertices (draggable, right-click to delete)
        sub.points.forEach((p, vIdx) => {
          const vx = sub.x + (p[0] / 100) * sub.width;
          const vy = sub.y + (p[1] / 100) * sub.height;
          const c = document.createElementNS(SVG_NS, 'circle');
          c.setAttribute('class', 'vertex');
          c.setAttribute('cx', vx); c.setAttribute('cy', vy);
          c.setAttribute('r', vertexRadius);
          c.setAttribute('stroke-width', 1.5);
          c.setAttribute('vector-effect', 'non-scaling-stroke');
          c.addEventListener('mousedown', evt => onVertexMouseDown(evt, sub, vIdx));
          c.addEventListener('contextmenu', evt => {
            evt.preventDefault();
            if (sub.points.length <= 3) return;
            sub.points.splice(vIdx, 1);
            push();
            render();
            renderSide();
          });
          svg.appendChild(c);
        });
      }
    });

    // Polygon creation preview
    if (creatingPolygonPoints && creatingPolygonPoints.length > 0) {
      const pts = creatingPolygonPoints.map(p => `${p[0]},${p[1]}`).join(' ');
      const draft = document.createElementNS(SVG_NS,
        creatingPolygonPoints.length >= 3 ? 'polygon' : 'polyline');
      draft.setAttribute('class', 'draft');
      draft.setAttribute('points', pts);
      if (draft.tagName === 'polyline') {
        draft.setAttribute('fill', 'none');
      }
      svg.appendChild(draft);
      creatingPolygonPoints.forEach(p => {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', '0.6');
        c.setAttribute('fill', '#3b82f6');
        c.setAttribute('class', 'draft');
        svg.appendChild(c);
      });
    }

    renderSide();
    subCountEl.textContent = subScreens.length;
  }

  function buildShapeElement(sub) {
    if (sub.shape === 'circle') {
      const el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', sub.x + sub.width / 2);
      el.setAttribute('cy', sub.y + sub.height / 2);
      el.setAttribute('rx', sub.width / 2);
      el.setAttribute('ry', sub.height / 2);
      return el;
    }
    if (sub.shape === 'triangle') {
      const el = document.createElementNS(SVG_NS, 'polygon');
      el.setAttribute('points',
        `${sub.x + sub.width / 2},${sub.y} ${sub.x + sub.width},${sub.y + sub.height} ${sub.x},${sub.y + sub.height}`);
      return el;
    }
    if (sub.shape === 'polygon' && Array.isArray(sub.points) && sub.points.length >= 3) {
      const el = document.createElementNS(SVG_NS, 'polygon');
      el.setAttribute('points', sub.points.map(p =>
        `${sub.x + (p[0] / 100) * sub.width},${sub.y + (p[1] / 100) * sub.height}`
      ).join(' '));
      return el;
    }
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', sub.x); el.setAttribute('y', sub.y);
    el.setAttribute('width', sub.width); el.setAttribute('height', sub.height);
    return el;
  }

  function renderSide() {
    // Property panel
    const sub = subScreens.find(s => s.id === selectedId);
    propertyPanel.innerHTML = '';
    if (!sub) {
      const empty = document.createElement('div');
      empty.className = 'editor-empty';
      empty.textContent = 'No sub-screen selected.';
      propertyPanel.appendChild(empty);
    } else {
      propertyPanel.appendChild(buildPropertyForm(sub));
    }

    // List
    listEl.innerHTML = '';
    if (!subScreens.length) {
      const empty = document.createElement('li');
      empty.className = 'editor-empty';
      empty.textContent = 'No sub-screens yet.';
      listEl.appendChild(empty);
      return;
    }
    subScreens.forEach((s, idx) => {
      const hue = (idx * 360 / Math.max(1, subScreens.length)) % 360;
      const li = document.createElement('li');
      li.className = 'list-item';
      if (s.id === selectedId) li.classList.add('selected');
      const left = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = `hsl(${hue}, 60%, 50%)`;
      left.append(sw, document.createTextNode(`#${s.id} ${s.shape}`));
      const right = document.createElement('span');
      right.textContent = `${s.width.toFixed(1)}×${s.height.toFixed(1)}%`;
      right.style.fontSize = '10px';
      right.style.color = 'var(--text-muted, #94a3b8)';
      li.append(left, right);
      li.addEventListener('click', () => {
        selectedId = s.id;
        render();
      });
      listEl.appendChild(li);
    });
  }

  function buildPropertyForm(sub) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
    const title = document.createElement('strong');
    title.textContent = `#${sub.id} — ${sub.shape}`;
    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger';
    del.style.padding = '2px 8px';
    del.style.fontSize = '11px';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      subScreens = subScreens.filter(s => s.id !== sub.id);
      selectedId = null;
      push();
      render();
    });
    head.append(title, del);
    wrap.appendChild(head);

    const numRow = (key, label, opts = {}) => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = opts.step || '0.5';
      if (opts.min !== undefined) inp.min = opts.min;
      if (opts.max !== undefined) inp.max = opts.max;
      inp.value = Number.isFinite(sub[key]) ? sub[key] : 0;
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) {
          sub[key] = v;
          push();
          render();
        }
      });
      row.append(lbl, inp);
      return row;
    };
    wrap.appendChild(numRow('x', 'X %', { step: '0.25' }));
    wrap.appendChild(numRow('y', 'Y %', { step: '0.25' }));
    wrap.appendChild(numRow('width', 'W %', { step: '0.25' }));
    wrap.appendChild(numRow('height', 'H %', { step: '0.25' }));

    // Shape selector
    const shapeRow = document.createElement('div');
    shapeRow.className = 'prop-row';
    const shapeLbl = document.createElement('label');
    shapeLbl.textContent = 'Shape';
    const shapeSel = document.createElement('select');
    ['rect', 'circle', 'triangle', 'polygon'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (sub.shape === opt) o.selected = true;
      shapeSel.appendChild(o);
    });
    shapeSel.addEventListener('change', () => {
      sub.shape = shapeSel.value;
      if (sub.shape === 'polygon' && (!sub.points || sub.points.length < 3)) {
        sub.points = [[50, 0], [100, 100], [0, 100]];
      }
      push();
      render();
    });
    shapeRow.append(shapeLbl, shapeSel);
    wrap.appendChild(shapeRow);

    // Color picker
    const colRow = document.createElement('div');
    colRow.className = 'prop-row';
    const colLbl = document.createElement('label');
    colLbl.textContent = 'Color';
    const colInp = document.createElement('input');
    colInp.type = 'color';
    const c = sub.color || { r: 255, g: 255, b: 255 };
    const h2 = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    colInp.value = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
    colInp.addEventListener('input', () => {
      const s = colInp.value.replace(/^#/, '');
      sub.color = {
        r: parseInt(s.slice(0, 2), 16),
        g: parseInt(s.slice(2, 4), 16),
        b: parseInt(s.slice(4, 6), 16),
      };
      push();
    });
    colRow.append(colLbl, colInp);
    wrap.appendChild(colRow);

    // Dim slider
    const dimRow = document.createElement('div');
    dimRow.className = 'prop-row';
    const dimLbl = document.createElement('label');
    dimLbl.textContent = `Dim ${sub.dimmer ?? 255}`;
    const dimInp = document.createElement('input');
    dimInp.type = 'range';
    dimInp.min = 0; dimInp.max = 255;
    dimInp.value = sub.dimmer ?? 255;
    dimInp.addEventListener('input', () => {
      sub.dimmer = parseInt(dimInp.value, 10);
      dimLbl.textContent = `Dim ${sub.dimmer}`;
      push();
    });
    dimRow.append(dimLbl, dimInp);
    wrap.appendChild(dimRow);

    // DMX
    const dmxRow = document.createElement('div');
    dmxRow.className = 'prop-row';
    const dmxLbl = document.createElement('label');
    dmxLbl.textContent = 'DMX addr';
    const dmxInp = document.createElement('input');
    dmxInp.type = 'number';
    dmxInp.min = 1; dmxInp.max = 512;
    dmxInp.value = sub.dmxAddress != null ? sub.dmxAddress : '';
    dmxInp.placeholder = '—';
    dmxInp.addEventListener('change', () => {
      const v = parseInt(dmxInp.value, 10);
      sub.dmxAddress = Number.isFinite(v) ? v : null;
      push();
    });
    dmxRow.append(dmxLbl, dmxInp);
    wrap.appendChild(dmxRow);

    if (sub.shape === 'polygon') {
      const ptHdr = document.createElement('h6');
      ptHdr.textContent = `Points (${(sub.points || []).length})`;
      ptHdr.style.cssText = 'margin: 10px 0 4px; font-size: 10px;';
      wrap.appendChild(ptHdr);
      const ptHint = document.createElement('div');
      ptHint.className = 'editor-empty';
      ptHint.textContent = 'Drag in canvas to move points. Right-click vertex to delete. Click edge to insert.';
      wrap.appendChild(ptHint);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Drag handlers
  // -------------------------------------------------------------------------
  function onSubMouseDown(evt, sub) {
    if (evt.button !== 0) return;
    if (tool !== 'select') return;
    evt.preventDefault();
    evt.stopPropagation();
    selectedId = sub.id;
    const startPanel = clientToPanel(evt.clientX, evt.clientY);
    drag = {
      kind: 'move-sub',
      subId: sub.id,
      startX: startPanel.x,
      startY: startPanel.y,
      origX: sub.x,
      origY: sub.y,
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    render();
  }
  function onResizeMouseDown(evt, sub, handleName) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    selectedId = sub.id;
    const startPanel = clientToPanel(evt.clientX, evt.clientY);
    drag = {
      kind: 'resize-sub',
      subId: sub.id,
      handle: handleName,
      startX: startPanel.x,
      startY: startPanel.y,
      orig: { x: sub.x, y: sub.y, width: sub.width, height: sub.height },
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function applyResize(sub, handle, panelX, panelY, orig) {
    // Compute the new bbox based on which handle is dragged.
    // North handles change y and height (anchor on south).
    // South handles change height only (anchor on north).
    // West handles change x and width (anchor on east).
    // East handles change width only (anchor on west).
    const MIN_SIZE = 1; // % of panel
    let newX = orig.x;
    let newY = orig.y;
    let newW = orig.width;
    let newH = orig.height;
    if (handle.includes('w')) {
      const rightEdge = orig.x + orig.width;
      newX = Math.max(0, Math.min(rightEdge - MIN_SIZE, panelX));
      newW = rightEdge - newX;
    }
    if (handle.includes('e')) {
      newW = Math.max(MIN_SIZE, Math.min(100 - newX, panelX - orig.x));
    }
    if (handle.includes('n')) {
      const bottomEdge = orig.y + orig.height;
      newY = Math.max(0, Math.min(bottomEdge - MIN_SIZE, panelY));
      newH = bottomEdge - newY;
    }
    if (handle.includes('s')) {
      newH = Math.max(MIN_SIZE, Math.min(100 - newY, panelY - orig.y));
    }
    sub.x = newX;
    sub.y = newY;
    sub.width = newW;
    sub.height = newH;
  }

  function onVertexMouseDown(evt, sub, vIdx) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    selectedId = sub.id;
    const startPanel = clientToPanel(evt.clientX, evt.clientY);
    drag = {
      kind: 'move-vertex',
      subId: sub.id,
      vIdx,
      startX: startPanel.x,
      startY: startPanel.y,
      origPoint: [...sub.points[vIdx]],
      subW: sub.width,
      subH: sub.height,
      subX: sub.x,
      subY: sub.y,
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }
  function onBackgroundMouseDown(evt) {
    if (evt.button === 1 || evt.button === 2 ||
        (evt.button === 0 && evt.shiftKey)) {
      // Pan
      evt.preventDefault();
      drag = { kind: 'pan', startClientX: evt.clientX, startClientY: evt.clientY,
               origVB: { ...viewBox } };
      svg.classList.add('panning');
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      return;
    }
    if (evt.button !== 0) return;

    // Creation tool
    if (tool === 'add-rect' || tool === 'add-circle' || tool === 'add-triangle') {
      const p = clientToPanel(evt.clientX, evt.clientY);
      const w = 15, h = 15;
      const shape = tool === 'add-rect' ? 'rect' : tool === 'add-circle' ? 'circle' : 'triangle';
      const sub = {
        id: nextSubId++,
        shape,
        x: Math.max(0, Math.min(100 - w, p.x - w / 2)),
        y: Math.max(0, Math.min(100 - h, p.y - h / 2)),
        width: w, height: h,
        color: { r: 255, g: 255, b: 255 }, dimmer: 255, points: [], dmxAddress: null,
      };
      subScreens.push(sub);
      selectedId = sub.id;
      tool = 'select';
      updateToolButtons();
      push();
      render();
      return;
    }
    if (tool === 'add-polygon') {
      const p = clientToPanel(evt.clientX, evt.clientY);
      if (!creatingPolygonPoints) creatingPolygonPoints = [];
      creatingPolygonPoints.push([p.x, p.y]);
      render();
      return;
    }
    // Click on background = deselect
    selectedId = null;
    render();
  }
  function onMouseMove(evt) {
    if (!drag) return;
    if (drag.kind === 'pan') {
      // Convert client delta into viewBox delta using current viewBox scale.
      const rect = svg.getBoundingClientRect();
      const sx = viewBox.w / rect.width;
      const sy = viewBox.h / rect.height;
      viewBox.x = drag.origVB.x - (evt.clientX - drag.startClientX) * sx;
      viewBox.y = drag.origVB.y - (evt.clientY - drag.startClientY) * sy;
      applyViewBox();
      return;
    }
    const p = clientToPanel(evt.clientX, evt.clientY);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    const sub = subScreens.find(s => s.id === drag.subId);
    if (!sub) return;
    if (drag.kind === 'move-sub') {
      sub.x = Math.max(0, Math.min(100 - sub.width, drag.origX + dx));
      sub.y = Math.max(0, Math.min(100 - sub.height, drag.origY + dy));
      render();
      push();
    } else if (drag.kind === 'resize-sub') {
      applyResize(sub, drag.handle, p.x, p.y, drag.orig);
      render();
      push();
    } else if (drag.kind === 'move-vertex') {
      const rx = drag.origPoint[0] + (dx / Math.max(1e-6, drag.subW)) * 100;
      const ry = drag.origPoint[1] + (dy / Math.max(1e-6, drag.subH)) * 100;
      sub.points[drag.vIdx] = [
        Math.max(0, Math.min(100, rx)),
        Math.max(0, Math.min(100, ry)),
      ];
      render();
      push();
    }
  }
  function onMouseUp() {
    if (drag) {
      svg.classList.remove('panning');
      drag = null;
    }
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  // -------------------------------------------------------------------------
  // Wheel zoom + keyboard shortcuts
  // -------------------------------------------------------------------------
  svg.addEventListener('wheel', evt => {
    evt.preventDefault();
    const factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(evt.clientX, evt.clientY, factor);
  }, { passive: false });
  svg.addEventListener('contextmenu', evt => evt.preventDefault());

  document.addEventListener('keydown', evt => {
    const active = document.activeElement;
    const inField = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');

    if (evt.key === 'Escape') {
      if (creatingPolygonPoints) {
        creatingPolygonPoints = null;
        tool = 'select';
        updateToolButtons();
        render();
      } else if (calibOverlay && !calibOverlay.hidden) {
        closeCalibrate();
      } else if (selectedId !== null) {
        selectedId = null;
        render();
      }
      return;
    }
    if (evt.key === 'Enter' && tool === 'add-polygon' && creatingPolygonPoints && creatingPolygonPoints.length >= 3) {
      finishPolygonCreation();
      return;
    }
    if ((evt.key === 'Delete' || evt.key === 'Backspace') && selectedId !== null && !inField) {
      subScreens = subScreens.filter(s => s.id !== selectedId);
      selectedId = null;
      push();
      render();
      return;
    }

    // ---- Arrow keys nudge the selected sub-screen ----
    // Base step 1% of panel; Shift = ×0.1 (fine), Ctrl/⌘ = ×10 (coarse).
    if (!inField && selectedId !== null &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(evt.key)) {
      const sub = subScreens.find(s => s.id === selectedId);
      if (!sub) return;
      evt.preventDefault();
      let step = 1;
      if (evt.shiftKey) step = 0.1;
      if (evt.ctrlKey || evt.metaKey) step = 10;
      let dx = 0, dy = 0;
      if (evt.key === 'ArrowLeft') dx = -step;
      else if (evt.key === 'ArrowRight') dx = step;
      else if (evt.key === 'ArrowUp') dy = -step;
      else if (evt.key === 'ArrowDown') dy = step;
      sub.x = Math.max(0, Math.min(100 - sub.width, +(sub.x + dx).toFixed(3)));
      sub.y = Math.max(0, Math.min(100 - sub.height, +(sub.y + dy).toFixed(3)));
      push();
      render();
    }
  });

  function finishPolygonCreation() {
    if (!creatingPolygonPoints || creatingPolygonPoints.length < 3) {
      creatingPolygonPoints = null;
      return;
    }
    const xs = creatingPolygonPoints.map(p => p[0]);
    const ys = creatingPolygonPoints.map(p => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const points = creatingPolygonPoints.map(p => [
      ((p[0] - minX) / w) * 100,
      ((p[1] - minY) / h) * 100,
    ]);
    const sub = {
      id: nextSubId++,
      shape: 'polygon',
      x: minX, y: minY, width: w, height: h,
      color: { r: 255, g: 255, b: 255 }, dimmer: 255,
      points,
      dmxAddress: null,
    };
    subScreens.push(sub);
    selectedId = sub.id;
    creatingPolygonPoints = null;
    tool = 'select';
    updateToolButtons();
    push();
    render();
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------
  function updateToolButtons() {
    document.querySelectorAll('#toolbarMain .btn').forEach(btn => {
      const isActive = btn.dataset.tool === tool;
      btn.classList.toggle('btn-primary', isActive);
      btn.classList.toggle('btn-outline-light', !isActive);
    });
    if (tool === 'select') {
      svg.classList.remove('tool-create');
    } else {
      svg.classList.add('tool-create');
    }
  }
  document.querySelectorAll('#toolbarMain .btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Cancel any in-progress polygon if switching tools
      if (creatingPolygonPoints && btn.dataset.tool !== 'add-polygon') {
        creatingPolygonPoints = null;
      }
      tool = btn.dataset.tool;
      updateToolButtons();
      render();
    });
  });
  document.getElementById('zoomIn').addEventListener('click', () => {
    const r = svg.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    const r = svg.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  document.getElementById('zoomFit').addEventListener('click', fitView);
  document.getElementById('identifyToggle').addEventListener('change', evt => {
    socket.emit('displayCommand', {
      id: frameId,
      action: 'identifyMode',
      value: evt.target.checked,
    });
  });
  const outlinesToggleEl = document.getElementById('outlinesToggle');
  if (outlinesToggleEl) {
    outlinesToggleEl.addEventListener('change', evt => {
      socket.emit('displayCommand', {
        id: frameId,
        action: 'outlines',
        value: evt.target.checked,
      });
    });
  }
  // Stop identify + outlines when window closes
  window.addEventListener('beforeunload', () => {
    socket.emit('displayCommand', { id: frameId, action: 'identifyMode', value: false });
    socket.emit('displayCommand', { id: frameId, action: 'outlines', value: false });
  });

  // -------------------------------------------------------------------------
  // Auto-calibration (in-window modal — duplicates the control-panel flow so
  // the user doesn't need to switch windows)
  // -------------------------------------------------------------------------
  const CALIB_GRAY_BITS_X = 6;
  const CALIB_GRAY_BITS_Y = 6;
  const CALIB_SEQUENCE = (() => {
    const seq = [];
    seq.push(['black', 1500, 'black']);
    seq.push(['white', 1000, 'white']);
    for (let i = 0; i < CALIB_GRAY_BITS_X; i++) seq.push([`gray_x_${i}`, 500, `gray_x_${i}`]);
    for (let i = 0; i < CALIB_GRAY_BITS_Y; i++) seq.push([`gray_y_${i}`, 500, `gray_y_${i}`]);
    return seq;
  })();
  const calibOverlay = document.getElementById('calibOverlay');
  let calibStream = null;
  let calibRunning = false;

  function openCalibrate() {
    if (!calibOverlay) return;
    document.getElementById('calibFrameLabel').textContent = `— Display ${frameId}`;
    document.getElementById('calibStatus').textContent = 'Pick a camera, then Start.';
    document.getElementById('calibProgressBar').style.width = '0%';
    document.getElementById('calibRun').disabled = true;
    document.getElementById('calibDebugLink').style.display = 'none';
    populateCalibCameras();
    calibOverlay.hidden = false;
  }
  function closeCalibrate() {
    if (!calibOverlay) return;
    stopCalibCamera();
    sendCalibPattern(null);
    calibOverlay.hidden = true;
  }
  async function populateCalibCameras() {
    const sel = document.getElementById('calibCameraSelect');
    sel.innerHTML = '';
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      devices.filter(d => d.kind === 'videoinput').forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i + 1}`;
        sel.appendChild(opt);
      });
    } catch (err) {
      console.warn('enumerateDevices', err);
    }
    if (!sel.options.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No camera detected';
      sel.appendChild(opt);
    }
  }
  async function startCalibCamera() {
    stopCalibCamera();
    const sel = document.getElementById('calibCameraSelect');
    const deviceId = sel && sel.value ? sel.value : undefined;
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    };
    try {
      calibStream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = document.getElementById('calibVideo');
      video.srcObject = calibStream;
      await video.play();
      populateCalibCameras();
      document.getElementById('calibRun').disabled = false;
      document.getElementById('calibStatus').textContent =
        'Camera live. Aim the lens at the panel, then click Run.';
    } catch (err) {
      console.error('getUserMedia', err);
      document.getElementById('calibStatus').textContent = `Camera error: ${err.message || err.name}`;
    }
  }
  function stopCalibCamera() {
    if (calibStream) {
      calibStream.getTracks().forEach(t => t.stop());
      calibStream = null;
    }
    const v = document.getElementById('calibVideo');
    if (v) v.srcObject = null;
  }
  function sendCalibPattern(pattern) {
    socket.emit('displayCommand', {
      id: frameId,
      action: 'calibrationPattern',
      value: pattern,
    });
  }
  function snapCalibFrame() {
    const video = document.getElementById('calibVideo');
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.92));
  }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  async function runCalibSequence() {
    if (calibRunning) return;
    if (!calibStream) {
      document.getElementById('calibStatus').textContent = 'Start the camera first.';
      return;
    }
    calibRunning = true;
    document.getElementById('calibRun').disabled = true;
    document.getElementById('calibProgressBar').style.width = '0%';
    const fd = new FormData();
    try {
      for (let i = 0; i < CALIB_SEQUENCE.length; i++) {
        const [name, settle, field] = CALIB_SEQUENCE[i];
        document.getElementById('calibStatus').textContent =
          `Pattern ${name} (${i + 1}/${CALIB_SEQUENCE.length})…`;
        sendCalibPattern(name);
        await wait(settle);
        const blob = await snapCalibFrame();
        if (!blob) throw new Error('Camera frame capture failed');
        fd.append(field, blob, `${field}.jpg`);
        document.getElementById('calibProgressBar').style.width =
          `${((i + 1) / (CALIB_SEQUENCE.length + 1)) * 100}%`;
      }
      sendCalibPattern(null);
      document.getElementById('calibStatus').textContent = 'Detecting sub-screens…';
      const res = await fetch('/api/calibrate', { method: 'POST', body: fd });
      const data = await res.json();
      const dbg = document.getElementById('calibDebugLink');
      if (data.debugUrl) {
        dbg.href = data.debugUrl;
        dbg.style.display = 'inline-block';
      }
      if (!res.ok) throw new Error(data.error || 'calibration failed');
      const detected = Array.isArray(data.subScreens) ? data.subScreens : [];
      document.getElementById('calibProgressBar').style.width = '100%';
      if (!detected.length) {
        document.getElementById('calibStatus').textContent =
          'No sub-screens detected. Reframe the camera and try again.';
        return;
      }
      // Replace local sub-screens with the detected ones, then push.
      const remapped = detected.map((s, idx) => ({ ...s, id: idx + 1 }));
      subScreens = remapped;
      nextSubId = remapped.length + 1;
      selectedId = null;
      push();
      render();
      // Auto-save layout
      let layoutName = null;
      try {
        const now = new Date();
        const pad = v => String(v).padStart(2, '0');
        const name = `calib-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const framesPayload = [{
          id: frameId,
          x: frameMeta.x, y: frameMeta.y,
          width: frameMeta.width, height: frameMeta.height,
          subScreens: subScreens,
        }];
        await fetch('/layouts/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, frames: framesPayload }),
        });
        layoutName = name;
      } catch (err) {
        console.warn('layout save failed', err);
      }
      let detail = '';
      if (data.method === 'gray-code') detail = ` (Gray code, ${data.brightPixels} bright px)`;
      else if (data.markersDetected) detail = ` (${data.markersDetected} markers)`;
      document.getElementById('calibStatus').textContent =
        `${detected.length} sub-screen(s) detected${detail}` +
        (layoutName ? `. Saved as layout "${layoutName}".` : '.');
    } catch (err) {
      console.error('calibrate', err);
      document.getElementById('calibStatus').textContent =
        `Detection failed: ${err.message || err}`;
      sendCalibPattern(null);
    } finally {
      calibRunning = false;
      document.getElementById('calibRun').disabled = !calibStream;
      // Ensure pattern is cleared on display (belt + suspenders)
      sendCalibPattern(null);
      setTimeout(() => sendCalibPattern(null), 200);
    }
  }
  document.getElementById('reloadDisplay').addEventListener('click', () => {
    socket.emit('displayCommand', { id: frameId, action: 'reload' });
    setStatus(`Reload command sent to display ${frameId}`);
  });
  document.getElementById('openAutoCalibrate').addEventListener('click', openCalibrate);
  document.getElementById('calibClose').addEventListener('click', closeCalibrate);
  document.getElementById('calibStartCamera').addEventListener('click', startCalibCamera);
  document.getElementById('calibRun').addEventListener('click', runCalibSequence);

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#fca5a5' : 'var(--text-muted, #94a3b8)';
  }
  applyViewBox();
  fitView();
  updateToolButtons();
  render();
})();

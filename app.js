// TapeForge — UI layer. Plain DOM + SVG, no framework, no network except the
// optional X Layer RPC read (refreshLive). All circuit logic lives in circuit.js.
(function () {
  'use strict';
  var TF = window.TapeForgeCircuit;

  // ------------------------------------------------------------ data
  var FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
  var RPCS = ['https://rpc.xlayer.tech', 'https://tapeout.net/rpc-xlayer'];
  // Selectors from the public TapeOut read script (openwitness.net/p/9897):
  var SEL = { transistors: '0x6fbd1719', nextId: '0x61b8ce8c', price: '0x6817c76c', minted: '0x4f02c420', cap: '0x8f770ad0' };
  var OKB_USD = 79; // approx OKB price, 25 Nov 2026 — estimate only

  // Cached snapshot — real X Layer processors, read from chain 2026-11-25T12:53:31Z
  // (factory cpuCount/cpuAt/transistors/nextId/price/minted/cap via public RPC).
  // Names FAB-Genisis / TAPELIQUID / 9898 are from the 23 Oct 2026 openwitness
  // survey; their addresses match that survey's price + circuit-count signature.
  // Totals at snapshot time: 450 processors, 12,242 circuits, median price 0.00066 OKB.
  var SNAPSHOT_AT = '25 Nov 2026, 12:53 UTC';
  var processors = [
    { name: '9898', address: '0x60918c204f3c94630d3d793738fc36293c8405d6', transistor: '0x0f7e9ed401fe35010ebc4d021a204ba031a23194', priceWei: '1000000000000', minted: 16511, cap: 1000000000000, circuits: 1022, note: 'cheapest proven fab' },
    { name: 'FAB-Genisis', address: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6', transistor: '0xbe6f94115d32f3ac3252bc4626573e739beeb714', priceWei: '500000000000000', minted: 1000000, cap: 1000000, circuits: 7164, note: 'most circuits' },
    { name: 'TAPELIQUID', address: '0x69f663931209096037474d7c20402232e5c762ca', transistor: '0x3fa393d3081accff9e7989619b688235f6d3ee3f', priceWei: '660000000000000', minted: 2100000, cap: 2100000, circuits: 1408, note: 'median price' },
    { name: 'XBOT', address: '0xa5fc69Ca2D3d462CCa204D894D85ac8071c4F0f0', transistor: '0x7bE7280e31984d18f62218519985EC5DcCa751De', priceWei: '9000000000000000', minted: 40, cap: 1000000000, circuits: 5, note: 'consensus-circuit processor' },
    { name: 'ViperX', address: '0xb57b56034e2dc25161e2512CfC40b24EA3bee1Fb', transistor: '0xfce5366485140045e95ebdba88ad775fc4aad79f', priceWei: '0', minted: 158, cap: 158, circuits: 4, note: 'free, sold out' },
    { name: 'Cheapest available', address: '0x99081e1d0ce916cd5b2c53e769dfc3b000bfe9a4', transistor: '0x80a7eb72bc4e559c47304efe6a0f6e73717df5cb', priceWei: '1', minted: 281, cap: 1e24, circuits: 19, note: '1 wei / transistor' }
  ];
  processors.forEach(function (p) { p.priceOkb = Number(BigInt(p.priceWei)) / 1e18; });
  var dataLive = false, liveBlock = null, liveAt = null;
  var selectedProc = 0; // index into processors

  // ------------------------------------------------------------ state
  var state = {
    circuit: null, layout: { gates: {}, inputs: {}, outputs: {} },
    inputValues: {}, counters: { gate: 0, input: 0, output: 0 },
    templateId: null, circuitName: 'Custom circuit'
  };
  var history = [], redoStack = [];
  var pendingWire = null; // {k:'i'|'g', id} source ref waiting for a target
  var selected = null;    // {kind:'gate'|'input'|'output', id}
  var drag = null;        // {id, dx, dy, moved}
  var mousePos = null;    // svg coords while a wire is pending
  var lastVerify = null;
  var zoomMode = 'fit'; // 'fit' = fit the whole circuit in view, or a number = manual zoom level
  function computeFitZoom(size) {
    var cs = $('canvas-scroll');
    var w = cs && cs.clientWidth ? cs.clientWidth : 0;
    if (!w || !size || !size.w) return 1;
    var z = (w - 4) / size.w;
    if (!isFinite(z) || z <= 0) return 1;
    return Math.min(1, z);
  }
  function currentZoom(size) {
    var z = zoomMode === 'fit' ? computeFitZoom(size || canvasSize()) : zoomMode;
    if (!isFinite(z) || z <= 0) z = 1;
    return z;
  }
  function setZoom(mode) {
    if (mode === 'fit') zoomMode = 'fit';
    else if (mode === '100') zoomMode = 1;
    else if (mode === 'in') zoomMode = Math.min(2, currentZoom() * 1.25);
    else if (mode === 'out') zoomMode = Math.max(0.15, currentZoom() / 1.25);
    renderCanvas();
  }

  var svg = document.getElementById('canvas');
  var $ = function (id) { return document.getElementById(id); };

  function snapshot() {
    return JSON.parse(JSON.stringify({
      circuit: state.circuit, layout: state.layout, inputValues: state.inputValues,
      counters: state.counters, templateId: state.templateId, circuitName: state.circuitName
    }));
  }
  function restore(s) {
    state.circuit = s.circuit; state.layout = s.layout; state.inputValues = s.inputValues;
    state.counters = s.counters; state.templateId = s.templateId; state.circuitName = s.circuitName;
    pendingWire = null; selected = null;
  }
  function commit() { history.push(snapshot()); if (history.length > 60) history.shift(); redoStack = []; }
  function undo() {
    if (!history.length) return;
    redoStack.push(snapshot()); restore(history.pop()); renderAll();
  }
  function redo() {
    if (!redoStack.length) return;
    history.push(snapshot()); restore(redoStack.pop()); renderAll();
  }

  // ------------------------------------------------------------ layout
  var GATE_W = 72, GATE_H = 48, PIN_W = 64, PIN_H = 30;
  function gateDepth(circuit) {
    var depth = {}, idx = {};
    circuit.gates.forEach(function (g, i) { idx[g.id] = i; });
    function d(id, seen) {
      if (depth[id] !== undefined) return depth[id];
      if (seen[id]) return 0;
      seen[id] = 1;
      var g = circuit.gates[idx[id]], m = -1;
      [g.a, g.b].forEach(function (s) {
        if (s && s.k === 'g') m = Math.max(m, d(s.id, seen));
      });
      depth[id] = m + 1;
      return depth[id];
    }
    circuit.gates.forEach(function (g) { d(g.id, {}); });
    return depth;
  }
  function autoLayout(circuit) {
    var layout = { gates: {}, inputs: {}, outputs: {} };
    var depth = gateDepth(circuit), maxDepth = 0;
    circuit.gates.forEach(function (g) { maxDepth = Math.max(maxDepth, depth[g.id] || 0); });
    var cols = {};
    circuit.gates.forEach(function (g) {
      var c = depth[g.id] || 0;
      (cols[c] = cols[c] || []).push(g.id);
    });
    Object.keys(cols).forEach(function (c) {
      cols[c].forEach(function (id, i) {
        layout.gates[id] = { x: 150 + (+c) * 120, y: 30 + i * 66 };
      });
    });
    circuit.inputs.forEach(function (p, i) { layout.inputs[p.id] = { x: 20, y: 30 + i * 44 }; });
    var outX = 150 + (maxDepth + 1) * 120 + 40;
    circuit.outputs.forEach(function (o, i) { layout.outputs[o.id] = { x: outX, y: 30 + i * 44 }; });
    return layout;
  }
  function canvasSize() {
    var w = 300, h = 200;
    function ext(x, y, ww, hh) { w = Math.max(w, x + ww + 40); h = Math.max(h, y + hh + 40); }
    Object.values(state.layout.gates).forEach(function (p) { ext(p.x, p.y, GATE_W, GATE_H); });
    Object.values(state.layout.inputs).forEach(function (p) { ext(p.x, p.y, PIN_W, PIN_H); });
    Object.values(state.layout.outputs).forEach(function (p) { ext(p.x, p.y, PIN_W, PIN_H); });
    return { w: w, h: h };
  }
  function portPos(kind, id, which) {
    var L = state.layout;
    if (kind === 'gate') {
      var g = L.gates[id]; if (!g) return null;
      if (which === 'out') return { x: g.x + GATE_W, y: g.y + GATE_H / 2 };
      if (which === 'a') return { x: g.x, y: g.y + 14 };
      return { x: g.x, y: g.y + 34 };
    }
    if (kind === 'input') {
      var p = L.inputs[id]; if (!p) return null;
      return { x: p.x + PIN_W, y: p.y + PIN_H / 2 };
    }
    var o = L.outputs[id]; if (!o) return null;
    return { x: o.x, y: o.y + PIN_H / 2 };
  }
  function srcPortPos(s) {
    if (!s) return null;
    return s.k === 'i' ? portPos('input', s.id, 'out') : portPos('gate', s.id, 'out');
  }

  // ------------------------------------------------------------ render
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function renderAll() {
    renderTemplates();
    renderCanvas();
    updateLive();
    renderCost();
    renderNetlist();
    $('circuit-name').textContent = state.circuitName;
    $('btn-undo').disabled = !history.length;
    $('btn-redo').disabled = !redoStack.length;
    $('btn-delete').disabled = !selected;
  }

  function renderTemplates() {
    var el = $('template-list');
    el.innerHTML = TF.TEMPLATES.map(function (t) {
      return '<button class="tpl' + (state.templateId === t.id ? ' active' : '') + '" data-tpl="' + t.id + '">' +
        '<b>' + esc(t.name) + '</b><span class="gates">' + t.gates + ' NAND gates</span>' +
        '<p>' + esc(t.blurb) + '</p></button>';
    }).join('');
  }

  function renderCanvas() {
    var c = state.circuit;
    var sim = TF.simulate(c, c.inputs.map(function (p) { return state.inputValues[p.id] || 0; }));
    var gateVals = (sim && !sim.error) ? sim.gateValues : {};
    var outVals = (sim && !sim.error) ? sim.outputs : [];
    var outValById = {};
    c.outputs.forEach(function (o, i) { outValById[o.id] = outVals[i]; });

    var s = '';
    // wires (under the nodes)
    function wirePath(p1, p2) {
      var dx = Math.max(30, Math.abs(p2.x - p1.x) / 2);
      return 'M ' + p1.x + ' ' + p1.y + ' C ' + (p1.x + dx) + ' ' + p1.y + ', ' + (p2.x - dx) + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
    }
    c.gates.forEach(function (g) {
      [['a', g.a], ['b', g.b]].forEach(function (pair) {
        var which = pair[0], src = pair[1];
        var p1 = srcPortPos(src), p2 = portPos('gate', g.id, which);
        if (!p1 || !p2) return;
        var key = 'gate:' + g.id + ':' + which;
        s += '<path class="wire" d="' + wirePath(p1, p2) + '"/>' +
             '<path class="wire-hit" data-wire="' + key + '" d="' + wirePath(p1, p2) + '"><title>Click to remove this wire</title></path>';
      });
    });
    c.outputs.forEach(function (o) {
      var p1 = srcPortPos(o.src), p2 = portPos('output', o.id, 'in');
      if (!p1 || !p2) return;
      var key = 'output:' + o.id;
      s += '<path class="wire" d="' + wirePath(p1, p2) + '"/>' +
           '<path class="wire-hit" data-wire="' + key + '" d="' + wirePath(p1, p2) + '"><title>Click to remove this wire</title></path>';
    });
    // pending wire follows the mouse
    if (pendingWire && mousePos) {
      var sp = srcPortPos(pendingWire);
      if (sp) s += '<path class="wire-pending" d="' + wirePath(sp, mousePos) + '"/>';
    }
    // input pins
    c.inputs.forEach(function (p) {
      var pos = state.layout.inputs[p.id]; if (!pos) return;
      var v = state.inputValues[p.id] || 0;
      s += '<g class="pin' + (selected && selected.kind === 'input' && selected.id === p.id ? ' selected' : '') + '" data-node="input" data-id="' + p.id + '">' +
        '<rect class="body" x="' + pos.x + '" y="' + pos.y + '" width="' + PIN_W + '" height="' + PIN_H + '" rx="5"/>' +
        '<text x="' + (pos.x + 8) + '" y="' + (pos.y + 13) + '">' + esc(p.name) + '</text>' +
        '<text class="val" x="' + (pos.x + 8) + '" y="' + (pos.y + 25) + '" fill="' + (v ? '#34d399' : '#8a97a8') + '">' + v + '</text>' +
        '</g>' +
        '<circle class="port' + (pendingWire && pendingWire.k === 'i' && pendingWire.id === p.id ? ' source' : '') + '" data-port="out" data-kind="input" data-id="' + p.id + '" cx="' + (pos.x + PIN_W) + '" cy="' + (pos.y + PIN_H / 2) + '" r="7"><title>Output port — click, then click a gate input or output pin</title></circle>';
    });
    // gates
    c.gates.forEach(function (g, i) {
      var pos = state.layout.gates[g.id]; if (!pos) return;
      var v = gateVals[g.id];
      var sel = selected && selected.kind === 'gate' && selected.id === g.id;
      s += '<g class="gate' + (sel ? ' selected' : '') + '" data-node="gate" data-id="' + g.id + '">' +
        '<rect class="body" x="' + pos.x + '" y="' + pos.y + '" width="' + GATE_W + '" height="' + GATE_H + '" rx="6"/>' +
        '<text x="' + (pos.x + 10) + '" y="' + (pos.y + 20) + '">NAND</text>' +
        '<text class="idx" x="' + (pos.x + 10) + '" y="' + (pos.y + 36) + '">G' + i + (v === undefined ? '' : ' = ' + v) + '</text>' +
        '</g>';
      [['a', 14], ['b', 34]].forEach(function (pair) {
        var which = pair[0], py = pos.y + pair[1];
        var isTarget = !!pendingWire;
        s += '<circle class="port' + (isTarget ? ' target-ok' : '') + '" data-port="' + which + '" data-kind="gate" data-id="' + g.id + '" cx="' + pos.x + '" cy="' + py + '" r="7"><title>Input ' + which.toUpperCase() + ' — click to connect the pending wire here</title></circle>';
      });
      s += '<circle class="port' + (pendingWire && pendingWire.k === 'g' && pendingWire.id === g.id ? ' source' : '') + '" data-port="out" data-kind="gate" data-id="' + g.id + '" cx="' + (pos.x + GATE_W) + '" cy="' + (pos.y + GATE_H / 2) + '" r="7"><title>Output — click, then click a gate input or output pin</title></circle>';
    });
    // output pins
    c.outputs.forEach(function (o) {
      var pos = state.layout.outputs[o.id]; if (!pos) return;
      var v = outValById[o.id];
      s += '<g class="pin out" data-node="output" data-id="' + o.id + '">' +
        '<rect class="body" x="' + pos.x + '" y="' + pos.y + '" width="' + PIN_W + '" height="' + PIN_H + '" rx="5"/>' +
        '<text x="' + (pos.x + 8) + '" y="' + (pos.y + 13) + '">' + esc(o.name) + '</text>' +
        '<text class="val" x="' + (pos.x + 8) + '" y="' + (pos.y + 25) + '" fill="' + (v ? '#34d399' : '#8a97a8') + '">' + (v === undefined ? '–' : v) + '</text>' +
        '</g>' +
        '<circle class="port' + (pendingWire ? ' target-ok' : '') + '" data-port="in" data-kind="output" data-id="' + o.id + '" cx="' + pos.x + '" cy="' + (pos.y + PIN_H / 2) + '" r="7"><title>Input — click to connect the pending wire here</title></circle>';
    });
    var size = canvasSize();
    var z = currentZoom(size);
    // viewBox keeps all coordinates in circuit units, so dragging, wiring
    // and hit-testing (via getScreenCTM) work unchanged at any zoom; the
    // width/height attributes scale the rendered size, and #canvas-scroll
    // scrolls over it. Default is Fit, so the widest templates (comparator
    // ~4,494 px, adder ~2,454 px) are visible whole instead of starting
    // scrolled to a corner of a much wider canvas.
    svg.setAttribute('viewBox', '0 0 ' + size.w + ' ' + size.h);
    svg.setAttribute('width', Math.max(1, Math.round(size.w * z)));
    svg.setAttribute('height', Math.max(1, Math.round(size.h * z)));
    svg.innerHTML = s;
    var cs2 = $('canvas-size');
    if (cs2) cs2.textContent = size.w + ' × ' + size.h + ' px · ' + Math.round(z * 100) + '%';
    var zl = $('zoom-label');
    if (zl) zl.textContent = Math.round(z * 100) + '%';
  }

  function updateLive() {
    var c = state.circuit;
    var sim = TF.simulate(c, c.inputs.map(function (p) { return state.inputValues[p.id] || 0; }));
    var el = $('live-status');
    var parts = ['<span class="ok">' + c.gates.length + ' gates · ' + c.inputs.length + ' inputs · ' + c.outputs.length + ' outputs</span>'];
    if (sim.error) parts.push('<span class="err">⚠ ' + esc(sim.error) + '</span>');
    else {
      if (sim.warnings.unconnected) parts.push('<span class="warn">⚠ ' + sim.warnings.unconnected + ' gate input(s) unconnected (read as 0)</span>');
      if (sim.warnings.unwiredOutputs) parts.push('<span class="warn">⚠ ' + sim.warnings.unwiredOutputs + ' output(s) unwired</span>');
      if (!sim.warnings.unconnected && !sim.warnings.unwiredOutputs) parts.push('<span class="ok">live simulation OK</span>');
    }
    el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }

  // ------------------------------------------------------------ verify UI
  function runVerify() {
    var tpl = state.templateId ? TF.TEMPLATES.find(function (t) { return t.id === state.templateId; }) : null;
    var expectedFn = tpl ? tpl.expected : null;
    var t0 = Date.now();
    var r = TF.verifyCircuit(state.circuit, expectedFn);
    lastVerify = r;
    var box = $('verify-summary'), wrap = $('verify-table-wrap');
    if (r.error) {
      box.innerHTML = '<span class="fail">Cannot verify: ' + esc(r.error) + '</span>';
      wrap.innerHTML = '';
      return;
    }
    var head = r.failed === 0
      ? '<span class="pass">✓ ' + r.passed.toLocaleString() + '/' + r.total.toLocaleString() + ' cases pass</span>'
      : '<span class="fail">✗ ' + r.passed.toLocaleString() + '/' + r.total.toLocaleString() + ' pass — ' + r.failed.toLocaleString() + ' fail</span>';
    head += ' <span style="color:var(--muted)">(' + (r.sampled ? 'sampled, deterministic' : 'exhaustive') + ', ' + (Date.now() - t0) + ' ms)</span>';
    if (!expectedFn) head += '<br><span style="color:var(--muted)">No expected function for a custom circuit — showing simulated outputs only (structural checks: no loops, ' + r.unconnected + ' unconnected inputs, ' + r.unwiredOutputs + ' unwired outputs).</span>';
    box.innerHTML = head;

    // Truth table: failures first, then the first passing cases (max 40 rows).
    var c = state.circuit;
    var rows = [];
    function rowFor(bits) {
      var got = TF.simulate(c, bits).outputs;
      var exp = expectedFn ? expectedFn(bits) : null;
      var ok = !exp || got.every(function (v, i) { return v === exp[i]; });
      return { bits: bits, got: got, exp: exp, ok: ok };
    }
    r.failures.forEach(function (f) { rows.push({ bits: f.bits, got: f.got, exp: f.expected, ok: false }); });
    if (!r.sampled) {
      var need = Math.max(0, 40 - rows.length);
      for (var cs = 0; cs < Math.min(need, r.total); cs++) {
        var bits = c.inputs.map(function (_, i) { return (cs >> i) & 1; });
        var row = rowFor(bits);
        if (row.ok) rows.push(row);
      }
    }
    if (!rows.length) { wrap.innerHTML = '<p class="panel-note">No rows to show.</p>'; return; }
    var h = '<table><thead><tr>' +
      c.inputs.map(function (p) { return '<th class="mono">' + esc(p.name) + '</th>'; }).join('') +
      c.outputs.map(function (o) { return '<th class="mono">' + esc(o.name) + '</th>'; }).join('') +
      (expectedFn ? c.outputs.map(function (o) { return '<th class="mono">exp ' + esc(o.name) + '</th>'; }).join('') : '') +
      (expectedFn ? '<th>Result</th>' : '') + '</tr></thead><tbody>';
    rows.forEach(function (row) {
      h += '<tr>' + row.bits.map(function (b) { return '<td class="mono">' + b + '</td>'; }).join('') +
        row.got.map(function (g) { return '<td class="mono">' + g + '</td>'; }).join('') +
        (row.exp ? row.exp.map(function (e) { return '<td class="mono">' + e + '</td>'; }).join('') : '') +
        (expectedFn ? '<td class="' + (row.ok ? 'pass' : 'fail') + '">' + (row.ok ? '✓' : '✗ FAIL') + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table>';
    if (r.total > rows.length) h += '<p class="panel-note">Showing ' + rows.length + ' of ' + r.total.toLocaleString() + ' cases' + (r.failed ? ' (all ' + r.failed + ' failures shown first)' : ' (first cases)') + '.</p>';
    wrap.innerHTML = h;
  }

  // ------------------------------------------------------------ cost UI
  function cheapestAvailable() {
    var best = null;
    processors.forEach(function (p, i) {
      if (p.minted < p.cap && (!best || p.priceOkb < processors[best].priceOkb)) best = i;
    });
    return best;
  }
  function renderCost() {
    var cheapest = cheapestAvailable();
    $('processor-body').innerHTML = processors.map(function (p, i) {
      var soldOut = p.minted >= p.cap;
      var tags = '';
      if (i === cheapest) tags += '<span class="tag cheapest">cheapest</span>';
      if (p.circuits >= 1000 && !soldOut) tags += '<span class="tag">proven fab</span>';
      if (soldOut) tags += '<span class="tag soldout">sold out</span>';
      return '<tr data-proc="' + i + '" class="' + (i === selectedProc ? 'selected' : '') + '">' +
        '<td><b>' + esc(p.name) + '</b>' + tags + '<br><span style="color:var(--muted)">' + esc(p.note) + '</span><br>' +
        '<span class="mono" style="color:var(--muted);font-size:10px">' + p.address.slice(0, 10) + '…' + p.address.slice(-6) + '</span></td>' +
        '<td class="mono">' + TF.formatOkb(p.priceOkb) + ' OKB</td>' +
        '<td class="mono">' + p.circuits.toLocaleString() + '</td>' +
        '<td class="mono">' + p.minted.toLocaleString() + ' / ' + (p.cap >= 1e15 ? p.cap.toExponential(0) : p.cap.toLocaleString()) + '</td></tr>';
    }).join('');
    var p = processors[selectedProc];
    var gates = state.circuit.gates.length;
    var est = TF.costEstimate(gates, p.priceOkb);
    var openFee = $('chk-open-fee').checked ? TF.PROCESSOR_OPEN_FEE_OKB : 0;
    var total = est.total + openFee;
    var usd = total * OKB_USD;
    $('cost-breakdown').innerHTML =
      '<div class="row"><span>Processor</span><span class="num">' + esc(p.name) + '</span></div>' +
      '<div class="row"><span>Transistors (1 per gate)</span><span class="num">' + gates + ' × ' + TF.formatOkb(p.priceOkb) + ' OKB</span></div>' +
      '<div class="row"><span>Transistor cost</span><span class="num">' + TF.formatOkb(est.transistorCost) + ' OKB</span></div>' +
      '<div class="row"><span>Tape-out fee</span><span class="num">' + TF.formatOkb(est.tapeoutFee) + ' OKB</span></div>' +
      (openFee ? '<div class="row"><span>Processor-opening fee</span><span class="num">' + TF.formatOkb(openFee) + ' OKB</span></div>' : '') +
      '<div class="row total"><span>Estimated total</span><span>' + TF.formatOkb(total) + ' OKB ≈ $' + usd.toFixed(2) + '</span></div>';
    var src = $('data-source');
    var label = dataLive
      ? '<b class="live">LIVE</b> from X Layer RPC · block ' + liveBlock + ' · ' + liveAt
      : '<b>cached snapshot</b> · <span id="snapshot-date">' + SNAPSHOT_AT + '</span>';
    src.innerHTML = 'Data: ' + label + ' · <button id="btn-refresh" class="small">↻ Refresh live</button> <span id="refresh-status"></span>';
    $('btn-refresh').addEventListener('click', refreshLive);
  }
  function renderNetlist() {
    $('netlist-view').textContent = TF.exportNetlist(state.circuit, state.circuitName);
  }

  // ------------------------------------------------------------ live RPC
  function rpcCall(url, payload) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function word(h, i) {
    i = i || 0;
    if (!h || typeof h !== 'string') return 0;
    return parseInt(h.slice(2 + i * 64, 2 + i * 64 + 64) || '0', 16);
  }
  function addr(h) { return h ? '0x' + h.slice(26, 66) : '0x' + '0'.repeat(40); }
  function batch(url, pairs) {
    // pairs: [[to, data], ...] — max 10 per batch (public RPC limit)
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < pairs.length; i += 10) {
      (function (part) {
        chain = chain.then(function () {
          return rpcCall(url, part.map(function (p, k) {
            return { jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: p[0], data: p[1] }, 'latest'] };
          })).then(function (res) {
            var byId = {};
            (Array.isArray(res) ? res : [res]).forEach(function (o) { byId[o.id] = o.result; });
            part.forEach(function (_, k) { out.push(byId[k]); });
          });
        }).then(function () { return new Promise(function (r) { setTimeout(r, 250); }); });
      })(pairs.slice(i, i + 10));
    }
    return chain.then(function () { return out; });
  }
  function refreshLive() {
    var status = $('refresh-status');
    if (status) status.textContent = 'reading…';
    var chain = Promise.resolve(null);
    RPCS.forEach(function (url) {
      chain = chain.then(function (found) {
        if (found) return found;
        return rpcCall(url, { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] })
          .then(function (r) { return r.result === '0xc4' ? url : null; })
          .catch(function () { return null; });
      });
    });
    chain.then(function (url) {
      if (!url) throw new Error('no X Layer RPC reachable (tried ' + RPCS.join(', ') + ')');
      var pairs = [];
      processors.forEach(function (p) {
        pairs.push([p.address, SEL.transistors]);
        pairs.push([p.transistor, SEL.price]);
        pairs.push([p.address, SEL.nextId]);
        pairs.push([p.transistor, SEL.minted]);
        pairs.push([p.transistor, SEL.cap]);
      });
      return batch(url, pairs).then(function (res) {
        return rpcCall(url, { jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] })
          .then(function (b) { return { url: url, res: res, block: parseInt(b.result, 16) }; });
      });
    }).then(function (done) {
      processors.forEach(function (p, i) {
        var r = done.res.slice(i * 5, i * 5 + 5);
        var token = addr(r[0]);
        var priceWei = String(word(r[1]));
        var circuits = word(r[2]);
        var minted = word(r[3]);
        var cap = word(r[4]);
        if (token !== '0x0000000000000000000000000000000000000000') p.transistor = token;
        p.priceWei = priceWei;
        p.priceOkb = Number(BigInt(priceWei)) / 1e18;
        p.circuits = circuits; p.minted = minted; p.cap = cap;
      });
      dataLive = true; liveBlock = done.block.toLocaleString();
      liveAt = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
      renderCost();
    }).catch(function (e) {
      var s2 = $('refresh-status');
      if (s2) s2.textContent = 'live read failed (' + e.message + ') — showing snapshot';
    });
  }

  // ------------------------------------------------------------ actions
  function loadTemplate(tpl) {
    if (state.circuit) commit(); // no history entry for the very first load
    state.circuit = tpl.build();
    state.layout = autoLayout(state.circuit);
    state.inputValues = {};
    state.circuit.inputs.forEach(function (p) { state.inputValues[p.id] = 0; });
    state.counters = { gate: state.circuit.gates.length, input: state.circuit.inputs.length, output: state.circuit.outputs.length };
    state.templateId = tpl.id;
    state.circuitName = tpl.name;
    lastVerify = null;
    $('verify-summary').innerHTML = 'Press <b>Verify circuit</b> to run it.';
    $('verify-table-wrap').innerHTML = '';
    var cs = $('canvas-scroll');
    if (cs) { cs.scrollLeft = 0; cs.scrollTop = 0; } // new template starts top-left
    renderAll();
  }
  function addGate() {
    commit();
    var c = state.circuit;
    var maxRight = 150;
    Object.values(state.layout.gates).forEach(function (p) { maxRight = Math.max(maxRight, p.x + GATE_W); });
    var id = 'g' + (state.counters.gate++);
    c.gates.push({ id: id, a: null, b: null });
    state.layout.gates[id] = { x: maxRight + 40, y: 60 };
    // keep output pins to the right of the new gate
    var need = maxRight + 40 + GATE_W + 60;
    Object.values(state.layout.outputs).forEach(function (p) { if (p.x < need) p.x = need; });
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }
  function addPin(kind) {
    commit();
    var c = state.circuit;
    if (kind === 'input') {
      var id = 'in' + (state.counters.input++);
      var name = 'IN' + c.inputs.length;
      c.inputs.push({ id: id, name: name });
      state.layout.inputs[id] = { x: 20, y: 30 + (c.inputs.length - 1) * 44 };
      state.inputValues[id] = 0;
    } else {
      var oid = 'out' + (state.counters.output++);
      var oname = 'OUT' + c.outputs.length;
      c.outputs.push({ id: oid, name: oname, src: null });
      var maxRight = 260;
      Object.values(state.layout.gates).forEach(function (p) { maxRight = Math.max(maxRight, p.x + GATE_W + 60); });
      state.layout.outputs[oid] = { x: maxRight, y: 30 + (c.outputs.length - 1) * 44 };
    }
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }
  function deleteSelected() {
    if (!selected) return;
    commit();
    var c = state.circuit;
    if (selected.kind === 'gate') {
      c.gates = c.gates.filter(function (g) { return g.id !== selected.id; });
      c.gates.forEach(function (g) {
        if (g.a && g.a.k === 'g' && g.a.id === selected.id) g.a = null;
        if (g.b && g.b.k === 'g' && g.b.id === selected.id) g.b = null;
      });
      c.outputs.forEach(function (o) { if (o.src && o.src.k === 'g' && o.src.id === selected.id) o.src = null; });
      delete state.layout.gates[selected.id];
    } else if (selected.kind === 'input') {
      c.inputs = c.inputs.filter(function (p) { return p.id !== selected.id; });
      c.gates.forEach(function (g) {
        if (g.a && g.a.k === 'i' && g.a.id === selected.id) g.a = null;
        if (g.b && g.b.k === 'i' && g.b.id === selected.id) g.b = null;
      });
      c.outputs.forEach(function (o) { if (o.src && o.src.k === 'i' && o.src.id === selected.id) o.src = null; });
      delete state.layout.inputs[selected.id];
      delete state.inputValues[selected.id];
    } else {
      c.outputs = c.outputs.filter(function (o) { return o.id !== selected.id; });
      delete state.layout.outputs[selected.id];
    }
    selected = null;
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }
  function deleteWire(key) {
    commit();
    var parts = key.split(':');
    var c = state.circuit;
    if (parts[0] === 'gate') {
      var g = c.gates.find(function (x) { return x.id === parts[1]; });
      if (g) g[parts[2]] = null;
    } else {
      var o = c.outputs.find(function (x) { return x.id === parts[1]; });
      if (o) o.src = null;
    }
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }
  function completeWire(target) {
    // target: {kind:'gate', id, which:'a'|'b'} or {kind:'output', id}
    commit();
    var c = state.circuit;
    if (target.kind === 'gate') {
      var g = c.gates.find(function (x) { return x.id === target.id; });
      if (g) g[target.which] = { k: pendingWire.k, id: pendingWire.id };
    } else {
      var o = c.outputs.find(function (x) { return x.id === target.id; });
      if (o) o.src = { k: pendingWire.k, id: pendingWire.id };
    }
    pendingWire = null;
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }

  // ------------------------------------------------------------ events
  function svgPoint(e) {
    var pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  svg.addEventListener('pointerdown', function (e) {
    var port = e.target.closest('[data-port]');
    if (port) {
      var kind = port.getAttribute('data-kind'), id = port.getAttribute('data-id'), which = port.getAttribute('data-port');
      if (which === 'out') {
        // source port: start (or switch) a pending wire
        pendingWire = { k: kind === 'input' ? 'i' : 'g', id: id };
        mousePos = svgPoint(e);
        renderCanvas();
      } else {
        // target port: complete the pending wire
        if (pendingWire) completeWire({ kind: kind, id: id, which: which });
      }
      e.stopPropagation();
      return;
    }
    var node = e.target.closest('[data-node]');
    if (node && node.getAttribute('data-node') === 'gate') {
      var gid = node.getAttribute('data-id');
      var pos = state.layout.gates[gid];
      var p = svgPoint(e);
      drag = { id: gid, dx: p.x - pos.x, dy: p.y - pos.y, moved: false, committed: false };
      selected = { kind: 'gate', id: gid };
      renderCanvas();
      e.stopPropagation();
    }
  });
  svg.addEventListener('pointermove', function (e) {
    var p = svgPoint(e);
    if (pendingWire) { mousePos = p; renderCanvas(); return; }
    if (drag) {
      var pos = state.layout.gates[drag.id];
      var nx = p.x - drag.dx, ny = p.y - drag.dy;
      if (Math.abs(nx - pos.x) > 4 || Math.abs(ny - pos.y) > 4) {
        if (!drag.committed) { commit(); drag.committed = true; }
        drag.moved = true;
      }
      if (drag.moved) {
        pos.x = Math.max(0, Math.round(nx));
        pos.y = Math.max(0, Math.round(ny));
        renderCanvas();
      }
    }
  });
  svg.addEventListener('pointerup', function () { drag = null; });
  // Single click on a pin toggles it (input) or selects it (output);
  // a double click renames it. A short timer tells the two apart so a
  // double click does not also toggle the value.
  var clickTimer = null, clickTarget = null;
  function renamePin(kind, id) {
    var list = kind === 'input' ? state.circuit.inputs : state.circuit.outputs;
    var pin = list.find(function (x) { return x.id === id; });
    if (!pin) return;
    var name = window.prompt('Rename pin "' + pin.name + '" to:', pin.name);
    if (name && name.trim() && name.trim() !== pin.name) {
      commit();
      pin.name = name.trim().replace(/\s+/g, '_').slice(0, 12);
      state.templateId = null; state.circuitName = 'Custom circuit';
      renderAll();
    }
  }
  function handlePinClick(kind, id) {
    var key = kind + ':' + id;
    if (clickTimer && clickTarget === key) {
      clearTimeout(clickTimer); clickTimer = null; clickTarget = null;
      renamePin(kind, id);
      return;
    }
    clickTarget = key;
    clickTimer = setTimeout(function () {
      clickTimer = null; clickTarget = null;
      if (kind === 'input') {
        commit();
        state.inputValues[id] = state.inputValues[id] ? 0 : 1;
        selected = { kind: 'input', id: id };
        renderAll();
      } else if (kind === 'output') {
        selected = { kind: 'output', id: id };
        renderCanvas();
      }
    }, 260);
  }
  svg.addEventListener('click', function (e) {
    var wire = e.target.closest('[data-wire]');
    if (wire) { deleteWire(wire.getAttribute('data-wire')); return; }
    var port = e.target.closest('[data-port]');
    if (port) return; // handled in pointerdown
    var node = e.target.closest('[data-node]');
    if (node) {
      var kind = node.getAttribute('data-node'), id = node.getAttribute('data-id');
      if (kind === 'gate') {
        selected = { kind: 'gate', id: id };
        renderCanvas();
      } else {
        handlePinClick(kind, id);
      }
      return;
    }
    // clicked empty canvas: cancel a pending wire / clear selection
    if (pendingWire) { pendingWire = null; renderCanvas(); }
    else if (selected) { selected = null; renderCanvas(); }
  });
  svg.addEventListener('contextmenu', function (e) {
    var node = e.target.closest('[data-node]');
    if (!node) return;
    e.preventDefault();
    selected = { kind: node.getAttribute('data-node'), id: node.getAttribute('data-id') };
    deleteSelected();
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected) { e.preventDefault(); deleteSelected(); } }
    else if (e.key === 'Escape' && pendingWire) { pendingWire = null; renderCanvas(); }
  });

  $('template-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-tpl]');
    if (!btn) return;
    var tpl = TF.TEMPLATES.find(function (t) { return t.id === btn.getAttribute('data-tpl'); });
    if (tpl) loadTemplate(tpl);
  });
  $('processor-body').addEventListener('click', function (e) {
    var tr = e.target.closest('[data-proc]');
    if (!tr) return;
    selectedProc = +tr.getAttribute('data-proc');
    renderCost();
  });
  $('btn-add-gate').addEventListener('click', addGate);
  $('btn-add-input').addEventListener('click', function () { addPin('input'); });
  $('btn-add-output').addEventListener('click', function () { addPin('output'); });
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-clear').addEventListener('click', function () {
    if (!window.confirm('Clear the whole circuit? (Undo restores it.)')) return;
    commit();
    state.circuit = { inputs: [], gates: [], outputs: [] };
    state.layout = { gates: {}, inputs: {}, outputs: {} };
    state.inputValues = {};
    state.templateId = null; state.circuitName = 'Custom circuit';
    lastVerify = null;
    $('verify-summary').innerHTML = 'Press <b>Verify circuit</b> to run it.';
    $('verify-table-wrap').innerHTML = '';
    renderAll();
  });
  $('btn-verify').addEventListener('click', runVerify);
  $('btn-zoom-in').addEventListener('click', function () { setZoom('in'); });
  $('btn-zoom-out').addEventListener('click', function () { setZoom('out'); });
  $('btn-zoom-fit').addEventListener('click', function () { setZoom('fit'); });
  $('btn-zoom-100').addEventListener('click', function () { setZoom('100'); });
  $('hint-close').addEventListener('click', function () {
    var h = $('hint-bar');
    if (h) h.setAttribute('hidden', ''); // hidden by #hint-bar[hidden] in style.css
  });
  $('chk-open-fee').addEventListener('change', renderCost);
  $('btn-download').addEventListener('click', function () {
    var text = TF.exportNetlist(state.circuit, state.circuitName);
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tapeforge-' + state.circuitName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  $('btn-copy').addEventListener('click', function () {
    var text = TF.exportNetlist(state.circuit, state.circuitName);
    var done = function () { $('btn-copy').textContent = '✓ Copied'; setTimeout(function () { $('btn-copy').textContent = '⧉ Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ------------------------------------------------------------ init
  // Test/debug handle (used by smoke-test.js). Harmless in the browser.
  window.TapeForgeApp = {
    loadTemplate: loadTemplate, runVerify: runVerify,
    undo: undo, redo: redo, refreshLive: refreshLive,
    getState: function () { return state; },
    getProcessors: function () { return processors; },
    isLive: function () { return dataLive; }
  };
  loadTemplate(TF.TEMPLATES.find(function (t) { return t.id === 'consensus'; }));
  // Re-fit on window resize when in Fit mode (guarded: the headless DOM shim
  // has no window.addEventListener).
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () { if (zoomMode === 'fit') renderCanvas(); });
  }
  // Background live refresh: tries the public X Layer RPC, falls back to the
  // cached snapshot (already rendered) if it is unreachable.
  setTimeout(refreshLive, 800);
})();

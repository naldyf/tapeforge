// TapeForge — UI layer. Plain DOM + SVG, no framework, no network except the
// optional X Layer RPC read (refreshLive). All circuit logic lives in circuit.js.
//
// Audit fixes (2026-11-25): all money is integer wei (BigInt) end to end;
// RPC reads pin a block first and publish only a fully validated quote;
// verify/export/cost all run against the DECODED protocol payload.
(function () {
  'use strict';
  var TF = window.TapeForgeCircuit;

  // ------------------------------------------------------------ data
  var FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
  var RPCS = ['https://rpc.xlayer.tech', 'https://tapeout.net/rpc-xlayer'];
  // Selectors from the public TapeOut read script (openwitness.net/p/9897),
  // plus the fee selectors verified live on X Layer (audit §3):
  //   mintPrice    0x6817c76c — transistor TOKEN contract
  //   protocolFee  0xb0e21e8a — transistor TOKEN contract
  //   TAPEOUT_FEE  0xadfb2b69 — PROCESSOR contract
  //   deployFee    0xeb2a5d2c — FACTORY contract
  var SEL = {
    transistors: '0x6fbd1719', nextId: '0x61b8ce8c',
    price: '0x6817c76c', minted: '0x4f02c420', cap: '0x8f770ad0',
    protocolFee: '0xb0e21e8a', tapeoutFee: '0xadfb2b69', deployFee: '0xeb2a5d2c'
  };
  var OKB_USD = 79; // approx OKB price, 25 Nov 2026 — estimate only

  // Cached snapshot — real X Layer processors, read from chain 2026-11-25T12:53:31Z
  // (factory cpuCount/cpuAt/transistors/nextId/price/minted/cap via public RPC).
  // Names FAB-Genisis / TAPELIQUID / 9898 are from the 23 Oct 2026 openwitness
  // survey; their addresses match that survey's price + circuit-count signature.
  // Totals at snapshot time: 450 processors, 12,242 circuits, median price 0.00066 OKB.
  // minted/cap/circuits are DECIMAL STRINGS: some caps (1e24) exceed the
  // exact-integer range of a JS number, so all arithmetic on them is BigInt.
  // protocolFeeWei / tapeoutFeeWei are also per-processor DECIMAL STRINGS,
  // read live on X Layer (block 76,845,204): protocolFee is PER TOKEN and
  // differs — 660,000,000,000,000 wei (0.00066 OKB) on 9898, FAB-Genisis,
  // TAPELIQUID and XBOT, but 1,000,000 wei on ViperX and Cheapest. It must
  // never be assumed equal across processors (the old code threw
  // "protocolFee differs" and the live refresh could never succeed).
  // TAPEOUT_FEE is 1,300,000,000,000,000 wei (0.0013 OKB) on all six today.
  var SNAPSHOT_AT = '25 Nov 2026, 12:53 UTC';
  var processors = [
    { name: '9898', address: '0x60918c204f3c94630d3d793738fc36293c8405d6', transistor: '0x0f7e9ed401fe35010ebc4d021a204ba031a23194', priceWei: '1000000000000', minted: '16511', cap: '1000000000000', circuits: '1022', protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000', note: 'cheapest proven fab' },
    { name: 'FAB-Genisis', address: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6', transistor: '0xbe6f94115d32f3ac3252bc4626573e739beeb714', priceWei: '500000000000000', minted: '1000000', cap: '1000000', circuits: '7164', protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000', note: 'most circuits' },
    { name: 'TAPELIQUID', address: '0x69f663931209096037474d7c20402232e5c762ca', transistor: '0x3fa393d3081accff9e7989619b688235f6d3ee3f', priceWei: '660000000000000', minted: '2100000', cap: '2100000', circuits: '1408', protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000', note: 'median price' },
    { name: 'XBOT', address: '0xa5fc69Ca2D3d462CCa204D894D85ac8071c4F0f0', transistor: '0x7bE7280e31984d18f62218519985EC5DcCa751De', priceWei: '9000000000000000', minted: '40', cap: '1000000000', circuits: '5', protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000', note: 'consensus-circuit processor' },
    { name: 'ViperX', address: '0xb57b56034e2dc25161e2512CfC40b24EA3bee1Fb', transistor: '0xfce5366485140045e95ebdba88ad775fc4aad79f', priceWei: '0', minted: '158', cap: '158', circuits: '4', protocolFeeWei: '1000000', tapeoutFeeWei: '1300000000000000', note: 'free, sold out' },
    { name: 'Cheapest available', address: '0x99081e1d0ce916cd5b2c53e769dfc3b000bfe9a4', transistor: '0x80a7eb72bc4e559c47304efe6a0f6e73717df5cb', priceWei: '1', minted: '281', cap: '1000000000000000000000000', circuits: '19', protocolFeeWei: '1000000', tapeoutFeeWei: '1300000000000000', note: '1 wei / transistor' }
  ];
  // The factory deploy fee is the only fee that is truly global (one value
  // from the factory contract). The old hardcoded 0.0066 OKB
  // "processor-opening fee" was stale and wrong — the live deployFee is
  // 10,000,000 wei = 0.00000000001 OKB. protocolFee and TAPEOUT_FEE are
  // per-processor and live on each processor object (see above).
  var liveFees = {
    deployFeeWei: 10000000n             // 0.00000000001 OKB
  };
  var dataLive = false, liveBlock = null, liveAt = null;
  var selectedProc = 0; // index into processors

  // ------------------------------------------------------------ state
  var state = {
    circuit: null, layout: { gates: {}, inputs: {}, outputs: {} },
    inputValues: {}, counters: { gate: 0, input: 0, output: 0 },
    templateId: null, circuitName: 'Custom circuit',
    // Revision counter: incremented on EVERY circuit mutation (commit,
    // restore, loadTemplate, Clear). Verify results and pending wires are
    // stamped with the revision they belong to; a mismatch means stale.
    revision: 0,
    // Expected function preserved across compatible edits (audit §2 High).
    // Set when a template loads; kept while the pin interface (input/output
    // ids, in order) is unchanged; dropped with a flag when it changes.
    // Renaming a pin does NOT change its id, so a rename keeps the function.
    expectedFn: null, expectedSig: null, expectedTemplateId: null,
    expectedDropped: false
  };
  var history = [], redoStack = [];
  var pendingWire = null; // {k:'i'|'g', id} source ref waiting for a target
  var pendingWireRev = null; // state.revision when the wire started
  var selected = null;    // {kind:'gate'|'input'|'output', id}
  var drag = null;        // {id, dx, dy, moved}
  var mousePos = null;    // svg coords while a wire is pending
  var lastVerify = null;  // {result, revision, snapshot}
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

  function bumpRevision() { state.revision++; }
  function circuitSnapshot() { return JSON.stringify(state.circuit); }
  function currentSig() {
    return {
      inputIds: state.circuit.inputs.map(function (p) { return p.id; }),
      outputIds: state.circuit.outputs.map(function (o) { return o.id; })
    };
  }
  // Drop the preserved expected function when the pin interface changed.
  // Called from renderAll so every mutation path is covered (addGate,
  // addPin, deleteSelected, deleteWire, completeWire, loadTemplate, Clear,
  // undo/redo, renamePin, input toggles).
  function checkExpectedSig() {
    if (!state.expectedFn) return;
    var sig = currentSig();
    var same = state.expectedSig &&
      sig.inputIds.join(',') === state.expectedSig.inputIds.join(',') &&
      sig.outputIds.join(',') === state.expectedSig.outputIds.join(',');
    if (!same) {
      state.expectedFn = null;
      state.expectedSig = null;
      state.expectedTemplateId = null;
      state.expectedDropped = true;
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({
      circuit: state.circuit, layout: state.layout, inputValues: state.inputValues,
      counters: state.counters, templateId: state.templateId, circuitName: state.circuitName,
      expectedSig: state.expectedSig, expectedTemplateId: state.expectedTemplateId,
      expectedDropped: state.expectedDropped
    }));
  }
  function restore(s) {
    state.circuit = s.circuit; state.layout = s.layout; state.inputValues = s.inputValues;
    state.counters = s.counters; state.templateId = s.templateId; state.circuitName = s.circuitName;
    state.expectedSig = s.expectedSig || null;
    state.expectedTemplateId = s.expectedTemplateId || null;
    state.expectedDropped = !!s.expectedDropped;
    // Re-derive the function from the template id (functions cannot be
    // JSON-serialised into history). If the restored circuit is the template
    // (or a compatible edit of it), its expected function comes back with it.
    state.expectedFn = null;
    if (state.expectedTemplateId) {
      var tpl = TF.TEMPLATES.find(function (t) { return t.id === state.expectedTemplateId; });
      if (tpl) state.expectedFn = tpl.expected;
    }
    cancelTransient();
    bumpRevision();
  }
  function commit() { history.push(snapshot()); if (history.length > 60) history.shift(); redoStack = []; bumpRevision(); }
  function undo() {
    if (!history.length) return;
    redoStack.push(snapshot()); restore(history.pop()); renderAll();
  }
  function redo() {
    if (!redoStack.length) return;
    history.push(snapshot()); restore(redoStack.pop()); renderAll();
  }

  // Cancel all transient editor state (audit §5 High): a pending wire, a
  // selection, a drag, the mouse position, and the pin-click timer. Called
  // whenever the circuit is replaced or restored, so no stale action can
  // land on a different circuit.
  var clickTimer = null, clickTarget = null;
  function cancelTransient() {
    pendingWire = null; pendingWireRev = null;
    selected = null; drag = null; mousePos = null;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickTarget = null; }
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
  function fmtBig(v) { return BigInt(v).toLocaleString('en-US'); }
  function fmtSupply(v) {
    var b = BigInt(v);
    return b >= 1000000000000000n ? Number(b).toExponential(0) : fmtBig(v);
  }
  function renderAll() {
    checkExpectedSig();
    // Stale verify results (audit §2 High): a result belongs to the exact
    // revision + circuit structure it was run on. Any mutation clears it.
    if (lastVerify && (lastVerify.revision !== state.revision || lastVerify.snapshot !== circuitSnapshot())) {
      lastVerify = null;
      $('verify-summary').innerHTML = 'Press <b>Verify circuit</b> to run it.';
      $('verify-table-wrap').innerHTML = '';
    }
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
    if (sim.error) {
      // A compile error (dangling reference, loop, duplicate id) is the
      // status — never "live simulation OK" on a broken circuit (§2/§5).
      parts.push('<span class="err">⚠ ' + esc(sim.error) + '</span>');
    } else {
      // Count unconnected ports INDIVIDUALLY (§1 Low) and unwired outputs
      // from the compile warnings carried by TF.simulate.
      var ups = sim.warnings.unconnectedPorts || [];
      var unw = sim.warnings.unwiredOutputs || [];
      if (ups.length) parts.push('<span class="warn">⚠ ' + ups.length + ' gate input(s) unconnected (read as 0)</span>');
      if (unw.length) parts.push('<span class="warn">⚠ ' + unw.length + ' output(s) unwired</span>');
      if (!ups.length && !unw.length) parts.push('<span class="ok">live simulation OK</span>');
    }
    el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }

  // ------------------------------------------------------------ verify UI
  function runVerify() {
    var expectedFn = state.expectedFn || null;
    var t0 = Date.now();
    var r = TF.verifyCircuit(state.circuit, expectedFn);
    lastVerify = { result: r, revision: state.revision, snapshot: circuitSnapshot() };
    var box = $('verify-summary'), wrap = $('verify-table-wrap');
    if (r.error) {
      // A structural error is never a pass count (§2 High): no "8/8 pass"
      // for a disconnected output, no "1/1 pass" for an empty canvas.
      box.innerHTML = '<span class="fail">Cannot verify: ' + esc(r.error) + '</span>';
      wrap.innerHTML = '';
      return;
    }
    var head;
    if (!r.hasExpected) {
      head = '<span class="ok">Simulated, no expected function — ' + r.total.toLocaleString() + ' cases simulated</span>' +
        ' <span style="color:var(--muted)">(' + (r.sampled ? 'sampled, deterministic' : 'exhaustive') + ', ' + r.gateCount + ' encoded gates' + (r.buffers ? ', incl. ' + r.buffers + ' buffer NANDs' : '') + ', ' + (Date.now() - t0) + ' ms)</span>';
      if (state.expectedDropped) head += '<br><span class="warn">Pin interface changed — the expected function no longer applies.</span>';
    } else {
      head = r.failed === 0
        ? '<span class="pass">✓ ' + r.passed.toLocaleString() + '/' + r.total.toLocaleString() + ' cases pass</span>'
        : '<span class="fail">✗ ' + r.passed.toLocaleString() + '/' + r.total.toLocaleString() + ' pass — ' + r.failed.toLocaleString() + ' fail</span>';
      head += ' <span style="color:var(--muted)">(' + (r.sampled ? 'sampled, deterministic' : 'exhaustive') + ', ' + r.gateCount + ' encoded gates' + (r.buffers ? ', incl. ' + r.buffers + ' buffer NANDs' : '') + ', ' + (Date.now() - t0) + ' ms)</span>';
    }
    box.innerHTML = head;

    // Truth table: failures first, then the first passing cases (max 40 rows).
    var c = state.circuit;
    var rows = [];
    function rowFor(bits) {
      var s2 = TF.simulate(c, bits);
      if (!s2 || s2.error) return null;
      var got = s2.outputs;
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
        if (row && row.ok) rows.push(row);
      }
    }
    if (!rows.length) {
      // Never claim "No rows to show" for a sampled run that retained none.
      wrap.innerHTML = '<p class="panel-note">' + (r.sampled ? 'Sampled run — no rows retained.' : 'No rows to show.') + '</p>';
      return;
    }
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
    // Label exactly what is shown (§2 Low): never claim all failures are
    // shown when the verifier retains at most 20 of them.
    var note;
    if (r.sampled) {
      note = 'Showing ' + rows.length + ' sampled cases of ' + r.total.toLocaleString();
      if (r.hasExpected && r.failed) note += ' (' + Math.min(r.failed, 20) + ' of ' + r.failed + ' failures shown first)';
      note += '.';
    } else {
      note = 'Showing ' + rows.length + ' of ' + r.total.toLocaleString() + ' cases';
      if (r.hasExpected && r.failed) note += r.failed <= 20 ? ' (all ' + r.failed + ' failures shown first)' : ' (first 20 of ' + r.failed + ' failures shown first)';
      else if (!r.hasExpected) note += ' (simulated outputs only)';
      else note += ' (first cases)';
      note += '.';
    }
    h += '<p class="panel-note">' + note + '</p>';
    wrap.innerHTML = h;
  }

  // ------------------------------------------------------------ cost UI
  // The quote counts the gates in the FINAL ENCODED circuit (including the
  // 2-NAND output buffers), never the editor gate count (§3 High).
  function encodedForCost() {
    var enc = TF.encodePayload(state.circuit);
    if (enc.error) return { error: enc.error };
    return { error: null, gates: enc.nGates, buffers: enc.buffers, bufferOutputs: enc.bufferOutputs };
  }
  // Cheapest among the six listed processors that can actually fill the
  // order: remaining supply (cap - minted, BigInt) must cover the encoded
  // gate count. best === null (not !best) so row 0 can win (§3 Medium).
  function cheapestAvailable(gates) {
    var best = null;
    processors.forEach(function (p, i) {
      var remaining = BigInt(p.cap) - BigInt(p.minted);
      if (remaining >= BigInt(gates) && (best === null || BigInt(p.priceWei) < BigInt(processors[best].priceWei))) best = i;
    });
    return best;
  }
  function renderCost() {
    var enc = encodedForCost();
    var cheapest = enc.error ? null : cheapestAvailable(enc.gates);
    $('processor-body').innerHTML = processors.map(function (p, i) {
      var soldOut = BigInt(p.minted) >= BigInt(p.cap);
      var remaining = BigInt(p.cap) - BigInt(p.minted);
      var canFill = !enc.error && remaining >= BigInt(enc.gates);
      var tags = '';
      if (i === cheapest) tags += '<span class="tag cheapest">cheapest</span>';
      if (BigInt(p.circuits) >= 1000n && !soldOut) tags += '<span class="tag">proven fab</span>';
      if (soldOut) tags += '<span class="tag soldout">sold out</span>';
      else if (!enc.error && !canFill) tags += '<span class="tag soldout">unavailable</span>';
      return '<tr data-proc="' + i + '" class="' + (i === selectedProc ? 'selected' : '') + '">' +
        '<td><b>' + esc(p.name) + '</b>' + tags + '<br><span style="color:var(--muted)">' + esc(p.note) + '</span><br>' +
        '<span class="mono" style="color:var(--muted);font-size:10px">' + p.address.slice(0, 10) + '…' + p.address.slice(-6) + '</span></td>' +
        '<td class="mono">' + TF.formatWei(BigInt(p.priceWei)) + ' OKB</td>' +
        '<td class="mono">' + fmtBig(p.circuits) + '</td>' +
        '<td class="mono">' + fmtBig(p.minted) + ' / ' + fmtSupply(p.cap) + '</td></tr>';
    }).join('');
    // Deploy-fee checkbox label shows the LIVE deployFee — never a hardcoded
    // value (§3 High: the old 0.0066 OKB was stale and wrong).
    var lbl = $('lbl-open-fee-text');
    if (lbl) lbl.textContent = 'Include processor-opening fee (' + TF.formatWei(liveFees.deployFeeWei) + ' OKB) — only if you open your own processor';
    var p = processors[selectedProc];
    var box = $('cost-breakdown');
    if (enc.error) {
      // No quote at all for a circuit that cannot be encoded (§3 High).
      box.innerHTML = '<div class="row"><span>No quote</span><span class="num">' + esc(enc.error) + '</span></div>' +
        '<p class="panel-note">Fix the circuit above (wire every gate input and output) to get a tape-out quote.</p>';
    } else {
      var remaining = BigInt(p.cap) - BigInt(p.minted);
      var soldOut = BigInt(p.minted) >= BigInt(p.cap);
      if (remaining < BigInt(enc.gates)) {
        // A processor that cannot fill the order gets no normal quote.
        box.innerHTML = '<div class="row"><span>Processor</span><span class="num">' + esc(p.name) + '</span></div>' +
          '<div class="row"><span>Status</span><span class="num">' + (soldOut ? 'unavailable (sold out)' : 'unavailable — only ' + fmtBig(remaining) + ' transistor(s) left, need ' + enc.gates) + '</span></div>' +
          '<p class="panel-note">This processor cannot fill a ' + enc.gates + '-gate order. Pick another processor above.</p>';
      } else {
        var includeDeploy = $('chk-open-fee').checked;
        // The quote uses the SELECTED processor's own fees: protocolFee
        // and TAPEOUT_FEE are per-processor (see the snapshot comment).
        var est = TF.costEstimate(enc.gates, {
          mintPriceWei: BigInt(p.priceWei),
          protocolFeeWei: BigInt(p.protocolFeeWei),
          tapeoutFeeWei: BigInt(p.tapeoutFeeWei),
          deployFeeWei: includeDeploy ? liveFees.deployFeeWei : 0n
        });
        var usd = Number(est.totalWei) / 1e18 * OKB_USD;
        box.innerHTML =
          '<div class="row"><span>Processor</span><span class="num">' + esc(p.name) + '</span></div>' +
          '<div class="row"><span>Transistors (1 per gate, encoded circuit)</span><span class="num">' + enc.gates + ' × ' + TF.formatWei(BigInt(p.priceWei)) + ' OKB</span></div>' +
          '<div class="row"><span>Transistor cost</span><span class="num">' + TF.formatWei(est.transistorCostWei) + ' OKB</span></div>' +
          '<div class="row"><span>Protocol fee (once per mint)</span><span class="num">' + TF.formatWei(est.protocolFeeWei) + ' OKB</span></div>' +
          '<div class="row"><span>Tape-out fee</span><span class="num">' + TF.formatWei(est.tapeoutFeeWei) + ' OKB</span></div>' +
          (includeDeploy ? '<div class="row"><span>Processor-opening fee</span><span class="num">' + TF.formatWei(est.deployFeeWei) + ' OKB</span></div>' : '') +
          '<div class="row total"><span>Estimated total</span><span>' + TF.formatWei(est.totalWei) + ' OKB ≈ $' + usd.toFixed(2) + '</span></div>' +
          (enc.buffers ? '<p class="panel-note">Includes ' + enc.buffers + ' buffer NAND(s) so the outputs land in the final signal positions' + (enc.bufferOutputs.length ? ' (' + enc.bufferOutputs.map(esc).join(', ') + ')' : '') + '.</p>' : '');
      }
    }
    var src = $('data-source');
    var label = dataLive
      ? '<b class="live">LIVE</b> from X Layer RPC · block ' + liveBlock + ' · ' + liveAt
      : '<b>cached snapshot</b> · <span id="snapshot-date">' + SNAPSHOT_AT + '</span>';
    src.innerHTML = 'Data: ' + label + ' · <button id="btn-refresh" class="small">↻ Refresh live</button> <span id="refresh-status">' + esc(refreshStatus) + '</span>';
    var rb = $('btn-refresh');
    rb.addEventListener('click', refreshLive);
    rb.disabled = refreshInFlight;
  }

  // ------------------------------------------------------------ export UI
  // The tape-out deliverable is the PROTOCOL BYTES from TF.exportTapeout —
  // the single shared validation for both Download and Copy (§4 Critical).
  // The text netlist is a DRAFT preview only and stays available even for
  // an invalid circuit.
  function renderNetlist() {
    var exp = TF.exportTapeout(state.circuit);
    var statusEl = $('export-status');
    var hexEl = $('payload-hex');
    var dl = $('btn-download'), cp = $('btn-copy');
    if (exp.error) {
      statusEl.innerHTML = '<span class="fail">Not tape-out ready: ' + esc(exp.error) + '</span>';
      hexEl.textContent = '— no payload (blocked: see above)';
      dl.disabled = true; cp.disabled = true;
    } else {
      statusEl.innerHTML = '<span class="pass">✓ Tape-out ready</span> — ' + exp.nGates + ' gates encoded' +
        (exp.buffers ? ' (incl. ' + exp.buffers + ' buffer NANDs for ' + exp.bufferOutputs.map(esc).join(', ') + ')' : '') +
        ', payload ' + exp.bytes.length + ' bytes';
      var hex = exp.hex;
      hexEl.textContent = hex.length > 160
        ? hex.slice(0, 160) + '… (' + exp.bytes.length + ' bytes, ' + hex.length + ' hex chars total)'
        : hex;
      dl.disabled = false; cp.disabled = false;
    }
    $('netlist-view').textContent = TF.exportNetlistDraft(state.circuit, state.circuitName);
  }

  // ------------------------------------------------------------ live RPC
  // Audit §5: pin a block FIRST, then make ALL eth_calls at that block;
  // resolve token addresses at that block before pricing them; decode
  // validated 32-byte words DIRECTLY with BigInt (no parseInt on wei
  // values); require exactly one successful response per requested id;
  // stage a complete new result and publish ONLY after the whole quote
  // validates; retry the WHOLE read on the second RPC endpoint; never
  // publish a partial read and never present a failed read as live data.
  // The public X Layer RPC intermittently drops connections (the parent
  // measured ~3 of ~13 calls failing with "Remote end closed connection
  // without response"), so transport failures are RETRIED: rpcCall retries
  // a single request up to 3 times (300/700/1500 ms backoff) and batch
  // retries a failed chunk up to 2 more times. A JSON-RPC response that
  // arrives carrying an `error` field is a REAL error, not a network
  // failure, and is never retried. A refresh that still fails falls back
  // to the cached snapshot — never to a partial or fake live price.
  var refreshSeq = 0, refreshInFlight = false, refreshStatus = '';
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Delays between rpcCall attempts (3 retries after the first try).
  var RPC_RETRY_DELAYS = [300, 700, 1500];
  function rpcCall(url, payload) {
    // Retry ONLY a transport failure: the fetch rejected (connection
    // closed, timeout), the HTTP status was not OK, or the body was not
    // usable JSON — i.e. no usable response arrived at all. A JSON-RPC
    // response that arrives carrying an `error` field resolves here and
    // is rejected by the callers (batch/tryRead) without any retry.
    var attempt = 0;
    function tryOnce() {
      return fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function (e) {
        if (attempt < RPC_RETRY_DELAYS.length) {
          var delay = RPC_RETRY_DELAYS[attempt++];
          return sleep(delay).then(tryOnce);
        }
        var err = new Error('RPC request failed after ' + (attempt + 1) + ' attempts: ' + e.message);
        err.retryable = true; // transport failure — a batch may retry the chunk
        throw err;
      });
    }
    return tryOnce();
  }
  function isWord(h) { return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h); }
  function wordBigInt(h) {
    if (!isWord(h)) throw new Error('malformed 32-byte word: ' + String(h));
    return BigInt(h);
  }
  function wordAddr(h) {
    if (!isWord(h)) throw new Error('malformed 32-byte word: ' + String(h));
    return '0x' + h.slice(26).toLowerCase();
  }
  function batch(url, pairs, blockHex) {
    // pairs: [[to, data], ...] — max 10 per batch (public RPC limit).
    // Every response must be present exactly once, error-free, and a
    // validated 32-byte word, or the WHOLE batch (and the whole refresh) fails.
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < pairs.length; i += 10) {
      (function (part) {
        chain = chain.then(function () {
          // One chunk attempt: rpcCall (with its own transport retries) +
          // strict validation. A validation failure (JSON-RPC error,
          // malformed word, wrong count, duplicate/missing id) is a real
          // error and is never retried. Nothing is pushed to `out` until
          // the whole chunk validates, so a failed chunk never partially
          // contributes.
          function attemptChunk() {
            return rpcCall(url, part.map(function (p, k) {
              return { jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: p[0], data: p[1] }, blockHex] };
            })).then(function (res) {
              var arr = Array.isArray(res) ? res : [res];
              if (arr.length !== part.length) throw new Error('batch returned ' + arr.length + ' results for ' + part.length + ' requests');
              var byId = {};
              arr.forEach(function (o) {
                if (!o || o.error) throw new Error('JSON-RPC error for id ' + (o && o.id) + ': ' + JSON.stringify(o && o.error));
                if (byId[o.id] !== undefined) throw new Error('duplicate response id ' + o.id);
                if (!isWord(o.result)) throw new Error('malformed result for id ' + o.id + ': ' + String(o.result));
                byId[o.id] = o.result;
              });
              part.forEach(function (_, k) {
                if (byId[k] === undefined) throw new Error('missing response for id ' + k);
                out.push(byId[k]);
              });
            });
          }
          // Retry a failed chunk up to 2 more times — ONLY on a transport
          // failure (rpcCall exhausted its own retries and marked the
          // error retryable). Retrying a validation failure would only
          // fail again.
          function attemptChunkWithRetry(retriesLeft) {
            return attemptChunk().catch(function (e) {
              if (e && e.retryable && retriesLeft > 0) {
                return sleep(300).then(function () { return attemptChunkWithRetry(retriesLeft - 1); });
              }
              throw e;
            });
          }
          return attemptChunkWithRetry(2);
        }).then(function () { return sleep(250); });
      })(pairs.slice(i, i + 10));
    }
    return chain.then(function () { return out; });
  }
  function tryRead(url) {
    var blockHex, blockNum;
    return rpcCall(url, { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }).then(function (r) {
      if (!r || r.error || r.result !== '0xc4') throw new Error('chainId is not 0xc4 (X Layer)');
      return rpcCall(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    }).then(function (r) {
      if (!r || r.error || typeof r.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r.result)) throw new Error('bad block number');
      blockHex = r.result; blockNum = BigInt(r.result);
      // Round 1: each processor's token address + circuit count, at the block.
      var pairs1 = [];
      processors.forEach(function (p) {
        pairs1.push([p.address, SEL.transistors]);
        pairs1.push([p.address, SEL.nextId]);
      });
      return batch(url, pairs1, blockHex);
    }).then(function (res1) {
      var staged = processors.map(function (p, i) {
        var token = wordAddr(res1[i * 2]);
        if (token === '0x0000000000000000000000000000000000000000') throw new Error('processor ' + p.name + ' has no transistor token at the pinned block');
        return {
          name: p.name, address: p.address, transistor: token,
          priceWei: p.priceWei, minted: p.minted, cap: p.cap,
          circuits: wordBigInt(res1[i * 2 + 1]).toString(), note: p.note
        };
      });
      // Round 2: using the RESOLVED token addresses — price/minted/cap/
      // protocolFee on the token, TAPEOUT_FEE on the processor, deployFee
      // on the factory — all at the same pinned block.
      var pairs2 = [];
      staged.forEach(function (p) {
        pairs2.push([p.transistor, SEL.price]);
        pairs2.push([p.transistor, SEL.minted]);
        pairs2.push([p.transistor, SEL.cap]);
        pairs2.push([p.transistor, SEL.protocolFee]);
      });
      staged.forEach(function (p) { pairs2.push([p.address, SEL.tapeoutFee]); });
      pairs2.push([FACTORY, SEL.deployFee]);
      return batch(url, pairs2, blockHex).then(function (res2) {
        var n = staged.length;
        staged.forEach(function (p, i) {
          var b = i * 4;
          p.priceWei = wordBigInt(res2[b]).toString();
          p.minted = wordBigInt(res2[b + 1]).toString();
          p.cap = wordBigInt(res2[b + 2]).toString();
          // protocolFee is PER TOKEN: it differs between processors (on the
          // live chain ViperX and Cheapest charge 1,000,000 wei while the
          // other four charge 660,000,000,000,000 wei). Store it per
          // processor — never assume it is equal across them, or the live
          // refresh can never succeed.
          p.protocolFeeWei = wordBigInt(res2[b + 3]).toString();
        });
        for (var k = 0; k < n; k++) {
          // TAPEOUT_FEE is per processor too; store it per processor (it
          // happens to be 0.0013 OKB on all six today, but that is not
          // guaranteed).
          staged[k].tapeoutFeeWei = wordBigInt(res2[n * 4 + k]).toString();
        }
        var deployFee = wordBigInt(res2[n * 4 + n]);
        return {
          processors: staged,
          fees: { deployFeeWei: deployFee },
          block: blockNum, blockHex: blockHex
        };
      });
    });
  }
  function refreshLive() {
    if (refreshInFlight) return Promise.resolve(false); // no overlapping refreshes
    refreshInFlight = true;
    var mySeq = ++refreshSeq;
    refreshStatus = 'reading…';
    renderCost();
    var chain = Promise.resolve(null);
    RPCS.forEach(function (url) {
      chain = chain.then(function (found) {
        if (found) return found;
        return tryRead(url).catch(function () { return null; }); // whole-read retry on the next endpoint
      });
    });
    return chain.then(function (found) {
      refreshInFlight = false;
      if (mySeq !== refreshSeq) return false; // superseded — never publish a stale refresh
      if (!found) {
        // Keep the previous data and say what it actually is: never claim
        // "snapshot" while retaining live values, or vice versa.
        refreshStatus = 'live read failed — keeping ' + (dataLive ? 'live data (block ' + liveBlock + ')' : 'cached snapshot (' + SNAPSHOT_AT + ')');
        renderCost();
        return false;
      }
      // Publish the complete staged result only now that it all validated.
      processors = found.processors;
      liveFees = found.fees;
      dataLive = true;
      liveBlock = found.block.toLocaleString('en-US');
      liveAt = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
      refreshStatus = '';
      renderCost();
      return true;
    }).catch(function (e) {
      refreshInFlight = false;
      refreshStatus = 'live read failed (' + e.message + ') — keeping ' + (dataLive ? 'live data (block ' + liveBlock + ')' : 'cached snapshot');
      renderCost();
      return false;
    });
  }

  // ------------------------------------------------------------ actions
  function loadTemplate(tpl) {
    cancelTransient();
    if (state.circuit) commit(); // no history entry for the very first load
    bumpRevision();
    state.circuit = tpl.build();
    state.layout = autoLayout(state.circuit);
    state.inputValues = {};
    state.circuit.inputs.forEach(function (p) { state.inputValues[p.id] = 0; });
    state.counters = { gate: state.circuit.gates.length, input: state.circuit.inputs.length, output: state.circuit.outputs.length };
    state.templateId = tpl.id;
    state.circuitName = tpl.name;
    // Preserve the template's expected function + pin signature (§2 High).
    state.expectedFn = tpl.expected;
    state.expectedSig = currentSig();
    state.expectedTemplateId = tpl.id;
    state.expectedDropped = false;
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
  // A pin name guaranteed unique across ALL pins (§4 High): loop IN0/IN1/…
  // (or OUT0/OUT1/…) until a name not already used by any pin is found —
  // never derive it from the array length (a deleted middle pin would
  // otherwise be re-used and collide).
  function uniquePinName(prefix) {
    var used = {};
    state.circuit.inputs.concat(state.circuit.outputs).forEach(function (p) { used[p.name] = true; });
    var i = 0, name;
    do { name = prefix + i; i++; } while (used[name]);
    return name;
  }
  function addPin(kind) {
    commit();
    var c = state.circuit;
    if (kind === 'input') {
      var id = 'in' + (state.counters.input++);
      var name = uniquePinName('IN');
      c.inputs.push({ id: id, name: name });
      state.layout.inputs[id] = { x: 20, y: 30 + (c.inputs.length - 1) * 44 };
      state.inputValues[id] = 0;
    } else {
      var oid = 'out' + (state.counters.output++);
      var oname = uniquePinName('OUT');
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
    // Deleting the source of a pending wire cancels the wire (§5 High).
    if (pendingWire &&
      ((pendingWire.k === 'g' && selected.kind === 'gate') || (pendingWire.k === 'i' && selected.kind === 'input')) &&
      pendingWire.id === selected.id) {
      pendingWire = null; pendingWireRev = null;
    }
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
    // Refuse a stale wire (§5 High): the revision must be unchanged since
    // the wire started, and both endpoints must still exist in the CURRENT
    // circuit — an id that exists in both templates must not let a stale
    // action target a different, valid node.
    if (!pendingWire) return;
    if (pendingWireRev !== state.revision) { pendingWire = null; pendingWireRev = null; renderCanvas(); return; }
    var c = state.circuit;
    var srcExists = pendingWire.k === 'i'
      ? c.inputs.some(function (p) { return p.id === pendingWire.id; })
      : c.gates.some(function (g) { return g.id === pendingWire.id; });
    var tgtExists = target.kind === 'gate'
      ? c.gates.some(function (g) { return g.id === target.id; })
      : c.outputs.some(function (o) { return o.id === target.id; });
    if (!srcExists || !tgtExists) { pendingWire = null; pendingWireRev = null; renderCanvas(); return; }
    commit();
    if (target.kind === 'gate') {
      var g = c.gates.find(function (x) { return x.id === target.id; });
      if (g) g[target.which] = { k: pendingWire.k, id: pendingWire.id };
    } else {
      var o = c.outputs.find(function (x) { return x.id === target.id; });
      if (o) o.src = { k: pendingWire.k, id: pendingWire.id };
    }
    pendingWire = null; pendingWireRev = null;
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
        // source port: start (or switch) a pending wire, stamped with the
        // current revision so completeWire can refuse it if the circuit
        // changed meanwhile.
        pendingWire = { k: kind === 'input' ? 'i' : 'g', id: id };
        pendingWireRev = state.revision;
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
  // Pin-name validation (§4 High): a name is rejected — with an alert
  // explaining why — if it is empty, looks like a gate name (G0, G1, …),
  // is "0" or "1", contains anything outside [A-Za-z0-9_], or duplicates
  // an existing input or output pin name.
  function validatePinName(name, kind, selfId) {
    if (name === null || name === undefined || !String(name).trim()) return 'Pin names cannot be empty.';
    var n = String(name).trim();
    if (/^G\d+$/.test(n)) return '"' + n + '" looks like a gate name (G0, G1, …) — gate names are reserved for NAND gates.';
    if (n === '0' || n === '1') return '"' + n + '" is a constant value — pin names cannot be "0" or "1".';
    if (/[^A-Za-z0-9_]/.test(n)) return 'Pin names may only contain letters, digits and underscore (no spaces or punctuation).';
    var clash = state.circuit.inputs.concat(state.circuit.outputs).some(function (p) { return p.id !== selfId && p.name === n; });
    if (clash) return 'Another pin is already named "' + n + '" — pin names must be unique.';
    return null;
  }
  function renamePin(kind, id) {
    var list = kind === 'input' ? state.circuit.inputs : state.circuit.outputs;
    var pin = list.find(function (x) { return x.id === id; });
    if (!pin) return;
    var raw = window.prompt('Rename pin "' + pin.name + '" to:', pin.name);
    if (raw === null || raw === undefined) return; // cancelled
    var name = String(raw).trim();
    if (name === pin.name) return;
    var err = validatePinName(name, kind, id);
    if (err) { window.alert('Cannot rename pin: ' + err); return; }
    commit();
    pin.name = name;
    state.templateId = null; state.circuitName = 'Custom circuit';
    renderAll();
  }
  function handlePinClick(kind, id) {
    var key = kind + ':' + id;
    if (clickTimer && clickTarget === key) {
      clearTimeout(clickTimer); clickTimer = null; clickTarget = null;
      renamePin(kind, id);
      return;
    }
    var revAtClick = state.revision;
    clickTarget = key;
    clickTimer = setTimeout(function () {
      clickTimer = null; clickTarget = null;
      // Re-validate before acting (§5 High): the pin must still exist in
      // the current circuit and the revision must be unchanged, or this
      // delayed click must do nothing.
      if (revAtClick !== state.revision) return;
      var list = kind === 'input' ? state.circuit.inputs : state.circuit.outputs;
      if (!list.some(function (p) { return p.id === id; })) return;
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
    if (pendingWire) { pendingWire = null; pendingWireRev = null; renderCanvas(); }
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
    else if (e.key === 'Escape' && pendingWire) { pendingWire = null; pendingWireRev = null; renderCanvas(); }
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
    cancelTransient();
    commit();
    state.circuit = { inputs: [], gates: [], outputs: [] };
    state.layout = { gates: {}, inputs: {}, outputs: {} };
    state.inputValues = {};
    state.templateId = null; state.circuitName = 'Custom circuit';
    state.expectedFn = null; state.expectedSig = null; state.expectedTemplateId = null; state.expectedDropped = false;
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
    // Shared validation: the protocol bytes, or nothing (§4 High).
    var exp = TF.exportTapeout(state.circuit);
    if (exp.error) { window.alert('Cannot export: ' + exp.error); return; }
    var blob = new Blob([exp.bytes], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tapeforge-' + state.circuitName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.bin';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  $('btn-copy').addEventListener('click', function () {
    var exp = TF.exportTapeout(state.circuit);
    if (exp.error) { window.alert('Cannot export: ' + exp.error); return; }
    var done = function () { $('btn-copy').textContent = '✓ Copied'; setTimeout(function () { $('btn-copy').textContent = '⧉ Copy hex'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(exp.hex).then(done, function () { fallbackCopy(exp.hex); done(); });
    else { fallbackCopy(exp.hex); done(); }
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ------------------------------------------------------------ init
  // Test/debug handle (used by smoke-test.js and test.js). Harmless in the browser.
  window.TapeForgeApp = {
    loadTemplate: loadTemplate, runVerify: runVerify, renderAll: renderAll,
    undo: undo, redo: redo, refreshLive: refreshLive,
    deleteWire: deleteWire,
    selectProcessor: function (i) { selectedProc = i; renderCost(); },
    cheapestAvailableFor: function (gates) { return cheapestAvailable(gates); },
    validatePinName: validatePinName,
    getState: function () { return state; },
    getProcessors: function () { return processors; },
    getFees: function () {
      // Fees for the selected processor (protocolFee / TAPEOUT_FEE are
      // per-processor); deployFee is the single factory value.
      var p = processors[selectedProc];
      return {
        protocolFeeWei: p.protocolFeeWei,
        tapeoutFeeWei: p.tapeoutFeeWei,
        deployFeeWei: liveFees.deployFeeWei.toString()
      };
    },
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

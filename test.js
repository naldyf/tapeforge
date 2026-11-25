// TapeForge template tests — run with: node test.js
// Exhaustively simulates every template against its expected function and
// asserts gate counts, spot values, a REAL payload round trip
// (exportTapeout -> decodePayload -> simulateDecoded vs the expected
// function), cost math and loop detection. Exit non-zero on any failure.
const TF = require('./circuit.js');
let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); failures++; }
}

// Live fee constants, verified on X Layer (audit §3): protocolFee
// 660000000000000 wei (0.00066 OKB, once per mint call), TAPEOUT_FEE
// 1300000000000000 wei (0.0013 OKB), deployFee 10000000 wei
// (0.00000000001 OKB). All money is integer wei (BigInt) end to end.
const FEES_9898 = {
  mintPriceWei: 1000000000000n, protocolFeeWei: 660000000000000n,
  tapeoutFeeWei: 1300000000000000n
};
const FEES_XBOT = {
  mintPriceWei: 9000000000000000n, protocolFeeWei: 660000000000000n,
  tapeoutFeeWei: 1300000000000000n
};
const FEES_FREE = {
  mintPriceWei: 0n, protocolFeeWei: 660000000000000n,
  tapeoutFeeWei: 1300000000000000n
};

console.log('== TapeForge template verification ==');
for (const t of TF.TEMPLATES) {
  const circuit = t.build();
  console.log(`\n[${t.id}] ${t.name}`);
  check('gate count = ' + t.gates, circuit.gates.length === t.gates,
    'got ' + circuit.gates.length);
  const t0 = Date.now();
  const r = TF.verifyCircuit(circuit, t.expected);
  const expectedCases = 1 << circuit.inputs.length;
  console.log(`  verify: ${r.passed}/${r.total} cases pass` +
    (r.sampled ? ' (sampled)' : ' (exhaustive)') + ` in ${Date.now() - t0} ms`);
  // A compile error returns total 0 / failed 0, which used to satisfy a bare
  // `failed === 0` assertion (audit §2 Low). Assert the absence of an error
  // AND the exact expected case count AND zero failures.
  check('all cases pass (no error, exact case count, 0 failures)',
    !r.error && r.total === expectedCases && r.failed === 0,
    'error=' + r.error + ' total=' + r.total + ' (expected ' + expectedCases + ') failed=' + r.failed);

  // REAL round trip (§2 Low — the old test only counted NAND( strings):
  // export the protocol bytes, decode them, and simulate the DECODED bytes
  // against the template's expected function over every input combination.
  const exp = TF.exportTapeout(circuit, t.name);
  check('exportTapeout succeeds', !exp.error, exp.error || '');
  const dec = TF.decodePayload(exp.bytes);
  check('payload decodes', !dec.error, dec.error || '');
  check('encoded gates = editor gates + buffers',
    exp.nGates === circuit.gates.length + exp.buffers,
    'encoded=' + exp.nGates + ' editor=' + circuit.gates.length + ' buffers=' + exp.buffers);
  // Only the comparator needs output buffers (GT and EQ source gates also
  // feed other gates, so their outputs are copied by 2-NAND buffers each).
  if (t.id === 'comparator') {
    check('comparator needs 4 buffer NANDs (GT, EQ)',
      exp.buffers === 4 && JSON.stringify(exp.bufferOutputs) === JSON.stringify(['GT', 'EQ']),
      'buffers=' + exp.buffers + ' ' + JSON.stringify(exp.bufferOutputs));
  } else {
    check('0 buffers for stock template ' + t.id, exp.buffers === 0, 'buffers=' + exp.buffers);
  }
  let roundTripOk = true, roundTripChecked = 0;
  const n = circuit.inputs.length;
  for (let c = 0; c < (1 << n); c++) {
    const bits = [];
    for (let i = 0; i < n; i++) bits.push((c >> i) & 1);
    const got = TF.simulateDecoded(dec, bits);
    const want = t.expected(bits);
    roundTripChecked++;
    if (JSON.stringify(got) !== JSON.stringify(want)) { roundTripOk = false; break; }
  }
  check('decoded payload matches expected function on all ' + roundTripChecked + ' cases', roundTripOk);
  // The draft preview uses stable signal ids (in0, g0, out0); display names
  // are comments only, so it can never emit a colliding equation (§4 High).
  const draft = TF.exportNetlistDraft(circuit, t.name);
  check('draft netlist is labelled DRAFT ONLY', draft.includes('DRAFT ONLY'));
  check('draft netlist has one gate line per gate (stable ids)',
    (draft.match(/^g\d+ = NAND\(/gm) || []).length === circuit.gates.length);
}

// Spot checks with known values.
console.log('\n== Spot checks ==');
{
  const adder = TF.TEMPLATES.find((t) => t.id === 'adder').build();
  const run = (a, b) => {
    const bits = [];
    for (let i = 0; i < 8; i++) bits.push((a >> i) & 1);
    for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
    const out = TF.simulate(adder, bits).outputs;
    let s = 0;
    for (let i = 0; i < 8; i++) s |= out[i] << i;
    return { sum: s, cout: out[8] };
  };
  check('200 + 55 = 255, cout 0', JSON.stringify(run(200, 55)) === JSON.stringify({ sum: 255, cout: 0 }));
  check('200 + 100 = 44, cout 1', JSON.stringify(run(200, 100)) === JSON.stringify({ sum: 44, cout: 1 }));
  check('0 + 0 = 0, cout 0', JSON.stringify(run(0, 0)) === JSON.stringify({ sum: 0, cout: 0 }));
  check('255 + 255 = 254, cout 1', JSON.stringify(run(255, 255)) === JSON.stringify({ sum: 254, cout: 1 }));
}
{
  const cmp = TF.TEMPLATES.find((t) => t.id === 'comparator').build();
  const run = (a, b) => {
    const bits = [];
    for (let i = 0; i < 8; i++) bits.push((a >> i) & 1);
    for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
    return TF.simulate(cmp, bits).outputs; // [GT, EQ, LT]
  };
  check('5 vs 3 -> GT', JSON.stringify(run(5, 3)) === JSON.stringify([1, 0, 0]));
  check('3 vs 5 -> LT', JSON.stringify(run(3, 5)) === JSON.stringify([0, 0, 1]));
  check('7 vs 7 -> EQ', JSON.stringify(run(7, 7)) === JSON.stringify([0, 1, 0]));
  check('255 vs 0 -> GT', JSON.stringify(run(255, 0)) === JSON.stringify([1, 0, 0]));
  check('128 vs 127 -> GT', JSON.stringify(run(128, 127)) === JSON.stringify([1, 0, 0]));
  // Audit §4 Critical example: at A = B = 0 the named outputs are
  // [GT, EQ, LT] = [0, 1, 0] — and the DECODED payload must agree.
  check('comparator A=B=0 -> [0,1,0] via decoded payload', (() => {
    const exp = TF.exportTapeout(cmp);
    const dec = TF.decodePayload(exp.bytes);
    return JSON.stringify(TF.simulateDecoded(dec, new Array(16).fill(0))) === JSON.stringify([0, 1, 0]);
  })());
}
{
  const mux = TF.TEMPLATES.find((t) => t.id === 'mux').build();
  // D = [1,0,1,0], S1:S0 = 2 -> D2 = 1; = 1 -> D1 = 0
  const run = (d, s0, s1) => TF.simulate(mux, [d[0], d[1], d[2], d[3], s0, s1]).outputs[0];
  check('mux sel 2 picks D2=1', run([1, 0, 1, 0], 0, 1) === 1);
  check('mux sel 1 picks D1=0', run([1, 0, 1, 0], 1, 0) === 0);
  check('mux sel 0 picks D0=1', run([1, 0, 1, 0], 0, 0) === 1);
  check('mux sel 3 picks D3=0', run([1, 0, 1, 0], 1, 1) === 0);
}
{
  const maj = TF.TEMPLATES.find((t) => t.id === 'majority').build();
  const run = (a, b, c) => TF.simulate(maj, [a, b, c]).outputs[0];
  check('majority 110 -> 1', run(1, 1, 0) === 1);
  check('majority 100 -> 0', run(1, 0, 0) === 0);
  check('majority 101 -> 1', run(1, 0, 1) === 1);
  check('majority 000 -> 0', run(0, 0, 0) === 0);
  const con = TF.TEMPLATES.find((t) => t.id === 'consensus').build();
  const runC = (r, l, m) => TF.simulate(con, [r, l, m]).outputs[0];
  check('consensus RISK+LIQ -> 1', runC(1, 1, 0) === 1);
  check('consensus only MKT -> 0', runC(0, 0, 1) === 0);
}
{
  const par = TF.TEMPLATES.find((t) => t.id === 'parity').build();
  const run = (d) => TF.simulate(par, d).outputs[0];
  check('parity 00000000 -> 0', run([0, 0, 0, 0, 0, 0, 0, 0]) === 0);
  check('parity 00000001 -> 1', run([1, 0, 0, 0, 0, 0, 0, 0]) === 1);
  check('parity 00000011 -> 0', run([1, 1, 0, 0, 0, 0, 0, 0]) === 0);
  check('parity 11111111 -> 0', run([1, 1, 1, 1, 1, 1, 1, 1]) === 0);
  check('parity 11111110 -> 1', run([1, 1, 1, 1, 1, 1, 1, 0]) === 1);
}

// Cost math — corrected formula (audit §3 High).
// total = gates * mintPrice + protocolFee (once per mint) + tapeoutFee.
// The OLD expectation "adder on 9898 = 0.001368 OKB" was WRONG: it omitted
// the per-transistor mint fee (68 * 0.000001 = 0.000068 OKB). The correct
// total is 68*1e12 + 660e12 + 1300e12 = 2028000000000000 wei = 0.002028 OKB.
console.log('\n== Cost ==');
{
  const c = TF.costEstimate(68, FEES_9898); // adder on 9898
  check('adder on 9898 = 0.002028 OKB (68*1e12 + 660e12 + 1300e12)',
    TF.formatWei(c.totalWei) === '0.002028', 'got ' + TF.formatWei(c.totalWei));
  check('adder on 9898 transistor cost = 68 * 1e12 wei',
    c.transistorCostWei === 68000000000000n, String(c.transistorCostWei));
  check('adder on 9898 protocol fee charged once = 660e12 wei',
    c.protocolFeeWei === 660000000000000n, String(c.protocolFeeWei));
  const c2 = TF.costEstimate(68, FEES_XBOT); // adder on XBOT
  check('adder on XBOT = 0.61396 OKB (68*0.009 + 0.00066 + 0.0013)',
    TF.formatWei(c2.totalWei) === '0.61396', 'got ' + TF.formatWei(c2.totalWei));
  const c3 = TF.costEstimate(12, FEES_FREE); // consensus on a free processor
  check('free processor: 12 gates = protocol fee + tape-out fee only = 0.00196 OKB',
    TF.formatWei(c3.totalWei) === '0.00196', 'got ' + TF.formatWei(c3.totalWei));
  const c4 = TF.costEstimate(12, { ...FEES_9898, deployFeeWei: 10000000n });
  check('12 gates on 9898 + deployFee = 0.00197200001 OKB',
    TF.formatWei(c4.totalWei) === '0.00197200001', 'got ' + TF.formatWei(c4.totalWei));
  check('formatWei(2028000000000000n) = 0.002028', TF.formatWei(2028000000000000n) === '0.002028');
  check('formatWei(10000000n) = 0.00000000001 (live deployFee)',
    TF.formatWei(10000000n) === '0.00000000001', TF.formatWei(10000000n));
  check('formatWei(0n) = 0', TF.formatWei(0n) === '0');
}

// Structural checks: loop detection + unconnected inputs.
console.log('\n== Structural ==');
{
  const loop = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [
      { id: 'g0', a: { k: 'g', id: 'g1' }, b: { k: 'i', id: 'in0' } },
      { id: 'g1', a: { k: 'g', id: 'g0' }, b: { k: 'i', id: 'in0' } },
    ],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  const r = TF.verifyCircuit(loop, null);
  check('combinational loop is detected', !!r.error, r.error || 'no error');
  check('loop names the unevaluated gates', /g0/.test(r.error || '') && /g1/.test(r.error || ''), r.error || '');
  check('loop blocks tape-out export', !!TF.exportTapeout(loop).error, TF.exportTapeout(loop).error || '');
  const open = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: { k: 'i', id: 'in0' }, b: null }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  const r2 = TF.verifyCircuit(open, null);
  check('unconnected input is an error, not a pass', !!r2.error && r2.total === 0, 'error=' + r2.error + ' total=' + r2.total);
  check('unconnected input counted per port', TF.compile(open).unconnectedPorts.length === 1);
  check('unconnected input reads as 0 in live sim (NAND(A,0)=1)',
    TF.simulate(open, [1]).outputs[0] === 1);
  // Both inputs open = 2 unconnected ports, not 1 (§1 Low).
  const open2 = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: null, b: null }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  check('a NAND with both inputs open counts 2 unconnected ports',
    TF.compile(open2).unconnectedPorts.length === 2);
}

// Regression tests — one per High/Critical audit finding.
console.log('\n== Regression (audit findings) ==');
{
  // §1 High — a dangling wire (unknown id) is a compile error, never 0.
  const dangling = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: { k: 'i', id: 'in0' }, b: { k: 'g', id: 'g99' } }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  const rc = TF.compile(dangling);
  check('dangling wire (unknown gate id) is a compile error', !!rc.error && /g99/.test(rc.error), rc.error || 'no error');
  check('dangling wire never simulates as 0', !!TF.simulate(dangling, [1]).error);
  check('dangling wire blocks export', !!TF.exportTapeout(dangling).error);

  // §2 High — template-edit verification: disconnecting the consensus
  // output must be an ERROR, not 8/8 pass; clearing the canvas must be an
  // error, not 1/1 pass.
  const conTpl = TF.TEMPLATES.find((t) => t.id === 'consensus');
  const broken = conTpl.build();
  broken.outputs[0].src = null;
  const rb = TF.verifyCircuit(broken, conTpl.expected);
  check('disconnected consensus output -> verify ERROR, not 8/8 pass',
    !!rb.error && rb.total === 0 && rb.passed === 0, 'error=' + rb.error + ' passed=' + rb.passed + '/' + rb.total);
  const empty = { inputs: [], gates: [], outputs: [] };
  const re = TF.verifyCircuit(empty, conTpl.expected);
  check('empty circuit -> verify ERROR, not 1/1 pass',
    !!re.error && re.total === 0 && re.passed === 0, 'error=' + re.error + ' passed=' + re.passed + '/' + re.total);

  // §4 Critical + High — export validation: disconnected output, dangling
  // reference, self-referencing NAND and loop all block tape-out export.
  const selfRef = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: { k: 'g', id: 'g0' }, b: { k: 'i', id: 'in0' } }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  check('disconnected output blocks export', !!TF.exportTapeout(broken).error);
  check('dangling reference blocks export', !!TF.exportTapeout(dangling).error);
  check('self-referencing NAND blocks export', !!TF.exportTapeout(selfRef).error);
  check('loop blocks export (again, via exportTapeout)', !!TF.exportTapeout({
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [
      { id: 'g0', a: { k: 'g', id: 'g1' }, b: { k: 'i', id: 'in0' } },
      { id: 'g1', a: { k: 'g', id: 'g0' }, b: { k: 'i', id: 'in0' } },
    ],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  }).error);

  // §4 High — pin collision: an input renamed to "G0" must NOT make the
  // draft netlist emit "G0 = NAND(G0, G0)". Stable ids (in0, g0, out0)
  // are used; the display name appears only as a comment.
  const renamed = conTpl.build();
  renamed.inputs[0].name = 'G0';
  const draft = TF.exportNetlistDraft(renamed, 'consensus');
  check('renamed pin G0 never produces "G0 = NAND(G0, G0)"', !draft.includes('G0 = NAND(G0, G0)'));
  check('draft still uses stable ids (g0 = NAND(in0, …))', /^g\d+ = NAND\(in0,/.test(draft.split('\n').find((l) => l.startsWith('g0 =')) || ''));
  check('renamed display name survives only as a comment', draft.includes('"G0"'));

  // §3 Medium — BigInt precision: a 9007199254740993-wei value and a
  // 1e21-wei value decode exactly via BigInt; parseInt would lose the
  // first (9007199254740992) and BigInt('1e+21') would throw on the second.
  const big1 = 9007199254740993n;
  const word1 = '0x' + big1.toString(16).padStart(64, '0');
  check('9007199254740993 wei decodes exactly via BigInt', BigInt(word1) === big1);
  check('parseInt would lose it (documents why BigInt is required)',
    BigInt(parseInt(word1.slice(2), 16)) !== big1,
    'parseInt gives ' + parseInt(word1.slice(2), 16));
  const big2 = 1000000000000000000000n; // 1e21 wei
  check('1e21 wei decodes exactly via BigInt', BigInt('0x' + big2.toString(16).padStart(64, '0')) === big2);
  check('formatWei(1e21 wei) = 1000 OKB', TF.formatWei(big2) === '1000', TF.formatWei(big2));
  check('formatWei(9007199254740993n) is exact',
    TF.formatWei(big1) === '0.009007199254740993', TF.formatWei(big1));

  // §3 High — the encoded gate count (incl. buffers) is what cost counts:
  // a circuit whose output is sourced from an input pin needs a 2-NAND
  // buffer, so 1 editor gate costs as 3 encoded gates.
  const passthrough = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: { k: 'i', id: 'in0' }, b: { k: 'i', id: 'in0' } }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'i', id: 'in0' } }],
  };
  const enc = TF.encodePayload(passthrough);
  check('input-sourced output needs a buffer: 1 editor gate -> 3 encoded',
    !enc.error && enc.nGates === 3 && enc.buffers === 2, 'nGates=' + enc.nGates + ' buffers=' + enc.buffers);
  check('buffered payload still verifies against the identity function',
    (() => {
      const v = TF.verifyCircuit(passthrough, (bits) => [bits[0]]);
      return !v.error && v.failed === 0 && v.total === 2;
    })());
}

// App-level regression tests (audit §3 Medium cheapest logic, §4 High pin
// validator). test.js only loads circuit.js, so app.js is loaded here in the
// same minimal DOM shim smoke-test.js uses.
console.log('\n== App-level regression (DOM shim) ==');
{
  const fs = require('fs');
  const vm = require('vm');
  function makeEl(id) {
    return {
      id: id || '', innerHTML: '', textContent: '', disabled: false, value: '', checked: false,
      _attrs: {}, _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      appendChild(c) { return c; },
      remove() {}, click() {}, closest() { return null; },
      createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: 0, y: 0 }; } }; },
      getScreenCTM() { return { inverse() { return {}; } }; },
    };
  }
  const elements = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error('network down')),
    AbortSignal,
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    navigator: {},
    document: {
      getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; },
      createElement(tag) { return makeEl(''); },
      addEventListener() {},
      body: makeEl('body'),
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('./circuit.js', 'utf8'), sandbox, { filename: 'circuit.js' });
  vm.runInContext(fs.readFileSync('./app.js', 'utf8'), sandbox, { filename: 'app.js' });
  const app = sandbox.window.TapeForgeApp;
  const procs = app.getProcessors();
  const saved = procs.map((p) => ({ minted: p.minted, cap: p.cap }));
  const restoreProcs = () => saved.forEach((s, i) => { procs[i].minted = s.minted; procs[i].cap = s.cap; });

  // §3 Medium — cheapest logic. The old code tested `!best`, and !0 is
  // true, so whenever row 0 was the cheapest eligible row the NEXT eligible
  // row replaced it. Make only rows 0 and 1 eligible, row 0 cheaper.
  procs.forEach((p, i) => { if (i > 1) p.minted = p.cap; });
  procs[1].minted = '0'; // FAB-Genisis eligible again, 5e14 wei > 9898's 1e12
  check('cheapest is row 0 when row 0 is cheapest (best === null, not !best)',
    app.cheapestAvailableFor(12) === 0, 'got ' + app.cheapestAvailableFor(12));
  restoreProcs();
  // A processor with 1 transistor left does not qualify for a 68-gate order.
  procs[0].minted = (BigInt(procs[0].cap) - 1n).toString();
  check('processor with 1 transistor left cannot fill a 68-gate order',
    app.cheapestAvailableFor(68) !== 0, 'got ' + app.cheapestAvailableFor(68));
  restoreProcs();
  // Sold-out ViperX (row 4) produces no normal quote.
  app.selectProcessor(4);
  const costHtml = elements['cost-breakdown'].innerHTML;
  check('sold-out ViperX shows "unavailable (sold out)", no normal quote',
    costHtml.includes('unavailable (sold out)') && !costHtml.includes('Estimated total'),
    costHtml.replace(/<[^>]+>/g, ' ').slice(0, 160));
  app.selectProcessor(0);
  // Deploy-fee label shows the LIVE deployFee, not a hardcoded value.
  check('deploy-fee label shows the live deployFee (0.00000000001 OKB)',
    elements['lbl-open-fee-text'].textContent.includes('0.00000000001 OKB'),
    elements['lbl-open-fee-text'].textContent);

  // §4 High — pin-name validator (default circuit is consensus: RISK/LIQ/MKT).
  check('rename to "G0" is rejected', typeof app.validatePinName('G0', 'input', 'in0') === 'string');
  check('rename to "G12" is rejected', typeof app.validatePinName('G12', 'input', 'in0') === 'string');
  check('rename to "0" is rejected', typeof app.validatePinName('0', 'input', 'in0') === 'string');
  check('rename to "1" is rejected', typeof app.validatePinName('1', 'input', 'in0') === 'string');
  check('rename with a space is rejected', typeof app.validatePinName('A B', 'input', 'in0') === 'string');
  check('rename with punctuation is rejected', typeof app.validatePinName('A-B', 'input', 'in0') === 'string');
  check('rename to an empty name is rejected', typeof app.validatePinName('   ', 'input', 'in0') === 'string');
  check('rename to a duplicate pin name is rejected',
    typeof app.validatePinName('LIQ', 'input', 'in0') === 'string');
  check('rename to a fresh valid name is accepted', app.validatePinName('FOO_1', 'input', 'in0') === null);
  check('renaming a pin to its own current name is accepted',
    app.validatePinName('RISK', 'input', 'in0') === null);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

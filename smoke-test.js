// TapeForge DOM smoke test — run with: node smoke-test.js
// Loads index.html's two scripts in a minimal DOM shim (no browser needed) and
// asserts the app initialises, renders the default template, verifies it,
// prices it, exports a netlist, and handles both the cached-snapshot and the
// live-RPC data paths. Exit non-zero on any failure.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function makeSandbox(fetchImpl) {
  const elements = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    fetch: fetchImpl,
    AbortSignal, // rpcCall uses AbortSignal.timeout()
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
  sandbox._elements = elements;
  return sandbox;
}
function loadApp(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('./circuit.js', 'utf8'), sandbox, { filename: 'circuit.js' });
  vm.runInContext(fs.readFileSync('./app.js', 'utf8'), sandbox, { filename: 'app.js' });
  return sandbox._elements;
}

// ---- shared assertions (run against a loaded app's elements) ----
function assertCommon(el, label) {
  console.log('\n[' + label + ']');
  check('template list has all 6 templates',
    ['8-bit Adder', '8-bit Comparator', '4-to-1 Multiplexer', 'Majority Voter', 'Parity Checker', '2-of-3 Consensus']
      .every((n) => el['template-list'].innerHTML.includes(n)));
  check('default template is the 2-of-3 consensus (12 gates)',
    el['live-status'].innerHTML.includes('12 gates · 3 inputs · 1 outputs'));
  check('live simulation OK', el['live-status'].innerHTML.includes('live simulation OK'));
  check('canvas renders 12 NAND gates', (el.canvas.innerHTML.match(/>NAND</g) || []).length === 12);
  check('canvas shows RISK / LIQ / MKT pins',
    el.canvas.innerHTML.includes('RISK') && el.canvas.innerHTML.includes('LIQ') && el.canvas.innerHTML.includes('MKT'));
  check('canvas shows CONSENSUS output', el.canvas.innerHTML.includes('CONSENSUS'));
  check('processor table lists 9898, XBOT, ViperX',
    el['processor-body'].innerHTML.includes('9898') && el['processor-body'].innerHTML.includes('XBOT') && el['processor-body'].innerHTML.includes('ViperX'));
  check('netlist has 12 gate lines (stable ids)', (el['netlist-view'].textContent.match(/^g\d+ = NAND\(/gm) || []).length === 12);
  check('netlist assigns CONSENSUS (draft, stable id + name comment)',
    el['netlist-view'].textContent.includes('out0 = ') && el['netlist-view'].textContent.includes('"CONSENSUS"'));
  check('netlist is labelled DRAFT ONLY', el['netlist-view'].textContent.includes('DRAFT ONLY'));
  check('export status says tape-out ready', el['export-status'].innerHTML.includes('Tape-out ready'));
  check('payload hex shown', (el['payload-hex'].textContent || '').length > 10);
  check('download/copy enabled for a valid circuit',
    el['btn-download'].disabled === false && el['btn-copy'].disabled === false);
  check('deploy-fee label shows the live deployFee (0.00000000001 OKB)',
    (el['lbl-open-fee-text'].textContent || '').includes('0.00000000001 OKB'));
}

(async () => {
  // ---- scenario 1: RPC unreachable -> cached snapshot ----
  const sb1 = makeSandbox(() => Promise.reject(new Error('network down')));
  const el1 = loadApp(sb1);
  await sleep(2500); // let the background refresh fail and fall back
  assertCommon(el1, 'snapshot fallback (RPC down)');
  check('data source says cached snapshot', el1['data-source'].innerHTML.includes('cached snapshot'));
  check('cost total for 12 gates on 9898 = 0.001972 OKB (12*1e12 + 660e12 + 1300e12)',
    el1['cost-breakdown'].innerHTML.includes('0.001972 OKB'),
    el1['cost-breakdown'].innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 200));
  check('cost breakdown shows the protocol fee row',
    el1['cost-breakdown'].innerHTML.includes('Protocol fee (once per mint)'));
  check('cost breakdown shows the transistor cost row',
    el1['cost-breakdown'].innerHTML.includes('Transistor cost'));
  check('cheapest processor is tagged', el1['processor-body'].innerHTML.includes('cheapest'));
  check('9898 tagged as proven fab', el1['processor-body'].innerHTML.includes('proven fab'));

  // ---- scenario 2: live RPC returns changed prices -> table updates ----
  const word32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const addrWord = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const LIVE = [
    { address: '0x60918c204f3c94630d3d793738fc36293c8405d6', transistor: '0x0f7e9ed401fe35010ebc4d021a204ba031a23194', priceWei: '2000000000000', minted: 17000, cap: 1000000000000, circuits: 2000, protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000' },
    { address: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6', transistor: '0xbe6f94115d32f3ac3252bc4626573e739beeb714', priceWei: '500000000000000', minted: 1000000, cap: 1000000, circuits: 7200, protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000' },
    { address: '0x69f663931209096037474d7c20402232e5c762ca', transistor: '0x3fa393d3081accff9e7989619b688235f6d3ee3f', priceWei: '660000000000000', minted: 2100000, cap: 2100000, circuits: 1410, protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000' },
    { address: '0xa5fc69Ca2D3d462CCa204D894D85ac8071c4F0f0', transistor: '0x7bE7280e31984d18f62218519985EC5DcCa751De', priceWei: '10000000000000000', minted: 41, cap: 1000000000, circuits: 6, protocolFeeWei: '660000000000000', tapeoutFeeWei: '1300000000000000' },
    { address: '0xb57b56034e2dc25161e2512CfC40b24EA3bee1Fb', transistor: '0xfce5366485140045e95ebdba88ad775fc4aad79f', priceWei: '0', minted: 158, cap: 158, circuits: 4, protocolFeeWei: '1000000', tapeoutFeeWei: '1300000000000000' },
    { address: '0x99081e1d0ce916cd5b2c53e769dfc3b000bfe9a4', transistor: '0x80a7eb72bc4e559c47304efe6a0f6e73717df5cb', priceWei: '1', minted: 281, cap: '1000000000000000000000000', circuits: 19, protocolFeeWei: '1000000', tapeoutFeeWei: '1300000000000000' },
  ];
  function liveFetch(url, opts) {
    const body = JSON.parse(opts.body);
    const reqs = Array.isArray(body) ? body : [body];
    const results = reqs.map((req) => {
      if (req.method === 'eth_chainId') return { jsonrpc: '2.0', id: req.id, result: '0xc4' };
      if (req.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: req.id, result: '0x5000000' };
      if (req.method === 'eth_call') {
        const to = req.params[0].to.toLowerCase();
        const data = req.params[0].data;
        const proc = LIVE.find((p) => p.address.toLowerCase() === to || p.transistor.toLowerCase() === to);
        let result = '0x' + '0'.repeat(64);
        if (data === '0x6fbd1719') result = proc ? addrWord(proc.transistor) : result;
        else if (data === '0x6817c76c') result = proc ? word32(proc.priceWei) : result;
        else if (data === '0x61b8ce8c') result = proc ? word32(proc.circuits) : result;
        else if (data === '0x4f02c420') result = proc ? word32(proc.minted) : result;
        else if (data === '0x8f770ad0') result = proc ? word32(proc.cap) : result;
        // New fee selectors (audit §3): protocolFee on the token,
        // TAPEOUT_FEE on the processor, deployFee on the factory.
        // protocolFee is PER TOKEN and differs on the live chain: ViperX
        // and Cheapest charge 1,000,000 wei, the other four 0.00066 OKB.
        // The refresh must succeed anyway (per-processor fees), so the
        // mock mirrors the live values.
        else if (data === '0xb0e21e8a') result = proc ? word32(proc.protocolFeeWei) : result;
        else if (data === '0xadfb2b69') result = proc ? word32(proc.tapeoutFeeWei) : result;
        else if (data === '0xeb2a5d2c') result = word32(10000000);
        return { jsonrpc: '2.0', id: req.id, result };
      }
      return { jsonrpc: '2.0', id: req.id, result: '0x' + '0'.repeat(64) };
    });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(Array.isArray(body) ? results : results[0]) });
  }
  const sb2 = makeSandbox(liveFetch);
  const el2 = loadApp(sb2);
  await sleep(3500); // background refresh: chainId + 3 batches + block number
  assertCommon(el2, 'live RPC (changed prices)');
  check('data source flips to LIVE', el2['data-source'].innerHTML.includes('LIVE'));
  check('live block number shown', el2['data-source'].innerHTML.includes('83,886,080'));
  check('9898 price updated to 0.000002 OKB', el2['processor-body'].innerHTML.includes('0.000002 OKB'));
  check('9898 circuits updated to 2,000', el2['processor-body'].innerHTML.includes('2,000'));
  check('cost total re-priced: 12 x 0.000002 + 0.00066 + 0.0013 = 0.001984 OKB',
    el2['cost-breakdown'].innerHTML.includes('0.001984 OKB'));
  check('deploy-fee label shows the live deployFee after refresh',
    (el2['lbl-open-fee-text'].textContent || '').includes('0.00000000001 OKB'));
  check('live fees read from the mock (protocol 0.00066 + tape-out 0.0013 in the total)',
    el2['cost-breakdown'].innerHTML.includes('0.00066 OKB') && el2['cost-breakdown'].innerHTML.includes('0.0013 OKB'));
  // Per-processor protocol fee: the mock mirrors the live chain (ViperX and
  // Cheapest charge 1,000,000 wei, the other four 0.00066 OKB). The refresh
  // must succeed anyway — the old code threw "protocolFee differs" and the
  // live refresh could never complete. Each processor's quote must use its
  // OWN protocol fee.
  {
    const app2 = sb2.window.TapeForgeApp;
    app2.selectProcessor(5); // Cheapest available
    check('Cheapest quote uses its own protocol fee (0.000000000001 OKB)',
      el2['cost-breakdown'].innerHTML.includes('0.000000000001 OKB'),
      el2['cost-breakdown'].innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 200));
    app2.selectProcessor(0); // 9898 again
    check('9898 quote uses its own protocol fee (0.00066 OKB)',
      el2['cost-breakdown'].innerHTML.includes('0.00066 OKB'));
    check('per-processor fees stored on the processor objects',
      app2.getProcessors()[5].protocolFeeWei === '1000000' && app2.getProcessors()[0].protocolFeeWei === '660000000000000');
    check('getFees returns the selected processor\'s fees',
      app2.getFees().protocolFeeWei === '660000000000000' && app2.getFees().deployFeeWei === '10000000');
  }

  // ---- scenarios 3–5: flaky RPC retry (the public X Layer RPC drops
  // connections intermittently). failFn(callIndex, body) decides whether a
  // call drops (rejects, as a closed connection would) or is answered.
  function makeFlakyFetch(failFn) {
    let n = 0;
    return function (url, opts) {
      n++;
      const body = JSON.parse(opts.body);
      if (failFn(n, body)) return Promise.reject(new Error('Remote end closed connection without response'));
      return liveFetch(url, opts);
    };
  }

  // ---- scenario 3: rpcCall retry — the first 2 calls drop, the 3rd
  // attempt of the chainId call succeeds, and the refresh completes live.
  console.log('\n[flaky RPC — rpcCall retry]');
  {
    const sb3 = makeSandbox(makeFlakyFetch((n) => n <= 2));
    const el3 = loadApp(sb3);
    const app3 = sb3.window.TapeForgeApp;
    const ok3 = await app3.refreshLive(); // direct call; the background one no-ops (in flight)
    check('refresh completes with live data despite 2 dropped calls', ok3 === true && app3.isLive() === true);
    check('data source flips to LIVE after rpcCall retries', el3['data-source'].innerHTML.includes('LIVE'));
    check('9898 price updated after rpcCall retries', el3['processor-body'].innerHTML.includes('0.000002 OKB'));
    check('cost re-priced after rpcCall retries (0.001984 OKB)',
      el3['cost-breakdown'].innerHTML.includes('0.001984 OKB'));
  }

  // ---- scenario 4: batch retry — the first 4 batch-chunk calls drop,
  // exhausting rpcCall's own retries for the first chunk; the batch-level
  // retry then succeeds and the refresh completes live.
  console.log('\n[flaky RPC — batch retry]');
  {
    let batchDrops = 0;
    const sb4 = makeSandbox(makeFlakyFetch((n, body) => {
      if (!Array.isArray(body)) return false; // chainId / blockNumber answer
      batchDrops++;
      return batchDrops <= 4; // drop the first 4 chunk calls, answer the batch retry
    }));
    const el4 = loadApp(sb4);
    const app4 = sb4.window.TapeForgeApp;
    const ok4 = await app4.refreshLive();
    check('refresh completes with live data despite a dropped batch chunk', ok4 === true && app4.isLive() === true);
    check('data source flips to LIVE after batch retry', el4['data-source'].innerHTML.includes('LIVE'));
    check('9898 circuits updated after batch retry (2,000)', el4['processor-body'].innerHTML.includes('2,000'));
  }

  // ---- scenario 5: persistent failure — the RPC keeps dropping every
  // call; the refresh must fail cleanly and the app must keep the cached
  // snapshot, never a partial or fake live price.
  console.log('\n[persistent failure — snapshot fallback]');
  {
    const sb5 = makeSandbox(() => Promise.reject(new Error('Remote end closed connection without response')));
    const el5 = loadApp(sb5);
    const app5 = sb5.window.TapeForgeApp;
    const ok5 = await app5.refreshLive();
    check('refresh reports failure (false) when the RPC keeps failing', ok5 === false);
    check('app is NOT live after a failed refresh', app5.isLive() === false);
    check('data source still says cached snapshot', el5['data-source'].innerHTML.includes('cached snapshot'));
    check('cost total stays the snapshot total (0.001972 OKB)',
      el5['cost-breakdown'].innerHTML.includes('0.001972 OKB'));
    check('no fake live price shown (9898 still at snapshot 0.000001 OKB)',
      el5['processor-body'].innerHTML.includes('0.000001 OKB'));
  }

  // ---- verify flow in the DOM (adder, exhaustive) ----
  console.log('\n[verify flow]');
  const TF = sb1.window.TapeForgeCircuit;
  const adder = TF.TEMPLATES.find((t) => t.id === 'adder');
  const r = TF.verifyCircuit(adder.build(), adder.expected);
  check('adder verifies 65,536/65,536 in the app context', r.passed === 65536 && r.failed === 0);

  // ---- interactive flows (template load, verify UI, add gate, undo/redo) ----
  console.log('\n[interactive flows]');
  {
    const app = sb1.window.TapeForgeApp;
    const TF2 = sb1.window.TapeForgeCircuit;
    const adder = TF2.TEMPLATES.find((t) => t.id === 'adder');
    app.loadTemplate(adder);
    check('adder loads: 68 gates in status', el1['live-status'].innerHTML.includes('68 gates · 16 inputs · 9 outputs'));
    check('adder renders 68 NAND gates', (el1.canvas.innerHTML.match(/>NAND</g) || []).length === 68);
    check('adder netlist has 68 gate lines', (el1['netlist-view'].textContent.match(/^g\d+ = NAND\(/gm) || []).length === 68);
    el1['btn-verify']._listeners.click[0](); // the real Verify button wiring
    check('adder verify summary: 65,536/65,536 pass', el1['verify-summary'].innerHTML.includes('65,536/65,536 cases pass'));
    check('verify table rendered with S0 column', el1['verify-table-wrap'].innerHTML.includes('<table>') && el1['verify-table-wrap'].innerHTML.includes('S0'));
    const cmp = TF2.TEMPLATES.find((t) => t.id === 'comparator');
    app.loadTemplate(cmp);
    app.runVerify();
    check('comparator verify summary: 65,536/65,536 pass', el1['verify-summary'].innerHTML.includes('65,536/65,536 cases pass'));
    check('comparator table has GT/EQ/LT columns', el1['verify-table-wrap'].innerHTML.includes('GT') && el1['verify-table-wrap'].innerHTML.includes('EQ'));
    const before = app.getState().circuit.gates.length; // 129
    el1['btn-add-gate']._listeners.click[0]();
    check('add gate increases count to 130', app.getState().circuit.gates.length === before + 1);
    app.undo();
    check('undo restores 129 gates', app.getState().circuit.gates.length === before);
    app.redo();
    check('redo re-adds the gate (130)', app.getState().circuit.gates.length === before + 1);
    check('edited circuit is marked custom', el1['circuit-name'].textContent === 'Custom circuit');
    // zoom controls + hint bar (new in this iteration)
    check('zoom label shows a percentage', /^\d+%$/.test(el1['zoom-label'].textContent));
    check('canvas has a viewBox', (el1.canvas._attrs.viewBox || '').startsWith('0 0 '));
    const vbW = +el1.canvas._attrs.viewBox.split(' ')[2];
    el1['btn-zoom-100']._listeners.click[0]();
    check('100% zoom: label 100%, width equals natural canvas width',
      el1['zoom-label'].textContent === '100%' && +el1.canvas._attrs.width === vbW);
    el1['btn-zoom-in']._listeners.click[0]();
    check('zoom in: width grows to 125% of natural',
      +el1.canvas._attrs.width === Math.round(vbW * 1.25) && el1['zoom-label'].textContent === '125%');
    el1['btn-zoom-out']._listeners.click[0]();
    check('zoom out: width back to 100%',
      +el1.canvas._attrs.width === vbW && el1['zoom-label'].textContent === '100%');
    el1['btn-zoom-fit']._listeners.click[0]();
    check('Fit: width no wider than natural canvas',
      +el1.canvas._attrs.width <= vbW && /^\d+%$/.test(el1['zoom-label'].textContent));
    el1['hint-close']._listeners.click[0]();
    check('hint bar hides on ✕', el1['hint-bar']._attrs.hidden === '');
    check('Delete button disabled when nothing selected',
      el1['btn-delete'].disabled === true);
  }

  // ---- audit regression flows (verify staleness, expected-function
  // preservation, export gating, sold-out processor) ----
  console.log('\n[audit regression flows]');
  {
    const app = sb1.window.TapeForgeApp;
    const TF2 = sb1.window.TapeForgeCircuit;
    const con = TF2.TEMPLATES.find((t) => t.id === 'consensus');
    // Stale verify: verify, then delete a wire -> summary + table cleared.
    app.loadTemplate(con);
    app.runVerify();
    check('consensus verifies 8/8 before the edit', el1['verify-summary'].innerHTML.includes('8/8 cases pass'));
    check('consensus truth table rendered', el1['verify-table-wrap'].innerHTML.includes('<table>'));
    app.deleteWire('output:out0');
    check('stale verify summary cleared after deleting a wire',
      el1['verify-summary'].innerHTML.includes('Press') && !el1['verify-summary'].innerHTML.includes('cases pass'));
    check('stale truth table cleared after deleting a wire', el1['verify-table-wrap'].innerHTML === '');
    // The same edit must NOT verify as a pass: disconnecting the output is
    // a structural error, not 8/8 pass.
    app.runVerify();
    check('disconnected output verifies as an error, not a pass',
      el1['verify-summary'].innerHTML.includes('Cannot verify') && !el1['verify-summary'].innerHTML.includes('cases pass'));
    app.undo(); // wire back
    check('undo restores the wire and clears the stale error',
      el1['verify-summary'].innerHTML.includes('Press'));
    // Expected function survives a rename (ids unchanged) …
    app.getState().circuit.inputs[0].name = 'RISK2';
    app.renderAll();
    app.runVerify();
    check('renaming a pin keeps the expected function (still 8/8)',
      el1['verify-summary'].innerHTML.includes('8/8 cases pass'));
    // … but adding a pin drops it: the interface changed, so verify must
    // report "simulated, no expected function" with NO pass count.
    el1['btn-add-input']._listeners.click[0]();
    app.runVerify();
    check('adding a pin drops the expected function (no pass count)',
      el1['verify-summary'].innerHTML.includes('no expected function') && !el1['verify-summary'].innerHTML.includes('cases pass'));
    check('dropped-function note names the pin interface change',
      el1['verify-summary'].innerHTML.includes('Pin interface changed'));
    // Adding a gate keeps the expected function (pin ids unchanged) but the
    // new gate is unwired, so verify errors instead of passing.
    app.loadTemplate(con);
    el1['btn-add-gate']._listeners.click[0]();
    app.runVerify();
    check('unwired added gate verifies as an error, not a pass',
      el1['verify-summary'].innerHTML.includes('Cannot verify') && !el1['verify-summary'].innerHTML.includes('cases pass'));
    // Export gating: an invalid circuit disables Download/Copy and names
    // the blocking reason; the draft preview stays available.
    app.loadTemplate(con);
    app.deleteWire('output:out0');
    check('export status names the blocking reason for an invalid circuit',
      el1['export-status'].innerHTML.includes('Not tape-out ready') && el1['export-status'].innerHTML.includes('out0'));
    check('download disabled for an invalid circuit', el1['btn-download'].disabled === true);
    check('copy disabled for an invalid circuit', el1['btn-copy'].disabled === true);
    check('draft preview stays available for an invalid circuit',
      el1['netlist-view'].textContent.includes('DRAFT ONLY'));
    app.undo();
    check('export re-enabled once the circuit is valid again',
      el1['btn-download'].disabled === false && el1['export-status'].innerHTML.includes('Tape-out ready'));
    // Sold-out processor: selecting ViperX shows "unavailable (sold out)"
    // and no normal quote.
    app.selectProcessor(4);
    check('sold-out ViperX shows "unavailable (sold out)", no normal quote',
      el1['cost-breakdown'].innerHTML.includes('unavailable (sold out)') && !el1['cost-breakdown'].innerHTML.includes('Estimated total'));
    check('ViperX row is tagged sold out', el1['processor-body'].innerHTML.includes('sold out'));
    app.selectProcessor(0);
    check('selecting 9898 again restores the normal quote',
      el1['cost-breakdown'].innerHTML.includes('Estimated total'));
  }

  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

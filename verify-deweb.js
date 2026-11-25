// TapeForge DeWEB verifier — run with: node verify-deweb.js
// Reads tapeforge-deweb.html (built by node build-deweb.js), asserts it is a
// single self-contained file (no <link>, no <script src>, no local file
// references), extracts its inline <style> + <script> blocks, and loads the
// scripts in the same minimal DOM shim smoke-test.js uses — confirming the
// DeWEB file actually initialises and a template loads. Exit non-zero on any
// failure.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = fs.readFileSync('./tapeforge-deweb.html', 'utf8');

// ---- static structure checks ----
console.log('\n[deweb file structure]');
check('no <link> tag', !/<link\b/i.test(html));
check('no <script src>', !/<script[^>]+src\s*=/i.test(html));
check('no local .css/.js/.html file reference', !/(?:href|src)\s*=\s*"[^"]*\.(css|js|html)"/i.test(html));
check('no http(s) asset URL in markup', !/(?:href|src)\s*=\s*"https?:/i.test(html));
const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) || [];
const scriptBlocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
check('exactly 1 inline <style> block', styleBlocks.length === 1, 'found ' + styleBlocks.length);
check('exactly 2 inline <script> blocks', scriptBlocks.length === 2, 'found ' + scriptBlocks.length);
check('style block is the chip-fab theme', styleBlocks[0] && styleBlocks[0].includes('--bg: #07090c'));
check('first script is circuit.js (TapeForgeCircuit)', scriptBlocks[0] && scriptBlocks[0].includes('TapeForgeCircuit'));
check('second script is app.js (TapeForgeApp)', scriptBlocks[1] && scriptBlocks[1].includes('TapeForgeApp'));
check('hint bar present', html.includes('id="hint-bar"'));
check('zoom controls present', html.includes('id="btn-zoom-fit"') && html.includes('id="zoom-label"') && html.includes('id="canvas-size"'));
const scripts = scriptBlocks.map((b) => b.replace(/<\/?script>/g, ''));
check('inlined circuit.js is byte-identical to circuit.js',
  scripts[0].trim() === fs.readFileSync('./circuit.js', 'utf8').trim());
check('inlined app.js is byte-identical to app.js',
  scripts[1].trim() === fs.readFileSync('./app.js', 'utf8').trim());

// ---- runtime: same minimal DOM shim as smoke-test.js ----
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
    console, setTimeout, clearTimeout, fetch: fetchImpl, AbortSignal,
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

(async () => {
  console.log('\n[deweb file loads and initialises]');
  const sb = makeSandbox(() => Promise.reject(new Error('network down')));
  vm.createContext(sb);
  vm.runInContext(scripts[0], sb, { filename: 'tapeforge-deweb.html <circuit.js>' });
  vm.runInContext(scripts[1], sb, { filename: 'tapeforge-deweb.html <app.js>' });
  const el = sb._elements;
  await sleep(2500); // let the background RPC refresh fail and fall back
  check('template list has all 6 templates',
    ['8-bit Adder', '8-bit Comparator', '4-to-1 Multiplexer', 'Majority Voter', 'Parity Checker', '2-of-3 Consensus']
      .every((n) => el['template-list'].innerHTML.includes(n)));
  check('default template is the 2-of-3 consensus (12 gates)',
    el['live-status'].innerHTML.includes('12 gates · 3 inputs · 1 outputs'));
  check('canvas renders 12 NAND gates', (el.canvas.innerHTML.match(/>NAND</g) || []).length === 12);
  check('canvas has a viewBox (zoom works)', (el.canvas._attrs.viewBox || '').startsWith('0 0 '));
  check('zoom label shows a percentage', /^\d+%$/.test(el['zoom-label'].textContent));
  check('canvas size readout present', el['canvas-size'].textContent.includes('px'));
  check('processor table lists 9898, XBOT, ViperX',
    el['processor-body'].innerHTML.includes('9898') && el['processor-body'].innerHTML.includes('XBOT') && el['processor-body'].innerHTML.includes('ViperX'));
  check('netlist has 12 gate lines', (el['netlist-view'].textContent.match(/^G\d+ = NAND\(/gm) || []).length === 12);
  check('data source says cached snapshot', el['data-source'].innerHTML.includes('cached snapshot'));
  check('cost total for 12 gates on 9898 = 0.001312 OKB',
    el['cost-breakdown'].innerHTML.includes('0.001312 OKB'));

  console.log('\n[deweb file: template load + verify]');
  const app = sb.window.TapeForgeApp;
  const TF = sb.window.TapeForgeCircuit;
  const adder = TF.TEMPLATES.find((t) => t.id === 'adder');
  app.loadTemplate(adder);
  check('adder loads: 68 gates in status', el['live-status'].innerHTML.includes('68 gates · 16 inputs · 9 outputs'));
  check('adder renders 68 NAND gates', (el.canvas.innerHTML.match(/>NAND</g) || []).length === 68);
  app.runVerify();
  check('adder verify summary: 65,536/65,536 pass', el['verify-summary'].innerHTML.includes('65,536/65,536 cases pass'));
  const cmp = TF.TEMPLATES.find((t) => t.id === 'comparator');
  app.loadTemplate(cmp);
  app.runVerify();
  check('comparator verify summary: 65,536/65,536 pass', el['verify-summary'].innerHTML.includes('65,536/65,536 cases pass'));
  check('comparator renders 129 NAND gates', (el.canvas.innerHTML.match(/>NAND</g) || []).length === 129);

  console.log(failures === 0 ? '\nALL DEWEB CHECKS PASSED' : `\n${failures} DEWEB CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

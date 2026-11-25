// TapeForge — DeWEB single-file build. Run with: node build-deweb.js
// Inlines style.css, circuit.js and app.js into index.html and writes a
// single self-contained tapeforge-deweb.html: no <link>, no <script src>,
// no local file references. The only network call the file can still make is
// the optional X Layer RPC read (refreshLive), which is a feature, not a
// dependency — the app works fully offline on its cached snapshot.
// Exits non-zero if any inline is unsafe or any external reference remains.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

let html = read('index.html');
const css = read('style.css');
const circuit = read('circuit.js');
const app = read('app.js');

// Inlining safety: a literal "</script" (or "<!--") inside the JS would break
// out of the inline <script> block. Neither file contains them (checked here,
// not assumed).
for (const [name, src] of [['circuit.js', circuit], ['app.js', app]]) {
  if (src.includes('</script')) throw new Error(name + ' contains a literal </script sequence — cannot inline safely');
  if (src.includes('<!--')) throw new Error(name + ' contains <!-- — cannot inline safely');
}
if (css.includes('url(')) throw new Error('style.css references an external URL — cannot inline safely');

const cssTag = '<link rel="stylesheet" href="style.css">';
const circuitTag = '<script src="circuit.js"></script>';
const appTag = '<script src="app.js"></script>';
if (!html.includes(cssTag)) throw new Error('index.html: stylesheet link not found');
if (!html.includes(circuitTag)) throw new Error('index.html: circuit.js script tag not found');
if (!html.includes(appTag)) throw new Error('index.html: app.js script tag not found');

// NOTE: use replacer FUNCTIONS, not replacement strings — String.replace
// interprets $ patterns ($&, $', $`, $$) in a replacement string, and the
// app source legitimately contains "$'" (the 'OKB ≈ $' cost line), which
// would otherwise splice the rest of index.html into the middle of the JS.
html = html.replace(cssTag, () => '<style>\n' + css + '\n</style>');
html = html.replace(circuitTag, () => '<script>\n' + circuit + '\n</script>');
html = html.replace(appTag, () => '<script>\n' + app + '\n</script>');

// The output must contain both sources whole (a mangled inline would fail
// these markers — this is what caught the $-pattern bug above).
if (!html.includes('setTimeout(refreshLive, 800);')) throw new Error('output is missing the tail of app.js');
// circuit.js tail marker: the old PROCESSOR_OPEN_FEE_OKB marker matched
// the v1 export, but the audit fix removed that export (it was the stale
// hardcoded 0.0066 OKB deploy fee — the live deployFee is now read from
// the factory); use a real export from circuit.js's return object.
if (!html.includes('PAYLOAD_HEADER_BYTES: PAYLOAD_HEADER_BYTES')) throw new Error('output is missing the tail of circuit.js');

// The output must not reference any file: no <link>, no external <script src>,
// no href/src pointing at a local .css/.js/.html file.
if (/<link\b/i.test(html)) throw new Error('output still contains a <link>');
if (/<script[^>]+src\s*=/i.test(html)) throw new Error('output still contains an external <script src>');
if (/(?:href|src)\s*=\s*"[^"]*\.(css|js|html)"/i.test(html)) throw new Error('output still references a local file');

const out = path.join(dir, 'tapeforge-deweb.html');
fs.writeFileSync(out, html);
console.log('wrote tapeforge-deweb.html (' + Buffer.byteLength(html) + ' bytes, ' +
  html.split('\n').length + ' lines) — single file, no external references');

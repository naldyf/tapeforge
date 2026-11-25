# TapeForge — a visual NAND circuit designer for TapeOut on X Layer

Design a NAND circuit, verify it exhaustively, price it against real TapeOut
processors on X Layer, and export the netlist ready to tape out. No Verilog, no
Yosys, no wallet needed to design, verify, price or export.

Built for the **OKX X Layer TapeOut Accelerate** hackathon (deadline 7 Dec 2026).
TapeOut is the on-chain hardware manufacturing protocol: the blockchain is the
wafer, tokens are transistors, NAND computes. One NAND gate = one transistor
(ERC-1155), and a full set of transistors etches a circuit (ERC-721).

## Run it

No build step, no server, no install. Open `index.html` in any modern browser
(`file://` works), or serve the folder with any static host:

```
python3 -m http.server 8000   # then open http://localhost:8000
```

Everything runs in the browser. The only network call is the optional live
X Layer RPC read (see Cost below); the app works fully offline on its cached
snapshot.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure: header, toolbar, templates sidebar, SVG editor, verification / cost / export panels, footer. |
| `style.css` | Dark "chip fab" theme. No external fonts or assets. Three-column layout (250px templates / editor / 380px panels); below 1240px the panels stack underneath in a responsive grid. |
| `circuit.js` | **Pure logic, no DOM.** Circuit model, NAND builders, the 6 templates, topological simulation, exhaustive verification, netlist export, cost math. Loads in the browser (`window.TapeForgeCircuit`) and in Node (`require`) so it can be tested headlessly. |
| `app.js` | UI layer: SVG editor (drag gates, click ports to wire, click input pins to toggle 0/1, click a wire to remove it, right-click to delete, double-click a pin to rename, undo/redo, clear), live simulation, verification panel, cost panel with live RPC refresh, netlist export (download / copy), zoom controls (Fit / 100% / + / −), dismissible "How to use" hint bar. |
| `build-deweb.js` | Builds the DeWEB single file: inlines style.css + circuit.js + app.js into index.html and writes `tapeforge-deweb.html` (72,245 bytes). Run with `node build-deweb.js`. Uses replacer functions for the inlining — a plain replacement string would corrupt the JS because the app source contains `$'` (the 'OKB ≈ $' cost line), which String.replace interprets as a special pattern. The build asserts both sources survive whole. |
| `tapeforge-deweb.html` | The built single file (generated — do not edit by hand). No `<link>`, no `<script src>`, no local file references; the only network call it can still make is the optional X Layer RPC read. |
| `verify-deweb.js` | Verifies `tapeforge-deweb.html`: static structure (no external refs, 1 style + 2 script blocks, inlined sources byte-identical to the files) and runtime (loads the file's own scripts in the DOM shim and confirms init, template load and verification). Run with `node verify-deweb.js`. |
| `test.js` | Node tests: exhaustive template verification, spot checks, cost math, loop + unconnected-input handling. Run with `node test.js`. |
| `smoke-test.js` | Headless DOM smoke test (minimal DOM shim, no browser needed): app init, template rendering, Verify button, add-gate / undo / redo, zoom controls, hint bar, Delete-button state, and both cost-data paths (snapshot fallback when the RPC is down, live update when it answers). Run with `node smoke-test.js`. |

## What it does

**Editor.** Drag NAND gates onto the canvas, add input/output pins, and wire
them by clicking an output port then an input port. Click an input pin to flip
it 0/1 and watch the outputs update live. Delete, clear, undo (Ctrl+Z) and redo
(Ctrl+Y) are all supported. Combinational loops are detected and reported;
unconnected gate inputs read as 0 and are flagged. A "How to use" hint bar at
the top of the editor explains the 3 steps (pick a template → wire ports →
verify / price / export); dismiss it with ✕. The canvas has zoom controls
(Fit / 100% / + / −): it opens in Fit mode, so even the widest templates
(comparator ~4,494 px, adder ~2,454 px, parity ~2,814 px) are visible whole,
and you zoom in to work on a region. Zoom is implemented with an SVG viewBox,
so dragging, wiring and hit-testing keep working at any zoom, and the canvas
still scrolls horizontally inside its scroll container when zoomed in. Loading
a new template resets the scroll to the top-left.

**Templates (one click, all NAND-only, all verified).**

| Template | Gates | Inputs | Verified |
|---|---|---|---|
| 8-bit Adder | 68 | 16 | 65,536/65,536 exhaustive |
| 8-bit Comparator | 129 | 16 | 65,536/65,536 exhaustive |
| 4-to-1 Multiplexer | 24 | 6 | 64/64 exhaustive |
| Majority Voter (3-input) | 12 | 3 | 8/8 exhaustive |
| Parity Checker (8-bit) | 28 | 8 | 256/256 exhaustive |
| 2-of-3 Consensus (XBOT pattern) | 12 | 3 | 8/8 exhaustive |

The adder uses the canonical 9-transistor full adder (1 half adder + 7 full
adders = 68 gates). The consensus template is the XBOT pattern:
`CONSENSUS = majority(RISK, LIQ, MKT)` — act only when at least 2 of 3
signals agree.

**Verification.** "Verify circuit" simulates every input combination
(up to 16 inputs = 65,536 cases; more inputs are sampled deterministically:
all-zero, all-one, single-bit, + 4,096 seeded random cases) and checks the
outputs against the expected function. Shows a pass/fail summary and a truth
table (failures first). Custom circuits get a structural check + simulated
truth table instead.

**Cost.** Gate count × transistor price, from real processors on X Layer
(chain 196). The table lists the processor, its price per transistor, circuits
fabricated, and minted/supply. Click a row to re-price with it. Total =
transistors + the ~0.0013 OKB tape-out fee; the 0.0066 OKB processor-opening
fee is an optional line (only if you open your own processor).

**Export.** Downloads or copies the exact NAND netlist (`G0 = NAND(A0, B0)` …,
`S0 = G3` …) plus the three tape-out steps.

**DeWEB single file.** `node build-deweb.js` writes `tapeforge-deweb.html` — the
whole app (CSS + both scripts) inlined into one 72,245-byte file with no
external references, ready to be stored in a TapeOut circuit container and
served as a DeWEB site. `node verify-deweb.js` checks the file's structure and
loads its own scripts headlessly to confirm it initialises, loads templates
and verifies circuits.

## Cost data — real X Layer processors

The snapshot was read from chain on **25 Nov 2026, 12:53 UTC** via the public
X Layer RPC, using the factory `0x1f09daefa827f02cbb40967cc91b259763760761`
and the same selectors as the public read script in
https://openwitness.net/p/9897 (`cpuCount` 0xa94da8a7, `cpuAt` 0x4bc7cbbd,
`transistors` 0x6fbd1719, `nextId` 0x61b8ce8c, token `price` 0x6817c76c,
`minted` 0x4f02c420, `cap` 0x8f770ad0). At that moment: 450 processors,
12,242 circuits, median price 0.00066 OKB.

| Processor | Address | Price / transistor | Circuits | Supply |
|---|---|---|---|---|
| 9898 | `0x60918c204f3c94630d3d793738fc36293c8405d6` | 0.000001 OKB | 1,022 | 16,511 / 1,000,000,000,000 |
| FAB-Genisis | `0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6` | 0.0005 OKB | 7,164 | 1,000,000 / 1,000,000 (sold out) |
| TAPELIQUID | `0x69f663931209096037474d7c20402232e5c762ca` | 0.00066 OKB | 1,408 | 2,100,000 / 2,100,000 (sold out) |
| XBOT | `0xa5fc69Ca2D3d462CCa204D894D85ac8071c4F0f0` | 0.009 OKB | 5 | 40 / 1,000,000,000 |
| ViperX | `0xb57b56034e2dc25161e2512CfC40b24EA3bee1Fb` | 0 OKB (free) | 4 | 158 / 158 (sold out) |
| Cheapest available | `0x99081e1d0ce916cd5b2c53e769dfc3b000bfe9a4` | 1 wei | 19 | 281 / 1e24 |

Names FAB-Genisis / TAPELIQUID / 9898 are from the 23 Oct 2026 openwitness
survey; their addresses match that survey's price + circuit-count signature.
XBOT's 0.009 OKB price is confirmed both on its site (xbotprocessor.com) and
on-chain. Press **↻ Refresh live** to re-read all six from the public X Layer
RPC (`https://rpc.xlayer.tech`, which allows CORS, falling back to
`https://tapeout.net/rpc-xlayer`); if the RPC is unreachable the snapshot
stays and the panel says so.

Worked example: the 8-bit adder (68 gates) on 9898 costs
68 × 0.000001 + 0.0013 = **0.001368 OKB**; on XBOT it is 68 × 0.009 + 0.0013 =
**0.6133 OKB**.

## Test results

```
$ node test.js        # ALL TESTS PASSED
$ node smoke-test.js  # ALL SMOKE TESTS PASSED (incl. zoom controls, hint bar, Delete-button state)
$ node build-deweb.js # wrote tapeforge-deweb.html (72,245 bytes, 1,556 lines)
$ node verify-deweb.js # ALL DEWEB CHECKS PASSED
```

- Adder 65,536/65,536, comparator 65,536/65,536, mux 64/64, majority 8/8,
  parity 256/256, consensus 8/8 — all exhaustive, all pass.
- Spot checks: 200+55=255 cout 0; 200+100=44 cout 1; 5 vs 3 → GT; 7 vs 7 →
  EQ; mux selections; majority/consensus cases; parity cases.
- Cost math verified against the worked examples above.
- Loop detection and unconnected-input handling verified.
- DOM smoke test: both cost paths (snapshot fallback + live RPC update with
  changed prices), template loading, Verify button, add-gate / undo / redo,
  zoom controls (Fit / 100% / + / − with exact width math), hint-bar dismiss,
  Delete button disabled when nothing is selected.
- DeWEB file: 28 checks — structure (no `<link>`, no `<script src>`, no local
  file refs, 1 style + 2 script blocks, inlined sources byte-identical to the
  files) and runtime (init, template load, adder + comparator verify
  65,536/65,536, cost total 0.001312 OKB for the 12-gate consensus on 9898).

## What is NOT done / known limits

- **No visual browser test.** The VM's Chromium is blocked by a Hatch WebGL
  domain policy at startup, so the UI was verified with the headless DOM smoke
  test above, not a real rendered screenshot. The layout was reviewed at the
  code level: 1440px = 250px templates + ~810px editor + 380px panels (grid,
  no overlap); at ≤1240px the panels stack below the editor in a responsive
  grid. Open `index.html` in a browser to eyeball it — especially: the Fit
  zoom on the comparator at 1440px, the hint bar, and the stacked panels at
  1024px.
- **Nothing is deployed on-chain.** No wallet, no key, no transaction was
  created. Taping out a real circuit needs a wallet + OKB (that is the user's
  step, explained in the Export panel).
- The live RPC read needs the public RPC to answer; `rpc.xlayer.tech` allows
  CORS (`Access-Control-Allow-Origin: *`, checked 25 Nov 2026), so it works
  from `file://` too. If it ever stops, the snapshot + Refresh button cover it.
- Verilog synthesis (Yosys) is out of scope by design: this is a gate-level
  designer, not a synthesiser. Circuits larger than 16 inputs are verified by
  deterministic sampling, not exhaustively.
- OKB→USD uses an approximate $79/OKB (25 Nov 2026) and is labelled as an
  estimate.

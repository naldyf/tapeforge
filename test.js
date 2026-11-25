// TapeForge template tests — run with: node test.js
// Exhaustively simulates every template against its expected function and
// asserts gate counts, spot values, netlist shape, cost math and loop detection.
const TF = require('./circuit.js');
let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); failures++; }
}

console.log('== TapeForge template verification ==');
for (const t of TF.TEMPLATES) {
  const circuit = t.build();
  console.log(`\n[${t.id}] ${t.name}`);
  check('gate count = ' + t.gates, circuit.gates.length === t.gates,
    'got ' + circuit.gates.length);
  const t0 = Date.now();
  const r = TF.verifyCircuit(circuit, t.expected);
  console.log(`  verify: ${r.passed}/${r.total} cases pass` +
    (r.sampled ? ' (sampled)' : ' (exhaustive)') + ` in ${Date.now() - t0} ms`);
  check('all cases pass', r.failed === 0, JSON.stringify(r.failures.slice(0, 2)));
  const net = TF.exportNetlist(circuit, t.name);
  const gateLines = net.split('\n').filter((l) => /^G\d+ = NAND\(/.test(l));
  check('netlist has one line per gate', gateLines.length === circuit.gates.length);
  check('netlist round-trips gate count', (net.match(/NAND\(/g) || []).length === circuit.gates.length);
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

// Cost math.
console.log('\n== Cost ==');
{
  const c = TF.costEstimate(68, 0.000001); // adder on 9898
  check('adder on 9898: 68 x 0.000001 + 0.0013 = 0.001368 OKB',
    Math.abs(c.total - 0.001368) < 1e-12, 'got ' + c.total);
  const c2 = TF.costEstimate(68, 0.009); // adder on XBOT
  check('adder on XBOT: 68 x 0.009 + 0.0013 = 0.6133 OKB',
    Math.abs(c2.total - 0.6133) < 1e-12, 'got ' + c2.total);
  const c3 = TF.costEstimate(12, 0); // majority on a free processor
  check('free processor: total = tape-out fee only', Math.abs(c3.total - 0.0013) < 1e-12);
  check('formatOkb(0.001368)', TF.formatOkb(0.001368) === '0.001368', TF.formatOkb(0.001368));
  check('formatOkb(1e-18)', TF.formatOkb(1e-18) === '1.00e-18', TF.formatOkb(1e-18));
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
  const open = {
    inputs: [{ id: 'in0', name: 'A' }],
    gates: [{ id: 'g0', a: { k: 'i', id: 'in0' }, b: null }],
    outputs: [{ id: 'out0', name: 'Y', src: { k: 'g', id: 'g0' } }],
  };
  const r2 = TF.verifyCircuit(open, null);
  check('unconnected input counted', r2.unconnected === 1, 'got ' + r2.unconnected);
  check('unconnected input reads as 0 (NAND(A,0)=1)',
    TF.simulate(open, [1]).outputs[0] === 1);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

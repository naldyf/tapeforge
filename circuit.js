// TapeForge — pure circuit logic (no DOM). Works in the browser (window.TapeForgeCircuit)
// and in Node (module.exports) so the templates can be exhaustively tested.
//
// Circuit model
//   inputs : [{ id, name }]
//   gates  : [{ id, a, b }]          a, b are source refs
//   outputs: [{ id, name, src }]    src is a source ref
// A source ref is { k: 'i', id } (an input pin) or { k: 'g', id } (a gate output).
// A gate input may be null while the user is still wiring it (treated as 0, flagged).
// Every gate is a 2-input NAND: out = NOT (a AND b). One NAND gate = one transistor
// on TapeOut (ERC-1155 transistor token), which is why the cost model is
// "gate count x transistor price".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapeForgeCircuit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- builders
  function createBuilder(inputNames) {
    const b = {
      inputs: inputNames.map(function (name, i) { return { id: 'in' + i, name: name }; }),
      gates: [],
      outputs: [],
      inByIndex: function (i) { return { k: 'i', id: this.inputs[i].id }; },
      nand: function (a, b) {
        var id = 'g' + this.gates.length;
        this.gates.push({ id: id, a: a, b: b });
        return { k: 'g', id: id };
      },
      not: function (x) { return this.nand(x, x); },
      and: function (a, b) { return this.not(this.nand(a, b)); },
      or: function (a, b) { return this.nand(this.not(a), this.not(b)); },
      xor: function (a, b) {
        var t = this.nand(a, b);
        return this.nand(this.nand(a, t), this.nand(b, t));
      },
      // Half adder, 5 NANDs (shares the NAND(a,b) node between sum and carry).
      halfAdder: function (a, b) {
        var n1 = this.nand(a, b);
        var sum = this.nand(this.nand(a, n1), this.nand(b, n1));
        var cout = this.not(n1);
        return { sum: sum, cout: cout };
      },
      // Full adder, 9 NANDs (the canonical 9-transistor full adder).
      fullAdder: function (a, b, cin) {
        var n1 = this.nand(a, b);
        var x = this.nand(this.nand(a, n1), this.nand(b, n1)); // a xor b
        var n4 = this.nand(x, cin);
        var sum = this.nand(this.nand(x, n4), this.nand(cin, n4));
        var cout = this.nand(n1, n4); // (a & b) | (cin & (a xor b))
        return { sum: sum, cout: cout };
      },
      // 2-to-1 mux, 8 NANDs. Returns sel ? b : a.
      mux: function (a, b, sel) {
        return this.or(this.and(this.not(sel), a), this.and(sel, b));
      },
      out: function (name, src) {
        var id = 'out' + this.outputs.length;
        this.outputs.push({ id: id, name: name, src: src });
        return id;
      },
      build: function () {
        return { inputs: this.inputs, gates: this.gates, outputs: this.outputs };
      }
    };
    return b;
  }

  // ---------------------------------------------------------------- templates
  function buildAdder() {
    var names = [];
    for (var i = 0; i < 8; i++) names.push('A' + i);
    for (var j = 0; j < 8; j++) names.push('B' + j);
    var b = createBuilder(names);
    var A = function (i) { return b.inByIndex(i); };
    var B = function (i) { return b.inByIndex(8 + i); };
    var carry = null;
    for (var i = 0; i < 8; i++) {
      var r = (i === 0) ? b.halfAdder(A(0), B(0)) : b.fullAdder(A(i), B(i), carry);
      b.out('S' + i, r.sum);
      carry = r.cout;
    }
    b.out('COUT', carry);
    return b.build();
  }
  function adderExpected(bits) {
    var a = 0, bb = 0;
    for (var i = 0; i < 8; i++) { a |= bits[i] << i; bb |= bits[8 + i] << i; }
    var s = a + bb, out = [];
    for (var k = 0; k < 8; k++) out.push((s >> k) & 1);
    out.push((s >> 8) & 1);
    return out;
  }

  function buildComparator() {
    var names = [];
    for (var i = 0; i < 8; i++) names.push('A' + i);
    for (var j = 0; j < 8; j++) names.push('B' + j);
    var b = createBuilder(names);
    var A = function (i) { return b.inByIndex(i); };
    var B = function (i) { return b.inByIndex(8 + i); };
    var eq = [], gt = [];
    for (var i = 0; i < 8; i++) {
      eq[i] = b.not(b.xor(A(i), B(i)));          // XNOR
      gt[i] = b.and(A(i), b.not(B(i)));          // single-bit A > B
    }
    var eqAll = eq[0];
    for (var i = 1; i < 8; i++) eqAll = b.and(eqAll, eq[i]);
    var terms = [];
    terms[7] = gt[7];
    var p = eq[7];
    for (var k = 6; k >= 0; k--) {
      terms[k] = b.and(p, gt[k]);
      if (k > 0) p = b.and(p, eq[k]);
    }
    var gtAll = terms[0];
    for (var m = 1; m < 8; m++) gtAll = b.or(gtAll, terms[m]);
    var lt = b.not(b.or(eqAll, gtAll));
    b.out('GT', gtAll);
    b.out('EQ', eqAll);
    b.out('LT', lt);
    return b.build();
  }
  function comparatorExpected(bits) {
    var a = 0, bb = 0;
    for (var i = 0; i < 8; i++) { a |= bits[i] << i; bb |= bits[8 + i] << i; }
    return [a > bb ? 1 : 0, a === bb ? 1 : 0, a < bb ? 1 : 0];
  }

  function buildMux() {
    var b = createBuilder(['D0', 'D1', 'D2', 'D3', 'S0', 'S1']);
    var D = function (i) { return b.inByIndex(i); };
    var S0 = b.inByIndex(4), S1 = b.inByIndex(5);
    var m0 = b.mux(D(0), D(1), S0);
    var m1 = b.mux(D(2), D(3), S0);
    b.out('Y', b.mux(m0, m1, S1));
    return b.build();
  }
  function muxExpected(bits) {
    var sel = (bits[5] << 1) | bits[4];
    return [bits[sel]];
  }

  function buildMajority() {
    var b = createBuilder(['A', 'B', 'C']);
    var A = b.inByIndex(0), B = b.inByIndex(1), C = b.inByIndex(2);
    var out = b.or(b.or(b.and(A, B), b.and(B, C)), b.and(A, C));
    b.out('OUT', out);
    return b.build();
  }
  function majorityExpected(bits) {
    return [(bits[0] + bits[1] + bits[2]) >= 2 ? 1 : 0];
  }

  function buildParity() {
    var names = [];
    for (var i = 0; i < 8; i++) names.push('D' + i);
    var b = createBuilder(names);
    var D = function (i) { return b.inByIndex(i); };
    var p = b.xor(D(0), D(1));
    for (var i = 2; i < 8; i++) p = b.xor(p, D(i));
    b.out('P', p);
    return b.build();
  }
  function parityExpected(bits) {
    var p = 0;
    for (var i = 0; i < 8; i++) p ^= bits[i];
    return [p];
  }

  function buildConsensus() {
    var b = createBuilder(['RISK', 'LIQ', 'MKT']);
    var R = b.inByIndex(0), L = b.inByIndex(1), M = b.inByIndex(2);
    var out = b.or(b.or(b.and(R, L), b.and(L, M)), b.and(R, M));
    b.out('CONSENSUS', out);
    return b.build();
  }
  function consensusExpected(bits) {
    return [(bits[0] + bits[1] + bits[2]) >= 2 ? 1 : 0];
  }

  var TEMPLATES = [
    {
      id: 'adder', name: '8-bit Adder', gates: 68,
      blurb: 'Adds two 8-bit numbers. 1 half adder + 7 full adders (9 NANDs each). Outputs S0–S7 and COUT.',
      build: buildAdder, expected: adderExpected
    },
    {
      id: 'comparator', name: '8-bit Comparator', gates: 129,
      blurb: 'Compares two 8-bit numbers. Outputs GT (A>B), EQ (A=B), LT (A<B).',
      build: buildComparator, expected: comparatorExpected
    },
    {
      id: 'mux', name: '4-to-1 Multiplexer', gates: 24,
      blurb: 'Selects one of D0–D3 with S1:S0. Built from three 2-to-1 muxes (8 NANDs each).',
      build: buildMux, expected: muxExpected
    },
    {
      id: 'majority', name: 'Majority Voter (3-input)', gates: 12,
      blurb: 'OUT = 1 when at least 2 of A, B, C are 1. AB + BC + AC, NAND-only.',
      build: buildMajority, expected: majorityExpected
    },
    {
      id: 'parity', name: 'Parity Checker (8-bit)', gates: 28,
      blurb: 'OUT = XOR of D0–D7 (1 when the number of 1s is odd). A 7-XOR tree.',
      build: buildParity, expected: parityExpected
    },
    {
      id: 'consensus', name: '2-of-3 Consensus (XBOT pattern)', gates: 12,
      blurb: 'CONSENSUS = majority of RISK, LIQ, MKT — the XBOT risk-circuit pattern: act only when at least 2 of 3 signals agree.',
      build: buildConsensus, expected: consensusExpected
    }
  ];

  // ------------------------------------------------------------- compilation
  // Compile a circuit into flat arrays for fast repeated evaluation.
  // values[] layout: [0..nInputs) inputs, [nInputs..nInputs+nGates) gate outputs,
  // [nInputs+nGates] constant 0 (unconnected gate inputs read as 0).
  function compile(circuit) {
    var nIn = circuit.inputs.length, nG = circuit.gates.length;
    var gateIdx = {}, inIdx = {};
    circuit.gates.forEach(function (g, i) { gateIdx[g.id] = i; });
    circuit.inputs.forEach(function (p, i) { inIdx[p.id] = i; });
    var CONST0 = nIn + nG;
    function srcSlot(s) {
      if (!s) return CONST0;
      if (s.k === 'i') return (s.id in inIdx) ? inIdx[s.id] : CONST0;
      if (s.k === 'g') return (s.id in gateIdx) ? nIn + gateIdx[s.id] : CONST0;
      return CONST0;
    }
    // Kahn topological sort (detects combinational loops).
    var indeg = new Array(nG).fill(0), adj = [];
    for (var i = 0; i < nG; i++) adj.push([]);
    for (var k = 0; k < nG; k++) {
      var deps = [];
      [circuit.gates[k].a, circuit.gates[k].b].forEach(function (s) {
        if (s && s.k === 'g' && (s.id in gateIdx)) deps.push(gateIdx[s.id]);
      });
      deps.forEach(function (d) { indeg[k]++; adj[d].push(k); });
    }
    var q = [];
    for (var m = 0; m < nG; m++) if (indeg[m] === 0) q.push(m);
    var order = [];
    while (q.length) {
      var u = q.shift();
      order.push(u);
      adj[u].forEach(function (v) { if (--indeg[v] === 0) q.push(v); });
    }
    if (order.length !== nG) return { error: 'combinational loop: ' + (nG - order.length) + ' gate(s) form a cycle (NAND circuits here must be acyclic)' };
    var aSrc = [], bSrc = [];
    for (var j = 0; j < nG; j++) {
      aSrc.push(srcSlot(circuit.gates[j].a));
      bSrc.push(srcSlot(circuit.gates[j].b));
    }
    var outSrc = circuit.outputs.map(function (o) { return srcSlot(o.src); });
    var unconnected = 0;
    circuit.gates.forEach(function (g) {
      if (!g.a || !g.b) unconnected++;
    });
    var unwiredOutputs = circuit.outputs.filter(function (o) { return !o.src; }).length;
    return {
      nInputs: nIn, nGates: nG, order: order, aSrc: aSrc, bSrc: bSrc,
      outSrc: outSrc, unconnected: unconnected, unwiredOutputs: unwiredOutputs,
      const0: CONST0
    };
  }

  function evalCompiled(comp, inputBits, values) {
    for (var i = 0; i < comp.nInputs; i++) values[i] = inputBits[i] ? 1 : 0;
    values[comp.const0] = 0;
    for (var k = 0; k < comp.order.length; k++) {
      var gi = comp.order[k];
      values[comp.nInputs + gi] = (values[comp.aSrc[gi]] & values[comp.bSrc[gi]]) ? 0 : 1;
    }
    var out = new Array(comp.outSrc.length);
    for (var j = 0; j < out.length; j++) out[j] = values[comp.outSrc[j]];
    return out;
  }

  function simulate(circuit, inputBits) {
    var comp = compile(circuit);
    if (comp.error) return { error: comp.error };
    var values = new Array(comp.nInputs + comp.nGates + 1).fill(0);
    var outputs = evalCompiled(comp, inputBits, values);
    var gateValues = {};
    circuit.gates.forEach(function (g, i) { gateValues[g.id] = values[comp.nInputs + i]; });
    return { outputs: outputs, gateValues: gateValues, warnings: comp };
  }

  // ------------------------------------------------------------ verification
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Exhaustively simulate every input combination (n <= 16) or a deterministic
  // sample (n > 16: all-zero, all-one, single-bit, + 4096 seeded random cases).
  // expectedFn: bits[] -> expected output bits[]; null = structural check only.
  function verifyCircuit(circuit, expectedFn) {
    var comp = compile(circuit);
    if (comp.error) return { error: comp.error, total: 0, passed: 0, failed: 0, failures: [], sampled: false };
    var n = circuit.inputs.length;
    var values = new Array(comp.nInputs + comp.nGates + 1).fill(0);
    var cases = [];
    var sampled = false;
    if (n <= 16) {
      var total = 1 << n;
      for (var c = 0; c < total; c++) cases.push(c);
    } else {
      sampled = true;
      var seen = {};
      var add = function (bits) {
        var key = bits.join('');
        if (!seen[key]) { seen[key] = 1; cases.push(bits.slice()); }
      };
      add(new Array(n).fill(0));
      add(new Array(n).fill(1));
      for (var i = 0; i < n; i++) { var s = new Array(n).fill(0); s[i] = 1; add(s); }
      var rnd = mulberry32(0xC0FFEE);
      for (var r = 0; r < 4096; r++) {
        var b2 = [];
        for (var j = 0; j < n; j++) b2.push(rnd() < 0.5 ? 0 : 1);
        add(b2);
      }
    }
    var passed = 0, failures = [];
    for (var ci = 0; ci < cases.length; ci++) {
      var bits;
      if (sampled) bits = cases[ci];
      else {
        bits = new Array(n);
        for (var b = 0; b < n; b++) bits[b] = (cases[ci] >> b) & 1;
      }
      var got = evalCompiled(comp, bits, values);
      if (!expectedFn) { passed++; continue; }
      var exp = expectedFn(bits);
      var ok = got.length === exp.length;
      if (ok) for (var o = 0; o < got.length; o++) if (got[o] !== exp[o]) { ok = false; break; }
      if (ok) passed++;
      else if (failures.length < 20) failures.push({ bits: bits.slice(), got: got.slice(), expected: exp.slice() });
    }
    return {
      total: cases.length, passed: passed, failed: cases.length - passed,
      failures: failures, sampled: sampled,
      unconnected: comp.unconnected, unwiredOutputs: comp.unwiredOutputs,
      gateCount: comp.nGates, inputCount: n, outputCount: circuit.outputs.length
    };
  }

  // ---------------------------------------------------------------- netlist
  function srcName(circuit, s) {
    if (!s) return '0';
    if (s.k === 'i') {
      var p = circuit.inputs.find(function (x) { return x.id === s.id; });
      return p ? p.name : '?';
    }
    var idx = circuit.gates.findIndex(function (g) { return g.id === s.id; });
    return idx >= 0 ? 'G' + idx : '?';
  }

  function exportNetlist(circuit, name) {
    var lines = [];
    lines.push('# TapeForge netlist — ' + (name || 'untitled circuit'));
    lines.push('# NAND-only. 1 gate = 1 transistor. TapeOut on X Layer (chain 196).');
    lines.push('# Inputs (' + circuit.inputs.length + '): ' + circuit.inputs.map(function (p) { return p.name; }).join(' '));
    lines.push('# Outputs (' + circuit.outputs.length + '): ' + circuit.outputs.map(function (o) { return o.name; }).join(' '));
    lines.push('# Gates: ' + circuit.gates.length);
    lines.push('INPUTS ' + circuit.inputs.map(function (p) { return p.name; }).join(' '));
    lines.push('OUTPUTS ' + circuit.outputs.map(function (o) { return o.name; }).join(' '));
    circuit.gates.forEach(function (g, i) {
      lines.push('G' + i + ' = NAND(' + srcName(circuit, g.a) + ', ' + srcName(circuit, g.b) + ')');
    });
    circuit.outputs.forEach(function (o) {
      lines.push(o.name + ' = ' + srcName(circuit, o.src));
    });
    lines.push('#');
    lines.push('# To tape this out (needs a wallet + OKB):');
    lines.push('# 1. Pick a processor on X Layer (see the Cost panel) and mint ' + circuit.gates.length + ' of its transistors (1 per NAND gate).');
    lines.push('# 2. Burn the transistors to etch this netlist as a circuit (ERC-721) — the tape-out fee is ~0.0013 OKB.');
    lines.push('# 3. Anyone can then call the circuit read-only, free, and check its outputs.');
    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------- cost
  var TAPEOUT_FEE_OKB = 0.0013;      // flat tape-out fee, per the TapeOut docs
  var PROCESSOR_OPEN_FEE_OKB = 0.0066; // flat fee to open your own processor
  function costEstimate(gateCount, priceOkb) {
    var transistorCost = gateCount * priceOkb;
    return {
      transistors: gateCount,
      transistorCost: transistorCost,
      tapeoutFee: TAPEOUT_FEE_OKB,
      total: transistorCost + TAPEOUT_FEE_OKB,
      processorOpenFee: PROCESSOR_OPEN_FEE_OKB
    };
  }
  function formatOkb(v) {
    if (v === 0) return '0';
    if (v >= 0.01) return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (v >= 0.000001) return v.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
    return v.toExponential(2);
  }

  return {
    createBuilder: createBuilder,
    TEMPLATES: TEMPLATES,
    compile: compile,
    simulate: simulate,
    verifyCircuit: verifyCircuit,
    exportNetlist: exportNetlist,
    costEstimate: costEstimate,
    formatOkb: formatOkb,
    TAPEOUT_FEE_OKB: TAPEOUT_FEE_OKB,
    PROCESSOR_OPEN_FEE_OKB: PROCESSOR_OPEN_FEE_OKB
  };
});

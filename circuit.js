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
  // [nInputs+nGates] constant 0 (an intentionally open gate input reads as 0
  // in the LIVE preview only — open ports BLOCK verify/export, see below).
  //
  // Strict validation (audit §1): every source reference is checked against
  // a Map of known IDs. A reference to an unknown ID or with a bad kind is a
  // HARD ERROR (it is never silently resolved to 0). A null reference is an
  // intentionally open editor port: it is allowed in the live preview but is
  // recorded per-port in unconnectedPorts / unwiredOutputs and blocks
  // encode/verify/export. Duplicate IDs (across inputs, gates and outputs)
  // are a hard error. ID tables use Map, never plain-object `in` lookups.
  function compile(circuit) {
    var nIn = circuit.inputs.length, nG = circuit.gates.length;
    var gateIdx = new Map(), inIdx = new Map(), outIdx = new Map();
    var duplicateIds = [], seenIds = new Map();
    function noteId(kind, id) {
      if (seenIds.has(id)) duplicateIds.push(id);
      else seenIds.set(id, kind);
    }
    circuit.inputs.forEach(function (p, i) { noteId('input', p.id); inIdx.set(p.id, i); });
    circuit.gates.forEach(function (g, i) { noteId('gate', g.id); gateIdx.set(g.id, i); });
    circuit.outputs.forEach(function (o, i) { noteId('output', o.id); outIdx.set(o.id, i); });
    if (duplicateIds.length > 0) {
      return { error: 'duplicate id(s): ' + duplicateIds.join(', ') + ' — every input, gate and output id must be unique' };
    }
    // Validate every reference. A broken reference is a hard error.
    var brokenRefs = [];
    function checkRef(ref, where) {
      if (ref === null || ref === undefined) return; // open port — recorded below, not broken
      if (typeof ref !== 'object' || (ref.k !== 'i' && ref.k !== 'g') || typeof ref.id !== 'string') {
        brokenRefs.push(where + ': malformed reference ' + JSON.stringify(ref));
        return;
      }
      if (ref.k === 'i' && !inIdx.has(ref.id)) brokenRefs.push(where + ': unknown input id "' + ref.id + '"');
      if (ref.k === 'g' && !gateIdx.has(ref.id)) brokenRefs.push(where + ': unknown gate id "' + ref.id + '"');
    }
    circuit.gates.forEach(function (g) {
      checkRef(g.a, 'gate ' + g.id + ' input a');
      checkRef(g.b, 'gate ' + g.id + ' input b');
    });
    circuit.outputs.forEach(function (o) { checkRef(o.src, 'output ' + o.id + ' (' + o.name + ')'); });
    if (brokenRefs.length > 0) {
      return { error: 'broken reference(s): ' + brokenRefs.join('; ') };
    }
    var CONST0 = nIn + nG;
    function srcSlot(s) {
      if (!s) return CONST0; // open port — reads as 0 in the live preview only
      if (s.k === 'i') return inIdx.get(s.id);
      return nIn + gateIdx.get(s.id);
    }
    // Kahn topological sort (detects combinational loops).
    var indeg = new Array(nG).fill(0), adj = [];
    for (var i = 0; i < nG; i++) adj.push([]);
    for (var k = 0; k < nG; k++) {
      var deps = [];
      [circuit.gates[k].a, circuit.gates[k].b].forEach(function (s) {
        if (s && s.k === 'g') deps.push(gateIdx.get(s.id));
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
    if (order.length !== nG) {
      var unevaluated = [];
      var inOrder = {};
      order.forEach(function (gi) { inOrder[gi] = true; });
      for (var e = 0; e < nG; e++) if (!inOrder[e]) unevaluated.push(circuit.gates[e].id);
      return { error: 'combinational loop: ' + unevaluated.length + ' gate(s) could not be evaluated (' + unevaluated.join(', ') + ') — NAND circuits here must be acyclic', unevaluated: unevaluated };
    }
    var aSrc = [], bSrc = [];
    for (var j = 0; j < nG; j++) {
      aSrc.push(srcSlot(circuit.gates[j].a));
      bSrc.push(srcSlot(circuit.gates[j].b));
    }
    var outSrc = circuit.outputs.map(function (o) { return srcSlot(o.src); });
    // Count missing ports INDIVIDUALLY (audit §1 Low): a NAND with both
    // inputs open is 2 unconnected inputs, not 1.
    var unconnectedPorts = [];
    circuit.gates.forEach(function (g) {
      if (!g.a) unconnectedPorts.push({ gateId: g.id, which: 'a' });
      if (!g.b) unconnectedPorts.push({ gateId: g.id, which: 'b' });
    });
    var unwiredOutputs = circuit.outputs.filter(function (o) { return !o.src; }).map(function (o) { return o.id; });
    return {
      error: null, nInputs: nIn, nGates: nG, order: order, aSrc: aSrc, bSrc: bSrc,
      outSrc: outSrc, unconnectedPorts: unconnectedPorts, unwiredOutputs: unwiredOutputs,
      unevaluated: [], const0: CONST0,
      // Back-compat counts (kept so callers can read a plain number).
      unconnected: unconnectedPorts.length
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

  // Live preview simulation. Open ports read as 0 (with a warning); broken
  // references and loops are hard errors. The returned `warnings` carry the
  // full compile result so the UI can list the exact open ports.
  function simulate(circuit, inputBits) {
    var comp = compile(circuit);
    if (comp.error) return { error: comp.error };
    var values = new Array(comp.nInputs + comp.nGates + 1).fill(0);
    var outputs = evalCompiled(comp, inputBits, values);
    var gateValues = {};
    circuit.gates.forEach(function (g, i) { gateValues[g.id] = values[comp.nInputs + i]; });
    return { outputs: outputs, gateValues: gateValues, warnings: comp };
  }

  // ------------------------------------------------------- TapeOut payload
  // The governing fix (audit verdict): the DECODED TapeOut payload is the
  // circuit that Verify checks, Export delivers, and Cost counts.
  //
  // PAYLOAD FORMAT — "TapeForge TapeOut payload v1" (documented, self-contained):
  //   bytes 0..3  : magic "TPO1" (0x54 0x50 0x4F 0x31)
  //   bytes 4..5  : nIn    (uint16, little-endian)
  //   bytes 6..7  : nOut   (uint16, little-endian)
  //   bytes 8..11 : nGates (uint32, little-endian)
  //   bytes 12..  : nGates records, each 4 bytes: a (uint16 LE), b (uint16 LE)
  // Signal numbering: 0..nIn-1 are the circuit inputs. Gate i (0-based, in
  // encoded order) produces signal nIn+i. Each gate's a and b must be
  // < nIn+i (a BACKWARD reference — a gate may only read signals produced
  // before it). The outputs are the LAST nOut produced signals
  // (nIn+nGates-nOut .. nIn+nGates-1), in the order the outputs were declared.
  //
  // Encoding: gates are emitted in topological order, except the output
  // source gates are placed in the final nOut positions (in output order)
  // where that is topologically possible. Where it is not — the source also
  // feeds a non-output gate, or it depends on an output declared after it,
  // or the output is sourced from an input pin — a 2-NAND identity buffer
  // (NOT(NOT(x))) is appended instead, so the output value lands in the
  // correct final signal position. The encoder never reorders the six
  // templates' gates. Five of the six place directly with ZERO buffers; the
  // comparator needs 4 buffer NANDs (its GT and EQ sources also feed the
  // NOT gates inside the LT output's OR, so they cannot sit in the final
  // positions) — 129 editor gates encode to 133. The tests pin this.
  var PAYLOAD_MAGIC = 'TPO1';
  var PAYLOAD_HEADER_BYTES = 12;

  function encodePayload(circuit) {
    var comp = compile(circuit);
    if (comp.error) return { error: comp.error };
    if (comp.unconnectedPorts.length > 0) {
      var ups = comp.unconnectedPorts.map(function (p) { return 'gate ' + p.gateId + ' input ' + p.which; }).join(', ');
      return { error: 'structural error: unconnected gate input(s): ' + ups + ' — wire every gate input before verifying or exporting' };
    }
    if (comp.unwiredOutputs.length > 0) {
      return { error: 'structural error: unwired output(s): ' + comp.unwiredOutputs.join(', ') + ' — wire every output before verifying or exporting' };
    }
    var nIn = circuit.inputs.length, nG = circuit.gates.length, nOut = circuit.outputs.length;
    if (nOut === 0) return { error: 'structural error: the circuit has no outputs — add an output pin before verifying or exporting' };
    if (nIn + nG + 2 * nOut > 65535) return { error: 'circuit too large for the payload format (signal index would exceed 65535)' };

    // Dependency graph over gate indices.
    var gateIdx = new Map();
    circuit.gates.forEach(function (g, i) { gateIdx.set(g.id, i); });
    var deps = [], dependents = [];
    for (var i = 0; i < nG; i++) { deps.push([]); dependents.push([]); }
    circuit.gates.forEach(function (g, gi) {
      [g.a, g.b].forEach(function (s) {
        if (s && s.k === 'g') {
          var d = gateIdx.get(s.id);
          deps[gi].push(d);
          dependents[d].push(gi);
        }
      });
    });
    // Output source gates, in output declaration order (-1 = sourced from an
    // input pin, which always needs a buffer).
    var outGate = circuit.outputs.map(function (o) {
      if (!o.src || o.src.k !== 'g') return -1;
      return gateIdx.get(o.src.id);
    });
    // Which output source gates can be placed directly in the final nOut
    // positions? Fixpoint: a source gate is direct only if (a) no non-output
    // gate depends on it, and (b) it does not depend on an output source
    // declared after it. Anything else is emitted in its normal topological
    // position and its output is copied by a 2-NAND buffer at the end.
    var direct = new Map(); // gate index -> output index, for directly placed sources
    outGate.forEach(function (gi, oj) { if (gi >= 0) direct.set(gi, oj); });
    var changed = true;
    while (changed) {
      changed = false;
      var toRemove = [];
      direct.forEach(function (oj, gi) {
        var ok = true;
        dependents[gi].forEach(function (dep) {
          if (!direct.has(dep)) ok = false; // a normal gate depends on it
          else if (direct.get(dep) < oj) ok = false; // an earlier output depends on it
        });
        deps[gi].forEach(function (d) {
          if (direct.has(d) && direct.get(d) > oj) ok = false; // depends on a later output
        });
        if (!ok) toRemove.push(gi);
      });
      toRemove.forEach(function (gi) { direct.delete(gi); changed = true; });
    }
    // Emit in three phases so the outputs are EXACTLY the last nOut signals:
    //   (1) all non-direct gates, in topological order;
    //   (2) the buf1 (NOT) half of every output buffer — these are ordinary
    //       intermediate signals and must NOT sit in the final positions;
    //   (3) the final nOut signals, in output order: a direct source gate,
    //       or the buf2 (NOT(NOT(x)) = x) half of a buffer.
    // A buf1 only reads a source that is already emitted (a normal gate or an
    // input pin), so phase (2) never creates a forward reference.
    var encoded = []; // {a, b} with a,b = signal indices (resolved below)
    var sigOfGate = new Map(); // gate index -> signal index, once emitted
    function inSig(s) {
      if (s.k === 'i') {
        var idx = -1;
        circuit.inputs.forEach(function (p, i) { if (p.id === s.id) idx = i; });
        return idx;
      }
      return nIn + sigOfGate.get(gateIdx.get(s.id));
    }
    comp.order.forEach(function (gi) {
      if (direct.has(gi)) return; // emitted later, in the final positions
      var g = circuit.gates[gi];
      var a = inSig(g.a), b = inSig(g.b);
      sigOfGate.set(gi, encoded.length);
      encoded.push({ a: a, b: b, src: gi });
    });
    var buffers = 0, bufferOutputs = [];
    var buf1Sig = {}; // output index -> signal index of its buf1 gate
    circuit.outputs.forEach(function (o, oj) {
      var gi = outGate[oj];
      if (gi >= 0 && direct.has(gi)) return; // no buffer for this output
      var srcSig = (gi >= 0) ? (nIn + sigOfGate.get(gi)) : inSig(o.src);
      buf1Sig[oj] = nIn + encoded.length;
      encoded.push({ a: srcSig, b: srcSig, src: null });
      buffers += 2;
      bufferOutputs.push(o.name);
    });
    circuit.outputs.forEach(function (o, oj) {
      var gi = outGate[oj];
      if (gi >= 0 && direct.has(gi)) {
        var g = circuit.gates[gi];
        sigOfGate.set(gi, encoded.length);
        encoded.push({ a: inSig(g.a), b: inSig(g.b), src: gi });
      } else {
        encoded.push({ a: buf1Sig[oj], b: buf1Sig[oj], src: null });
      }
    });
    // Validate backward references (safety net — must hold by construction).
    for (var e = 0; e < encoded.length; e++) {
      if (encoded[e].a >= nIn + e || encoded[e].b >= nIn + e) {
        return { error: 'internal error: encoded gate ' + e + ' has a forward reference (a=' + encoded[e].a + ', b=' + encoded[e].b + ')' };
      }
      if (encoded[e].a < 0 || encoded[e].b < 0) {
        return { error: 'internal error: encoded gate ' + e + ' has an unresolved input' };
      }
    }
    var nGates = encoded.length;
    var bytes = new Uint8Array(PAYLOAD_HEADER_BYTES + 4 * nGates);
    bytes[0] = 0x54; bytes[1] = 0x50; bytes[2] = 0x4F; bytes[3] = 0x31; // "TPO1"
    bytes[4] = nIn & 0xff; bytes[5] = (nIn >> 8) & 0xff;
    bytes[6] = nOut & 0xff; bytes[7] = (nOut >> 8) & 0xff;
    bytes[8] = nGates & 0xff; bytes[9] = (nGates >> 8) & 0xff;
    bytes[10] = (nGates >> 16) & 0xff; bytes[11] = (nGates >> 24) & 0xff;
    for (var r = 0; r < nGates; r++) {
      var off = PAYLOAD_HEADER_BYTES + 4 * r;
      bytes[off] = encoded[r].a & 0xff; bytes[off + 1] = (encoded[r].a >> 8) & 0xff;
      bytes[off + 2] = encoded[r].b & 0xff; bytes[off + 3] = (encoded[r].b >> 8) & 0xff;
    }
    var hex = '';
    for (var h = 0; h < bytes.length; h++) hex += ('0' + bytes[h].toString(16)).slice(-2);
    return {
      error: null, bytes: bytes, hex: hex, nIn: nIn, nOut: nOut,
      nGates: nGates, buffers: buffers, bufferOutputs: bufferOutputs,
      editorGateCount: nG, encodedGateCount: nGates
    };
  }

  // Decode and strictly validate a payload. Returns { error } on any
  // malformed input (bad magic, wrong length, forward reference, bad counts).
  function decodePayload(bytes) {
    if (!bytes || bytes.length < PAYLOAD_HEADER_BYTES) return { error: 'payload too short (' + (bytes ? bytes.length : 0) + ' bytes)' };
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] !== 0x54 || b[1] !== 0x50 || b[2] !== 0x4F || b[3] !== 0x31) return { error: 'bad payload magic (expected TPO1)' };
    var nIn = b[4] | (b[5] << 8);
    var nOut = b[6] | (b[7] << 8);
    var nGates = (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0;
    if (nOut === 0) return { error: 'payload declares zero outputs' };
    if (nOut > nGates) return { error: 'payload declares more outputs (' + nOut + ') than gates (' + nGates + ')' };
    if (b.length !== PAYLOAD_HEADER_BYTES + 4 * nGates) return { error: 'payload length ' + b.length + ' does not match the declared ' + nGates + ' gates' };
    var gates = [];
    for (var i = 0; i < nGates; i++) {
      var off = PAYLOAD_HEADER_BYTES + 4 * i;
      var a = b[off] | (b[off + 1] << 8);
      var bb = b[off + 2] | (b[off + 3] << 8);
      if (a >= nIn + i || bb >= nIn + i) return { error: 'gate ' + i + ' has a forward reference (a=' + a + ', b=' + bb + ', max ' + (nIn + i - 1) + ')' };
      gates.push({ a: a, b: bb });
    }
    return { error: null, nIn: nIn, nOut: nOut, nGates: nGates, gates: gates };
  }

  // Simulate a DECODED payload. Outputs are the last nOut produced signals.
  function simulateDecoded(decoded, inputBits) {
    var n = decoded.nIn;
    var values = new Array(n + decoded.nGates).fill(0);
    for (var i = 0; i < n; i++) values[i] = inputBits[i] ? 1 : 0;
    for (var k = 0; k < decoded.nGates; k++) {
      var g = decoded.gates[k];
      values[n + k] = (values[g.a] & values[g.b]) ? 0 : 1;
    }
    var out = [];
    for (var j = 0; j < decoded.nOut; j++) out.push(values[n + decoded.nGates - decoded.nOut + j]);
    return out;
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

  // Verify the circuit by simulating the DECODED payload bytes — the exact
  // bytes Export delivers and Cost counts. Encode -> decode -> simulate ->
  // compare to the expected function. A compile error, a structural error
  // (open ports, unwired outputs) or an empty circuit NEVER produces a pass
  // count: it returns { error, total: 0, passed: 0, failed: 0 } with the
  // error set, so no test can mistake it for a pass (audit §2 Low).
  // expectedFn: bits[] -> expected output bits[]; null = simulate only, in
  // which case the result has hasExpected false and passed/failed null — the
  // UI must show "simulated, no expected function" WITHOUT a pass count.
  function verifyCircuit(circuit, expectedFn) {
    var enc = encodePayload(circuit);
    if (enc.error) {
      return { error: enc.error, hasExpected: !!expectedFn, total: 0, passed: 0, failed: 0, failures: [], sampled: false, gateCount: 0, buffers: 0, nIn: circuit.inputs.length, nOut: circuit.outputs.length, inputCount: circuit.inputs.length, outputCount: circuit.outputs.length };
    }
    var dec = decodePayload(enc.bytes);
    if (dec.error) {
      return { error: 'internal error: the encoded payload failed to decode (' + dec.error + ')', hasExpected: !!expectedFn, total: 0, passed: 0, failed: 0, failures: [], sampled: false, gateCount: 0, buffers: 0, nIn: enc.nIn, nOut: enc.nOut, inputCount: circuit.inputs.length, outputCount: circuit.outputs.length };
    }
    var n = enc.nIn;
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
      var got = simulateDecoded(dec, bits);
      if (!expectedFn) continue; // simulated only — no pass count
      var exp = expectedFn(bits);
      var ok = got.length === exp.length;
      if (ok) for (var o = 0; o < got.length; o++) if (got[o] !== exp[o]) { ok = false; break; }
      if (ok) passed++;
      else if (failures.length < 20) failures.push({ bits: bits.slice(), got: got.slice(), expected: exp.slice() });
    }
    return {
      error: null, hasExpected: !!expectedFn,
      total: cases.length,
      passed: expectedFn ? passed : null,
      failed: expectedFn ? (cases.length - passed) : null,
      failures: failures, sampled: sampled,
      gateCount: enc.nGates, buffers: enc.buffers, bufferOutputs: enc.bufferOutputs,
      nIn: enc.nIn, nOut: enc.nOut,
      inputCount: n, outputCount: circuit.outputs.length
    };
  }

  // ---------------------------------------------------------------- netlist
  // The tape-out deliverable is the PROTOCOL BYTES. This function runs the
  // shared structural + protocol validation (encode -> decode -> re-simulate
  // one case as a self-check) and returns the bytes, or an error naming the
  // exact port/gate that blocks export. A disconnected output, a dangling
  // reference, a self-referencing NAND and a combinational loop all block.
  function exportTapeout(circuit) {
    var enc = encodePayload(circuit);
    if (enc.error) return { error: enc.error };
    var dec = decodePayload(enc.bytes);
    if (dec.error) return { error: 'internal error: the encoded payload failed to decode (' + dec.error + ')' };
    // Self-check: the decoded payload must simulate (one case is enough to
    // prove the decode path works; full verification is verifyCircuit's job).
    var probe = simulateDecoded(dec, new Array(enc.nIn).fill(0));
    if (probe.length !== enc.nOut) return { error: 'internal error: decoded payload produced ' + probe.length + ' outputs, expected ' + enc.nOut };
    return {
      error: null, bytes: enc.bytes, hex: enc.hex,
      nIn: enc.nIn, nOut: enc.nOut, nGates: enc.nGates,
      buffers: enc.buffers, bufferOutputs: enc.bufferOutputs,
      editorGateCount: enc.editorGateCount
    };
  }

  // Human-readable draft preview ONLY. It is labelled DRAFT in the header and
  // must never be presented as submittable: TapeOut consumes the protocol
  // bytes, not this text. It serializes STABLE signal IDs (in0, g0, out0)
  // and keeps display names as comments, so a pin renamed to "G0" can never
  // collide with a gate (audit §4 High).
  function exportNetlistDraft(circuit, name) {
    var comp = compile(circuit);
    var lines = [];
    lines.push('# TapeForge netlist DRAFT — ' + (name || 'untitled circuit'));
    lines.push('# DRAFT ONLY — NOT SUBMITTABLE. TapeOut consumes the protocol bytes (see Export), not this text.');
    lines.push('# Stable signal IDs are used below (in0, g0, out0); display names are comments only.');
    lines.push('# Inputs (' + circuit.inputs.length + '): ' + circuit.inputs.map(function (p) { return p.id + ' "' + p.name + '"'; }).join(' '));
    lines.push('# Outputs (' + circuit.outputs.length + '): ' + circuit.outputs.map(function (o) { return o.id + ' "' + o.name + '"'; }).join(' '));
    if (comp.error) lines.push('# COMPILE ERROR: ' + comp.error);
    else {
      lines.push('# Gates: ' + circuit.gates.length + ' (topological order)');
      if (comp.unconnectedPorts.length) lines.push('# WARNING: ' + comp.unconnectedPorts.length + ' unconnected gate input(s): ' + comp.unconnectedPorts.map(function (p) { return p.gateId + '.' + p.which; }).join(', '));
      if (comp.unwiredOutputs.length) lines.push('# WARNING: unwired output(s): ' + comp.unwiredOutputs.join(', '));
    }
    lines.push('INPUTS ' + circuit.inputs.map(function (p) { return p.id; }).join(' '));
    lines.push('OUTPUTS ' + circuit.outputs.map(function (o) { return o.id; }).join(' '));
    function refName(s) {
      if (!s) return '0';
      if (s.k === 'i') return s.id;
      return s.id;
    }
    comp.order.forEach(function (gi) {
      var g = circuit.gates[gi];
      lines.push(g.id + ' = NAND(' + refName(g.a) + ', ' + refName(g.b) + ')');
    });
    circuit.outputs.forEach(function (o) {
      lines.push(o.id + ' = ' + refName(o.src) + '   # "' + o.name + '"');
    });
    lines.push('#');
    lines.push('# To tape this out, use the protocol bytes (Download .bin / Copy hex) —');
    lines.push('# the bytes encode the gates above in topological order with the outputs');
    lines.push('# in the final signal positions. A wallet + OKB are needed to mint and etch.');
    return lines.join('\n') + '\n';
  }
  // Back-compat name: the old exportNetlist returned the named-equation text.
  // It now returns the DRAFT (same text, new header). Callers that need the
  // tape-out deliverable must use exportTapeout.
  function exportNetlist(circuit, name) { return exportNetlistDraft(circuit, name); }

  // -------------------------------------------------------------------- cost
  // All money is integer wei (BigInt) end to end; decimals are formatted only
  // for display (audit §3 Medium — no parseInt on wei values, no float math).
  //   total = gates * mintPrice + protocolFee (once per mint call) + tapeoutFee
  //         (+ deployFee only if opening your own processor).
  // gateCount MUST be the number of gates in the final ENCODED circuit
  // (including output buffers), not the editor gate count.
  function costEstimate(encodedGateCount, fees) {
    var mintPrice = BigInt(fees.mintPriceWei);
    var protocolFee = BigInt(fees.protocolFeeWei);
    var tapeoutFee = BigInt(fees.tapeoutFeeWei);
    var deployFee = fees.deployFeeWei !== undefined && fees.deployFeeWei !== null ? BigInt(fees.deployFeeWei) : 0n;
    var transistorCost = BigInt(encodedGateCount) * mintPrice;
    var total = transistorCost + protocolFee + tapeoutFee + deployFee;
    return {
      gates: encodedGateCount,
      transistorCostWei: transistorCost, protocolFeeWei: protocolFee,
      tapeoutFeeWei: tapeoutFee, deployFeeWei: deployFee, totalWei: total
    };
  }
  // Format a wei BigInt as an OKB decimal string, integer arithmetic only.
  // e.g. 2028000000000000n -> "0.002028"; 10000000n -> "0.00000000001".
  function formatWei(wei) {
    var w = BigInt(wei);
    if (w === 0n) return '0';
    var neg = w < 0n;
    if (neg) w = -w;
    var s = w.toString();
    var out;
    if (s.length <= 18) out = '0.' + '0'.repeat(18 - s.length) + s;
    else out = s.slice(0, s.length - 18) + '.' + s.slice(s.length - 18);
    out = out.replace(/0+$/, '').replace(/\.$/, '');
    return (neg ? '-' : '') + out;
  }
  // Back-compat: the old formatOkb took a float OKB value. It now takes a
  // wei BigInt (or a decimal string/number of wei) and formats it. Callers
  // passing a float OKB value will get a wrong result — all callers were
  // updated to pass wei.
  function formatOkb(wei) { return formatWei(wei); }

  return {
    createBuilder: createBuilder,
    TEMPLATES: TEMPLATES,
    compile: compile,
    simulate: simulate,
    verifyCircuit: verifyCircuit,
    encodePayload: encodePayload,
    decodePayload: decodePayload,
    simulateDecoded: simulateDecoded,
    exportTapeout: exportTapeout,
    exportNetlistDraft: exportNetlistDraft,
    exportNetlist: exportNetlist,
    costEstimate: costEstimate,
    formatWei: formatWei,
    formatOkb: formatOkb,
    PAYLOAD_MAGIC: PAYLOAD_MAGIC,
    PAYLOAD_HEADER_BYTES: PAYLOAD_HEADER_BYTES
  };
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/microphone-worklet.js'), 'utf8');
for (const rate of [16000, 44100, 48000]) {
  test(`microphone worklet preserves continuous PCM timing and 40-ms packets at ${rate} Hz`, () => {
    let Processor; const packets = [];
    vm.runInNewContext(source, { sampleRate: rate, Float32Array,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: packet => packets.push(packet) }; } },
      registerProcessor: (name, processor) => { assert.equal(name, 'giggy-microphone'); Processor = processor; },
    });
    const processor = new Processor();
    for (let offset = 0; offset < rate; offset += 128) {
      assert.equal(processor.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.25)]]), true);
    }
    assert.equal(packets.length, 25);
    assert.ok(packets.every(packet => packet.length === 640 && packet.every(sample => sample === 0.25)));
  });
}

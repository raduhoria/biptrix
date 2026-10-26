// AudioWorklet: RNNoise noise suppression on the microphone, before it is
// sent. RNNoise works on 480-sample frames at 48 kHz (10 ms); the audio
// graph delivers 128-sample blocks, so input is buffered into frames and
// the output runs one frame behind (≈10 ms of added latency). Until the
// WebAssembly is ready the sound passes through unchanged.
//
// Firefox cannot connect a microphone to a context of another sample rate,
// so there the context runs at the microphone's rate (processorOptions.rate)
// and the samples are resampled to 48 kHz for RNNoise and back (linear
// interpolation: speech sits far below either Nyquist frequency).
import createRNNWasmModule from '/vendor/rnnoise/rnnoise.js';

const FRAME = 480;
const SCALE = 32768; // RNNoise expects 16-bit sample values

// Streaming linear resampler, no allocation per block: run() writes into
// `out` from `at` and returns how many samples it wrote.
class Resampler {
  constructor(from, to) {
    this.step = from / to;
    this.pos = 0; // next output sample, in input samples; -1 = the previous block's last
    this.prev = 0;
  }

  run(input, n, out, at) {
    let pos = this.pos;
    let k = at;
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i < 0 ? this.prev : input[i];
      out[k++] = a + (input[i + 1] - a) * f;
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = input[n - 1];
    return k - at;
  }
}

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = options.processorOptions.rate || 48000;
    this.resample = rate !== 48000 ? { in: new Resampler(rate, 48000), out: new Resampler(48000, rate), frame: new Float32Array(FRAME) } : null;
    this.inQ = new Float32Array(FRAME * 2);
    this.inLen = 0;
    this.outQ = new Float32Array(FRAME * 4);
    this.outLen = FRAME; // one frame of silence ahead, so output never runs dry
    this.alive = true;
    createRNNWasmModule({ wasmBinary: options.processorOptions.wasm }).then((m) => {
      if (!this.alive) return;
      this.m = m;
      this.state = m._rnnoise_create();
      this.ptr = m._malloc(FRAME * 4);
    });
    this.port.onmessage = (e) => {
      if (e.data !== 'destroy' || !this.alive) return;
      this.alive = false;
      if (this.m) {
        this.m._rnnoise_destroy(this.state);
        this.m._free(this.ptr);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return this.alive;
    if (!input) {
      output.fill(0);
      return this.alive;
    }
    if (!this.m || !this.alive) {
      output.set(input);
      return this.alive;
    }
    if (this.resample) this.inLen += this.resample.in.run(input, input.length, this.inQ, this.inLen);
    else {
      this.inQ.set(input, this.inLen);
      this.inLen += input.length;
    }
    while (this.inLen >= FRAME) {
      const heap = this.m.HEAPF32;
      const at = this.ptr >> 2;
      for (let i = 0; i < FRAME; i++) heap[at + i] = this.inQ[i] * SCALE;
      this.m._rnnoise_process_frame(this.state, this.ptr, this.ptr);
      if (this.resample) {
        const frame = this.resample.frame;
        for (let i = 0; i < FRAME; i++) frame[i] = heap[at + i] / SCALE;
        this.outLen += this.resample.out.run(frame, FRAME, this.outQ, this.outLen);
      } else {
        for (let i = 0; i < FRAME; i++) this.outQ[this.outLen + i] = heap[at + i] / SCALE;
        this.outLen += FRAME;
      }
      this.inQ.copyWithin(0, FRAME, this.inLen);
      this.inLen -= FRAME;
    }
    const n = output.length;
    output.set(this.outQ.subarray(0, n));
    this.outQ.copyWithin(0, n, this.outLen);
    this.outLen -= n;
    return this.alive;
  }
}

registerProcessor('rnnoise', RnnoiseProcessor);

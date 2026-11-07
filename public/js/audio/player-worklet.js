// AudioWorkletProcessor: mixes in the audio thread (secure contexts only).
import { TrackerCore } from './tracker-core.js';

class TrackerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new TrackerCore(sampleRate, (m) => this.port.postMessage(m));
    this.port.onmessage = (e) => this.core.onMessage(e.data);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    this.core.process(out[0], out[1] || out[0]);
    return true;
  }
}

registerProcessor('tracker-processor', TrackerProcessor);

// Main-thread wrapper around the replayer (AudioWorklet, or ScriptProcessor fallback).

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.ready = null;
    this.pending = [];
    this.playing = false;
    this.volume = 0.8;
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  async start() {
    if (!this.ready) {
      this.ready = this.init().catch((e) => {
        this.ready = null; // allow a retry on the next gesture
        throw e;
      });
    }
    await this.ready;
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async init() {
    this.ctx ||= new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.audioWorklet && window.isSecureContext) {
      // Mixing in the audio thread (https or localhost).
      await this.ctx.audioWorklet.addModule(new URL('./player-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'tracker-processor', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.port.onmessage = (e) => this.onMessage(e.data);
      this.send = (m, t) => this.node.port.postMessage(m, t);
      this.mode = 'worklet';
    } else {
      // Plain http on an IP address is not a secure context, so AudioWorklet is
      // unavailable. Run the same replayer on the main thread instead.
      const { TrackerCore } = await import('./tracker-core.js');
      const core = new TrackerCore(this.ctx.sampleRate, (m) => this.onMessage(m));
      this.node = this.ctx.createScriptProcessor(2048, 0, 2);
      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer;
        core.process(out.getChannelData(0), out.getChannelData(1));
      };
      // Clone like postMessage would, so the editor and the player never share mutable state.
      this.send = (m) => core.onMessage(structuredClone(m));
      this.mode = 'scriptprocessor';
      console.info('DiscoTracker: AudioWorklet unavailable (not a secure context) – using ScriptProcessor fallback.');
    }
    this.node.connect(this.ctx.destination);
    for (const [m, t] of this.pending) this.send(m, t);
    this.pending = [];
    this.post({ type: 'volume', value: this.volume });
  }

  onMessage(m) {
    // `playing` is owned by the main thread (play/stop) to avoid races with
    // late messages from the audio thread.
    if (m.type === 'row' && !this.playing) return;
    this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
  }

  post(msg, transfer = []) {
    if (this.send) this.send(msg, transfer);
    else {
      // Keep only the latest full song load while not started yet.
      if (msg.type === 'song') this.pending = this.pending.filter(([m]) => !['song', 'cell', 'pattern', 'patterns', 'orders', 'instrument', 'instruments', 'params'].includes(m.type));
      if (!['jam', 'jamOff', 'play', 'stop'].includes(msg.type)) this.pending.push([msg, transfer]);
    }
  }

  loadSong(song) { this.post({ type: 'song', song }); }
  play(mode, order, row = 0, pattern = null) { this.playing = true; this.post({ type: 'play', mode, order, row, pattern }); }
  stop() { this.playing = false; this.post({ type: 'stop' }); this.dispatchEvent(new CustomEvent('stopped')); }
  setCell(pattern, row, ch, cell) { this.post({ type: 'cell', pattern, row, ch, cell }); }
  setPattern(index, pattern) { this.post({ type: 'pattern', index, pattern }); }
  setPatterns(patterns) { this.post({ type: 'patterns', patterns }); }
  setOrders(orders, restart) { this.post({ type: 'orders', orders, restart }); }
  setInstrument(index, instrument) { this.post({ type: 'instrument', index, instrument }); }
  setInstruments(instruments) { this.post({ type: 'instruments', instruments }); }
  setParams(p) { this.post({ type: 'params', ...p }); }
  jam(ch, note, inst, volume = null) { this.post({ type: 'jam', ch, note, inst, volume }); }
  jamOff(ch) { this.post({ type: 'jamOff', ch }); }
  mute(ch, muted) { this.post({ type: 'mute', ch, muted }); }
  setVolume(v) { this.volume = v; this.post({ type: 'volume', value: v }); }
}

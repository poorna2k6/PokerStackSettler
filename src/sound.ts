// Tiny synthesized "chip clink" — no audio assets, off unless the user enables it.
let ctx: AudioContext | undefined;
let enabled = false;

export const setSoundEnabled = (on: boolean) => { enabled = on; };

export function clink() {
  if (!enabled) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx ??= new Ctor();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1900, t);
    osc.frequency.exponentialRampToValueAtTime(950, t + 0.08);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  } catch { /* audio unavailable */ }
}

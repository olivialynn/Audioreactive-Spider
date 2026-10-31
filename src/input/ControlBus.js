/**
 * ControlBus — the normalized signal contract between *input* and *the creature*.
 *
 * This is the seam that makes "add MIDI later" nearly free. Every input source
 * (the mic now, a MIDI device later) writes into one of these, and the creature
 * only ever reads from it. Nothing downstream knows or cares where the numbers
 * came from.
 *
 * All continuous values are normalized to roughly 0..1.
 */
export class ControlBus {
  constructor() {
    // Continuous energy per frequency band (0..1, smoothed).
    this.bands = { bass: 0, mid: 0, treble: 0 };

    // Overall loudness (0..1).
    this.level = 0;

    // Discrete beat onset: true for the single frame a beat is detected.
    this.beat = false;
    this.beatEnergy = 0; // strength of the most recent beat

    // Seconds since the audio source started.
    this.time = 0;
  }
}

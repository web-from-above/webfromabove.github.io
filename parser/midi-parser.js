/**
 * midi_parser.js
 * Standard MIDI File (.mid) Parser  —  Format 0, 1, and 2
 *
 * Usage:
 *   import { parseMIDI, MIDIPlayer } from './midi_parser.js';
 *
 *   // 1. Parse a .mid ArrayBuffer into a structured object
 *   const midi = parseMIDI(arrayBuffer);
 *
 *   // 2. midi.tracks[n].events  — array of timestamped events (see MIDIEvent below)
 *   //    midi.timeDivision      — ticks per quarter note (or SMPTE)
 *   //    midi.format            — 0 | 1 | 2
 *
 *   // 3. Or use MIDIPlayer for real-time scheduling onto Web Audio
 *   const player = new MIDIPlayer(midi, audioContext, {
 *     onNoteOn:  (ch, note, vel, timeSeconds) => { ... },
 *     onNoteOff: (ch, note, vel, timeSeconds) => { ... },
 *     onTempo:   (bpm)                        => { ... },
 *     onCC:      (ch, cc, val, timeSeconds)   => { ... },
 *   });
 *   player.start();
 *   player.pause();
 *   player.resume();
 *   player.stop();
 *   player.seek(timeInSeconds);
 */

// ─── Data reader ──────────────────────────────────────────────────────────────

class MidiReader {
  constructor(buffer) {
    this.buf = new Uint8Array(buffer);
    this.pos = 0;
  }

  eof()       { return this.pos >= this.buf.length; }
  readUint8() { return this.buf[this.pos++]; }

  readUint16() {
    const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
    this.pos += 2;
    return v;
  }

  readUint32() {
    const v = (this.buf[this.pos]     << 24) |
              (this.buf[this.pos + 1] << 16) |
              (this.buf[this.pos + 2] <<  8) |
               this.buf[this.pos + 3];
    this.pos += 4;
    return v >>> 0;   // ensure unsigned
  }

  readString(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.buf[this.pos++]);
    return s;
  }

  /** MIDI variable-length quantity */
  readVLQ() {
    let value = 0;
    let byte;
    do {
      byte   = this.readUint8();
      value  = (value << 7) | (byte & 0x7F);
    } while (byte & 0x80);
    return value;
  }

  readBytes(len) {
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  skip(n) { this.pos += n; }
  tell()  { return this.pos; }
  seek(n) { this.pos = n; }
}

// ─── Event types ─────────────────────────────────────────────────────────────

/**
 * All events share:
 *   tick          — absolute tick position in track
 *   timeSeconds   — absolute time in seconds (filled in after tempo merge)
 *   type          — string key (see below)
 *
 * Type-specific fields:
 *
 *  'noteOn'        channel, note, velocity
 *  'noteOff'       channel, note, velocity
 *  'controlChange' channel, controller, value
 *  'programChange' channel, program
 *  'pitchBend'     channel, value  (-8192..+8191)
 *  'aftertouch'    channel, note, pressure          (polyphonic)
 *  'channelPressure' channel, pressure              (mono)
 *  'sysex'         data (Uint8Array)
 *  'tempo'         microsecondsPerBeat, bpm
 *  'timeSignature' numerator, denominator, clocksPerClick, notated32nds
 *  'keySignature'  key (-7..+7), scale (0=major,1=minor)
 *  'text'          text
 *  'lyric'         text
 *  'marker'        text
 *  'endOfTrack'    (no extra fields)
 */

// ─── Track parser ─────────────────────────────────────────────────────────────

function parseTrack(r, trackEnd, light = false) {
  const events = [];
  let tick = 0;
  let runningStatus = 0;

  while (r.tell() < trackEnd) {
    const deltaTick = r.readVLQ();
    tick += deltaTick;

    let statusByte = r.buf[r.pos];

    // Running status: if high bit is NOT set, reuse last status
    if (statusByte & 0x80) {
      statusByte   = r.readUint8();
      runningStatus = statusByte;
    } else {
      statusByte = runningStatus;   // don't advance pos
    }

    const type    = (statusByte >> 4) & 0x0F;
    const channel = statusByte & 0x0F;

    if (statusByte === 0xFF) {
      // ── Meta event ──────────────────────────────────────────────────────────
      const metaType = r.readUint8();
      const metaLen  = r.readVLQ();
      const metaData = r.readBytes(metaLen);
      const ev = { tick, timeSeconds: 0 };

      switch (metaType) {
        case 0x01: ev.type = 'text';    ev.text   = bytesToString(metaData); break;
        case 0x02: ev.type = 'copyright'; ev.text = bytesToString(metaData); break;
        case 0x03: ev.type = 'trackName'; ev.text = bytesToString(metaData); break;
        case 0x04: ev.type = 'instrument'; ev.text= bytesToString(metaData); break;
        case 0x05: ev.type = 'lyric';   ev.text   = bytesToString(metaData); break;
        case 0x06: ev.type = 'marker';  ev.text   = bytesToString(metaData); break;
        case 0x07: ev.type = 'cuePoint';ev.text   = bytesToString(metaData); break;

        case 0x51: {  // Set Tempo
          const us = (metaData[0] << 16) | (metaData[1] << 8) | metaData[2];
          ev.type  = 'tempo';
          ev.microsecondsPerBeat = us;
          ev.bpm   = Math.round(60_000_000 / us * 10) / 10;
          break;
        }
        case 0x58: {  // Time Signature
          ev.type        = 'timeSignature';
          ev.numerator   = metaData[0];
          ev.denominator = Math.pow(2, metaData[1]);
          ev.clocksPerClick  = metaData[2];
          ev.notated32nds    = metaData[3];
          break;
        }
        case 0x59: {  // Key Signature
          ev.type  = 'keySignature';
          ev.key   = metaData[0] > 127 ? metaData[0] - 256 : metaData[0]; // signed
          ev.scale = metaData[1];  // 0=major, 1=minor
          break;
        }
        case 0x2F:
          ev.type = 'endOfTrack';
          events.push(ev);
          return events;   // done with track

        default:
          ev.type = `meta_${metaType.toString(16).padStart(2,'0')}`;
          ev.data = metaData;
      }
      // In light mode (black MIDI), drop most meta events to save memory
      if (!light || ev.type === 'tempo' || ev.type === 'timeSignature' ||
          ev.type === 'keySignature' || ev.type === 'endOfTrack' ||
          ev.type === 'trackName') {
        events.push(ev);
      }

    } else if (statusByte === 0xF0 || statusByte === 0xF7) {
      // ── SysEx ───────────────────────────────────────────────────────────────
      const len  = r.readVLQ();
      const data = r.readBytes(len);
      if (!light) {
        events.push({ tick, timeSeconds: 0, type: 'sysex', data });
      }
      runningStatus = 0;   // SysEx cancels running status

    } else {
      // ── Channel message ─────────────────────────────────────────────────────
      const ev = { tick, timeSeconds: 0, channel };

      switch (type) {
        case 0x8: {  // Note Off
          const note = Math.max(0, Math.min(127, r.readUint8()));
          const vel  = r.readUint8();
          ev.type = 'noteOff';
          ev.note = note;
          ev.velocity = Math.max(0, Math.min(127, vel));
          break;
        }
        case 0x9: {  // Note On  (velocity 0 = note off)
          const note = Math.max(0, Math.min(127, r.readUint8()));
          const vel  = r.readUint8();

          ev.type = vel === 0 ? 'noteOff' : 'noteOn';
          ev.note = note;

          const MIN_AUDIBLE_VELOCITY = 8;  // protect against ultra-low velocities (common in black MIDI)
          ev.velocity = vel === 0 ? 0 : Math.min(127, vel);
          break;
        }
        case 0xA: {  // Polyphonic Aftertouch
          ev.type = 'aftertouch'; ev.note = r.readUint8(); ev.pressure = r.readUint8();
          break;
        }
        case 0xB: {  // Control Change
          ev.type = 'controlChange'; ev.controller = r.readUint8(); ev.value = r.readUint8();
          break;
        }
        case 0xC: {  // Program Change
          ev.type = 'programChange'; ev.program = r.readUint8();
          break;
        }
        case 0xD: {  // Channel Pressure
          ev.type = 'channelPressure'; ev.pressure = r.readUint8();
          break;
        }
        case 0xE: {  // Pitch Bend
          const lo = r.readUint8();
          const hi = r.readUint8();
          ev.type = 'pitchBend'; ev.value = ((hi << 7) | lo) - 8192;
          break;
        }
        default:
          // Dangerous to skip single bytes in MIDI — can desync entire track.
          // For black MIDI robustness, stop parsing this track instead of corrupting downstream events.
          console.warn(`Unknown MIDI event type: ${type.toString(16)} at tick ${tick}`);
          return events;
      }
      events.push(ev);
    }
  }

  return events;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a MIDI ArrayBuffer.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {Object} [options]
 * @param {boolean} [options.light=false]  — Black MIDI / visualization mode.
 *        Drops most meta events (text, lyrics, markers, etc.) and all SysEx
 *        to drastically reduce memory usage and parse time on massive files
 *        (millions of events). Note, tempo, time signature, and all channel
 *        events (notes, CC including sustain 64, program, pitch bend, etc.)
 *        are always kept.
 *
 * Returns:
 * {
 *   format,
 *   timeDivision,
 *   tracks,
 *   allEvents,
 *   durationSeconds,
 *   tempoMap,
 *   ...
 * }
 */
export function parseMIDI(arrayBuffer, options = {}) {
  const { light = false } = options;
  const r = new MidiReader(arrayBuffer);

  // ── Header chunk ────────────────────────────────────────────────────────────
  const headerMark = r.readString(4);
  if (headerMark !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');

  const headerLen  = r.readUint32();   // always 6
  const format     = r.readUint16();   // 0, 1, or 2
  const numTracks  = r.readUint16();
  const timeDivRaw = r.readUint16();

  // timeDivision: if bit 15 = 0, it's ticks/quarter-note.
  // If bit 15 = 1, it's SMPTE (frames per second + ticks per frame) — rare.
  const isSMPTE    = !!(timeDivRaw & 0x8000);
  const timeDivision = isSMPTE ? timeDivRaw : timeDivRaw & 0x7FFF;

  r.skip(headerLen - 6);  // in case header is longer than 6 (shouldn't be)

  // ── Track chunks ─────────────────────────────────────────────────────────────
  const tracks = [];

  for (let t = 0; t < numTracks; t++) {
    const trackMark = r.readString(4);
    if (trackMark !== 'MTrk') {
      console.warn(`MIDI: expected MTrk at track ${t}, got "${trackMark}"`);
      break;
    }
    const trackLen  = r.readUint32();
    const trackEnd  = r.tell() + trackLen;
    const events    = parseTrack(r, trackEnd, light);
    r.seek(trackEnd);  // ensure we're at the end even if parseTrack stopped early

    // Extract track name from meta events
    const nameEv = events.find(e => e.type === 'trackName');
    tracks.push({ name: nameEv?.text ?? `Track ${t}`, events });
  }

  // ── Tempo map + absolute time stamps ─────────────────────────────────────────
  // Collect all tempo events from track 0 (format 1) or the single track (format 0)
  const tempoTrack = format === 1 ? tracks[0] : tracks[0];
  const tempoMap   = buildTempoMap(tempoTrack?.events ?? [], timeDivision);

  // Stamp every event in every track with timeSeconds
  for (const track of tracks) {
    for (const ev of track.events) {
      ev.timeSeconds = ticksToSeconds(ev.tick, tempoMap, timeDivision);
    }
  }

  // ── Merge all tracks into one sorted event list (useful for format 0 & 1) ──
  const allEvents = tracks
    .flatMap((t, trackIndex) => t.events.map(ev => { ev.track = trackIndex; return ev; }))
    .sort((a, b) => a.tick - b.tick || a.timeSeconds - b.timeSeconds);

  const endEvents = allEvents.filter(e => e.type === 'endOfTrack');
  const durationSeconds = endEvents.length
    ? Math.max(...endEvents.map(e => e.timeSeconds))
    : 0;

  return { format, timeDivision, isSMPTE, tracks, allEvents, durationSeconds, tempoMap };
}

// ─── Tempo map helpers ────────────────────────────────────────────────────────

/**
 * Build an array of { tick, microsecondsPerBeat, timeSeconds } breakpoints.
 * Defaults to 120 BPM (500,000 µs/beat).
 */
function buildTempoMap(events, ticksPerBeat) {
  const map = [{ tick: 0, microsecondsPerBeat: 500_000, timeSeconds: 0 }];

  for (const ev of events) {
    if (ev.type !== 'tempo') continue;
    const prev   = map[map.length - 1];
    const deltaTicks = ev.tick - prev.tick;
    const deltaTime  = (deltaTicks / ticksPerBeat) * (prev.microsecondsPerBeat / 1_000_000);
    map.push({
      tick: ev.tick,
      microsecondsPerBeat: ev.microsecondsPerBeat,
      timeSeconds: prev.timeSeconds + deltaTime,
    });
  }

  return map;
}

/** Convert an absolute tick value to wall-clock seconds using the tempo map. */
function ticksToSeconds(tick, tempoMap, ticksPerBeat) {
  // Find the last tempo change at or before `tick`
  let seg = tempoMap[0];
  for (const entry of tempoMap) {
    if (entry.tick <= tick) seg = entry;
    else break;
  }
  const deltaTicks = tick - seg.tick;
  return seg.timeSeconds + (deltaTicks / ticksPerBeat) * (seg.microsecondsPerBeat / 1_000_000);
}

// ─── MIDI Player ──────────────────────────────────────────────────────────────

/**
 * Simple real-time MIDI player using Web Audio API scheduling.
 *
 * callbacks: {
 *   onNoteOn(channel, note, velocity, timeSeconds),
 *   onNoteOff(channel, note, velocity, timeSeconds),
 *   onControlChange(channel, cc, value, timeSeconds),
 *   onProgramChange(channel, program, timeSeconds),
 *   onPitchBend(channel, value, timeSeconds),
 *   onTempo(bpm),
 * }
 *
 * Uses a look-ahead scheduler (50 ms intervals, 200 ms look-ahead) for
 * glitch-free note scheduling even when the main thread is busy.
 */
export class MIDIPlayer {
  constructor(parsedMIDI, audioContext, callbacks = {}) {
    this.midi        = parsedMIDI;
    this.ac          = audioContext;
    this.callbacks   = callbacks;
    this.events      = [...parsedMIDI.allEvents].filter(e =>
      ['noteOn','noteOff','controlChange','programChange','pitchBend','tempo'].includes(e.type)
    ).sort((a,b) => a.timeSeconds - b.timeSeconds);

    this._state      = 'stopped';  // 'playing' | 'paused' | 'stopped'
    this._eventIdx   = 0;
    this._startAcTime  = 0;   // AudioContext.currentTime when play started
    this._startSongTime = 0;  // song-time offset in seconds
    this._pauseSongTime = 0;
    this._timerId    = null;

    this.LOOK_AHEAD  = 0.2;   // seconds
    this.SCHEDULE_INTERVAL = 50; // ms
  }

  get currentTime() {
    if (this._state === 'playing') {
      return this._startSongTime + (this.ac.currentTime - this._startAcTime);
    }
    return this._pauseSongTime;
  }

  /** Start or restart from the beginning. */
  start() {
    this.stop();
    this._startFrom(0);
  }

  /** Seek to a position and resume/start playing. */
  seek(songTimeSec) {
    const wasPlaying = this._state === 'playing';
    this.stop();
    if (wasPlaying) this._startFrom(songTimeSec);
    else            this._pauseSongTime = songTimeSec;
  }

  pause() {
    if (this._state !== 'playing') return;
    this._pauseSongTime = this.currentTime;
    this._stopScheduler();
    this._state = 'paused';
  }

  resume() {
    if (this._state !== 'paused') return;
    this._startFrom(this._pauseSongTime);
  }

  stop() {
    this._stopScheduler();
    this._state         = 'stopped';
    this._eventIdx      = 0;
    this._pauseSongTime = 0;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _startFrom(songTimeSec) {
    this._startSongTime = songTimeSec;
    this._startAcTime   = this.ac.currentTime;
    // Advance event pointer to the right position
    this._eventIdx = this.events.findIndex(e => e.timeSeconds >= songTimeSec);
    if (this._eventIdx < 0) this._eventIdx = this.events.length;
    this._state = 'playing';
    this._schedule();
    this._timerId = setInterval(() => this._schedule(), this.SCHEDULE_INTERVAL);
  }

  _stopScheduler() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  _schedule() {
    if (this._state !== 'playing') return;
    const nowSong = this.currentTime;
    const horizon = nowSong + this.LOOK_AHEAD;

    while (this._eventIdx < this.events.length) {
      const ev = this.events[this._eventIdx];
      if (ev.timeSeconds > horizon) break;

      // Convert song-time to AudioContext-time for precise scheduling
      const acTime = this._startAcTime + (ev.timeSeconds - this._startSongTime);

      switch (ev.type) {
        case 'noteOn':
          this.callbacks.onNoteOn?.(ev.channel, ev.note, ev.velocity, acTime);
          break;
        case 'noteOff':
          this.callbacks.onNoteOff?.(ev.channel, ev.note, ev.velocity, acTime);
          break;
        case 'controlChange':
          this.callbacks.onControlChange?.(ev.channel, ev.controller, ev.value, acTime);
          break;
        case 'programChange':
          this.callbacks.onProgramChange?.(ev.channel, ev.program, acTime);
          break;
        case 'pitchBend':
          this.callbacks.onPitchBend?.(ev.channel, ev.value, acTime);
          break;
        case 'tempo':
          this.callbacks.onTempo?.(ev.bpm);
          break;
      }

      this._eventIdx++;
    }

    // Detect end of file
    if (this._eventIdx >= this.events.length) {
      this._stopScheduler();
      this._state = 'stopped';
      this.callbacks.onEnded?.();
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function bytesToString(bytes) {
  return Array.from(bytes).map(b => String.fromCharCode(b)).join('');
}

/** Convert a MIDI note number to a human-readable name, e.g. 60 → 'C4' */
export function noteNumberToName(n) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return names[n % 12] + (Math.floor(n / 12) - 1);
}

/** Convert a note name like 'A4' back to a MIDI number */
export function noteNameToNumber(name) {
  const match = name.match(/^([A-G]#?b?)(-?\d+)$/i);
  if (!match) return -1;
  const notes = { C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11 };
  return (notes[match[1]] ?? -1) + (parseInt(match[2]) + 1) * 12;
}

/**
 * Remove overlapping notes for Black MIDI performance and correctness.
 * Uses an efficient per-key pairing + linear scan (O(n log n) worst case due to per-pitch sorts).
 *
 * @param {object} parsed - result from parseMIDI
 * @param {object} options
 * @param {number} [options.gap=1] - ticks to leave between trimmed notes
 * @param {boolean} [options.perTrack=true]
 * @param {boolean} [options.perChannel=true]
 * @param {boolean} [options.ignorePercussion=true] - skip channel 9
 * @param {number} [options.minOverlap=1]
 * @returns {object} the same parsed object (mutated)
 */
export function removeOverlappingNotes(parsed, options = {}) {
  const {
    gap = 1,
    perTrack = true,
    perChannel = true,
    ignorePercussion = true,
    minOverlap = 1
  } = options;

  const startTime = performance.now();
  let overlapsFixed = 0;
  let notesShortened = 0;

  for (const track of parsed.tracks) {
    const events = track.events;
    if (!events || events.length === 0) continue;

    // Pair noteOn/noteOff
    const active = new Map(); // key -> noteOn event
    const noteList = []; // {startTick, endTick, onEv, offEv, channel, note}

    for (const ev of events) {
      if (ev.type !== 'noteOn' && ev.type !== 'noteOff') continue;
      const ch = ev.channel || 0;
      if (ignorePercussion && ch === 9) continue;

      const key = perChannel ? `${ch}:${ev.note}` : `${ev.note}`;

      if (ev.type === 'noteOn' && ev.velocity > 0) {
        if (active.has(key)) {
          // Will be handled in trimming pass
        }
        active.set(key, ev);
      } else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.velocity === 0)) {
        const onEv = active.get(key);
        if (onEv) {
          noteList.push({
            startTick: onEv.tick,
            endTick: ev.tick,
            onEv,
            offEv: ev,
            channel: ch,
            note: ev.note
          });
          active.delete(key);
        }
      }
    }

    // Group by key for trimming
    const groups = new Map();
    for (const n of noteList) {
      const key = perChannel ? `${n.channel}:${n.note}` : `${n.note}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }

    for (const [key, group] of groups) {
      group.sort((a, b) => a.startTick - b.startTick);

      for (let i = 0; i < group.length - 1; i++) {
        const curr = group[i];
        const next = group[i + 1];

        if (curr.endTick > next.startTick + minOverlap) {
          const newEnd = next.startTick - gap;
          if (newEnd > curr.startTick) {
            curr.endTick = newEnd;
            if (curr.offEv) {
              curr.offEv.tick = newEnd;
            }
            overlapsFixed++;
            notesShortened++;
          }
        }
      }
    }
  }

  // Re-stamp timeSeconds on allEvents because some ticks changed
  if (parsed.allEvents && parsed.tempoMap && parsed.timeDivision != null) {
    for (const ev of parsed.allEvents) {
      ev.timeSeconds = ticksToSeconds(ev.tick, parsed.tempoMap, parsed.timeDivision);
    }
    // Update duration
    const endEvents = parsed.allEvents.filter(e => e.type === 'endOfTrack');
    parsed.durationSeconds = endEvents.length
      ? Math.max(...endEvents.map(e => e.timeSeconds))
      : 0;
  }

  const time = performance.now() - startTime;
  parsed.overlapStats = { fixed: overlapsFixed, shortened: notesShortened, time: Math.round(time) };

  return parsed;
}

/**
 * sf2_parser.js
 * SoundFont 2 (.sf2) Parser
 *
 * Usage:
 *   const sf2 = await loadSF2(arrayBuffer);
 *   // sf2.presets   — array of preset/instrument info
 *   // sf2.samples   — array of decoded AudioBuffers (via Web Audio API)
 *   // sf2.getZones(bankNumber, presetNumber) — returns sample zones for a note
 *
 * Integration with your piano app:
 *   1. Load a .sf2 file from user input or fetch()
 *   2. Call loadSF2(arrayBuffer, audioContext) once at startup
 *   3. On noteOn(midiNote, velocity): call sf2.getZones(0, 0) to find the right sample,
 *      then create a BufferSource from zone.audioBuffer, pitch-shift by zone.pitchCorrection,
 *      and play it.
 */

// ─── Low-level binary reader ──────────────────────────────────────────────────

class DataReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.pos  = 0;
  }

  readUint8()  { return this.view.getUint8(this.pos++); }
  readInt8()   { return this.view.getInt8(this.pos++); }
  readUint16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  readInt16()  { const v = this.view.getInt16(this.pos,  true); this.pos += 2; return v; }
  readUint32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  readInt32()  { const v = this.view.getInt32(this.pos,  true); this.pos += 4; return v; }

  readString(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.view.getUint8(this.pos++);
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s.trim();
  }

  skip(n)  { this.pos += n; }
  tell()   { return this.pos; }
  seek(n)  { this.pos = n; }
}

// ─── RIFF chunk walker ────────────────────────────────────────────────────────

/**
 * Walks a RIFF/LIST chunk tree.
 * Returns a flat map:  { 'chunkId' => DataView, ... }
 * For LIST chunks the key is the list-type fourcc (e.g. 'INFO', 'pdta', 'sdta').
 */
function parseRIFF(buffer) {
  const r      = new DataReader(buffer);
  const chunks = {};

  function readChunk(end) {
    while (r.tell() < end) {
      const id   = r.readString(4);
      const size = r.readUint32();
      const start = r.tell();

      if (id === 'RIFF' || id === 'LIST') {
        const listType = r.readString(4);
        chunks[listType] = { offset: r.tell(), size: size - 4 };
        readChunk(start + size);          // recurse into list
      } else {
        chunks[id] = { offset: start, size };
      }

      r.seek(start + size + (size & 1)); // word-align
    }
  }

  readChunk(buffer.byteLength);
  return chunks;
}

// ─── SF2 structural types ─────────────────────────────────────────────────────

// SF2 generator parameter IDs we actually care about
const GEN = {
  START_ADDRS_OFFSET:       0,
  END_ADDRS_OFFSET:         1,
  START_LOOP_ADDRS_OFFSET:  2,
  END_LOOP_ADDRS_OFFSET:    3,
  KEY_RANGE:               43,
  VEL_RANGE:               44,
  SAMPLE_ID:               53,
  SAMPLE_MODES:            54,   // bit 0 = loop, bit 1 = loop-on-release
  OVERRIDING_ROOT_KEY:     58,
  SCALE_TUNING:            56,   // cents per semitone (default 100)
  FINE_TUNE:               52,   // cents
  COARSE_TUNE:             51,   // semitones
};

// ─── Parser ───────────────────────────────────────────────────────────────────

export async function loadSF2(arrayBuffer, audioContext) {
  const chunks = parseRIFF(arrayBuffer);

  // ── 1. INFO (optional, metadata) ──────────────────────────────────────────
  const info = {};
  for (const key of ['INAM', 'ICRD', 'IENG', 'IPRD', 'ICOP', 'ICMT', 'ISFT']) {
    if (chunks[key]) {
      const r = new DataReader(arrayBuffer.slice(chunks[key].offset, chunks[key].offset + chunks[key].size));
      info[key] = r.readString(chunks[key].size);
    }
  }

  // ── 2. smpl  — raw 16-bit PCM sample data ─────────────────────────────────
  if (!chunks['smpl']) throw new Error('SF2: missing smpl chunk');
  // Raw Int16 samples (interleaved for stereo pairs, but SF2 is always mono per sample record)
  const smplOffset = chunks['smpl'].offset;
  const smplSize   = chunks['smpl'].size;
  const smplData   = new Int16Array(arrayBuffer, smplOffset, smplSize / 2);

  // ── 3. pdta sub-chunks ────────────────────────────────────────────────────
  // phdr — preset headers
  // pbag — preset index list
  // pmod — preset modulators (ignored)
  // pgen — preset generators
  // inst — instrument headers
  // ibag — instrument index list
  // imod — instrument modulators (ignored)
  // igen — instrument generators
  // shdr — sample headers

  const required = ['phdr','pbag','pgen','inst','ibag','igen','shdr'];
  for (const c of required) {
    if (!chunks[c]) throw new Error(`SF2: missing ${c} chunk`);
  }

  function chunkReader(id) {
    return new DataReader(arrayBuffer.slice(chunks[id].offset, chunks[id].offset + chunks[id].size));
  }

  // phdr  (38 bytes each)
  const presets = [];
  {
    const r = chunkReader('phdr');
    const count = chunks['phdr'].size / 38;
    for (let i = 0; i < count; i++) {
      presets.push({
        name:       r.readString(20),
        preset:     r.readUint16(),   // MIDI program number
        bank:       r.readUint16(),
        bagIndex:   r.readUint16(),
        _lib:       r.readUint32(),
        _genre:     r.readUint32(),
        _morphology:r.readUint32(),
      });
    }
  }

  // pbag  (4 bytes each)
  const pbag = [];
  {
    const r = chunkReader('pbag');
    const count = chunks['pbag'].size / 4;
    for (let i = 0; i < count; i++) {
      pbag.push({ genIndex: r.readUint16(), modIndex: r.readUint16() });
    }
  }

  // pgen  (4 bytes each)
  const pgen = [];
  {
    const r = chunkReader('pgen');
    const count = chunks['pgen'].size / 4;
    for (let i = 0; i < count; i++) {
      const oper  = r.readUint16();
      const lo    = r.readUint8();
      const hi    = r.readUint8();
      pgen.push({ oper, lo, hi, amount: (hi << 8) | lo });
    }
  }

  // inst  (22 bytes each)
  const instruments = [];
  {
    const r = chunkReader('inst');
    const count = chunks['inst'].size / 22;
    for (let i = 0; i < count; i++) {
      instruments.push({
        name:     r.readString(20),
        bagIndex: r.readUint16(),
      });
    }
  }

  // ibag  (4 bytes each)
  const ibag = [];
  {
    const r = chunkReader('ibag');
    const count = chunks['ibag'].size / 4;
    for (let i = 0; i < count; i++) {
      ibag.push({ genIndex: r.readUint16(), modIndex: r.readUint16() });
    }
  }

  // igen  (4 bytes each)
  const igen = [];
  {
    const r = chunkReader('igen');
    const count = chunks['igen'].size / 4;
    for (let i = 0; i < count; i++) {
      const oper  = r.readUint16();
      const lo    = r.readUint8();
      const hi    = r.readUint8();
      igen.push({ oper, lo, hi, amount: (hi << 8) | lo });
    }
  }

  // shdr  (46 bytes each)
  const sampleHeaders = [];
  {
    const r = chunkReader('shdr');
    const count = chunks['shdr'].size / 46;
    for (let i = 0; i < count; i++) {
      sampleHeaders.push({
        name:           r.readString(20),
        start:          r.readUint32(),
        end:            r.readUint32(),
        loopStart:      r.readUint32(),
        loopEnd:        r.readUint32(),
        sampleRate:     r.readUint32(),
        originalPitch:  r.readUint8(),
        pitchCorrection:r.readInt8(),
        sampleLink:     r.readUint16(),
        sampleType:     r.readUint16(), // 1=mono,2=right,4=left,8=linked
      });
    }
  }

  // ── 4. Decode raw PCM to AudioBuffers (lazily, on demand) ─────────────────
  // We keep decoded buffers in a Map<sampleIndex, AudioBuffer> to avoid
  // decoding every sample up-front (a large SF2 can have 1000+ samples).
  const decodedCache = new Map();

  function getSampleBuffer(shdrIndex) {
    if (!audioContext) return null;
    if (decodedCache.has(shdrIndex)) return decodedCache.get(shdrIndex);

    const hdr = sampleHeaders[shdrIndex];
    if (!hdr || hdr.sampleType === 0 || hdr.name === 'EOS') return null;

    const length = hdr.end - hdr.start;
    if (length <= 0) return null;

    const ab = audioContext.createBuffer(1, length, hdr.sampleRate);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < length; i++) {
      ch[i] = smplData[hdr.start + i] / 32768.0;  // normalise Int16 → float
    }
    decodedCache.set(shdrIndex, ab);
    return ab;
  }

  // ── 5. Build zone lookup ───────────────────────────────────────────────────
  /**
   * Returns all instrument zones for a given bank+preset+note+velocity.
   * Each zone looks like:
   * {
   *   keyLo, keyHi, velLo, velHi,
   *   sampleHeader,         // raw shdr record
   *   audioBuffer,          // decoded AudioBuffer (null if no AudioContext passed)
   *   rootKey,              // MIDI note that sounds at pitch 1.0
   *   loopMode,             // 0=no loop, 1=loop, 3=loop-then-release
   *   loopStart, loopEnd,   // in samples
   *   fineTune,             // cents
   *   coarseTune,           // semitones
   *   scaleTuning,          // cents/semitone (default 100)
   * }
   *
   * How to use the returned zone in playback:
   *   const semitonesDiff = midiNote - zone.rootKey + zone.coarseTune;
   *   const centsDiff     = zone.fineTune + zone.pitchCorrection;
   *   const playbackRate  = Math.pow(2, (semitonesDiff * zone.scaleTuning + centsDiff) / 1200);
   *   // Then: bufferSource.buffer      = zone.audioBuffer;
   *   //       bufferSource.playbackRate.value = playbackRate;
   *   //       bufferSource.loop        = zone.loopMode > 0;
   *   //       bufferSource.loopStart   = zone.loopStart / zone.sampleHeader.sampleRate;
   *   //       bufferSource.loopEnd     = zone.loopEnd   / zone.sampleHeader.sampleRate;
   */
  function getZones(bank, presetNum, midiNote = 60, velocity = 64) {
    // Find the preset
    const pIdx = presets.findIndex(p => p.bank === bank && p.preset === presetNum);
    if (pIdx < 0) return [];
    const preset    = presets[pIdx];
    const nextPreset= presets[pIdx + 1];

    const zones = [];

    for (let bi = preset.bagIndex; bi < nextPreset.bagIndex; bi++) {
      // collect pgen generators for this preset bag
      const pGens = collectGens(pgen, pbag[bi].genIndex, pbag[bi + 1]?.genIndex ?? pgen.length);

      // the final pgen in a bag should be 'instrument' (oper=41)
      const instrGenIdx = pGens.findIndex(g => g.oper === 41);
      if (instrGenIdx < 0) continue;
      const instrIdx = pGens[instrGenIdx].amount;

      const instr      = instruments[instrIdx];
      const nextInstr  = instruments[instrIdx + 1];

      for (let ibi = instr.bagIndex; ibi < nextInstr.bagIndex; ibi++) {
        const iGens = collectGens(igen, ibag[ibi].genIndex, ibag[ibi + 1]?.genIndex ?? igen.length);

        // defaults
        let keyLo = 0, keyHi = 127, velLo = 0, velHi = 127;
        let sampleId = -1, loopMode = 0;
        let rootKey = -1, fineTune = 0, coarseTune = 0, scaleTuning = 100;
        let startOffset = 0, endOffset = 0, loopStartOffset = 0, loopEndOffset = 0;

        for (const g of iGens) {
          switch (g.oper) {
            case GEN.KEY_RANGE:          keyLo = g.lo; keyHi = g.hi; break;
            case GEN.VEL_RANGE:          velLo = g.lo; velHi = g.hi; break;
            case GEN.SAMPLE_ID:          sampleId = g.amount; break;
            case GEN.SAMPLE_MODES:       loopMode = g.amount & 3; break;
            case GEN.OVERRIDING_ROOT_KEY:rootKey = g.lo; break;
            case GEN.FINE_TUNE:          fineTune = signedAmount(g.amount); break;
            case GEN.COARSE_TUNE:        coarseTune = signedAmount(g.amount); break;
            case GEN.SCALE_TUNING:       scaleTuning = g.amount; break;
            case GEN.START_ADDRS_OFFSET: startOffset = signedAmount(g.amount); break;
            case GEN.END_ADDRS_OFFSET:   endOffset   = signedAmount(g.amount); break;
            case GEN.START_LOOP_ADDRS_OFFSET: loopStartOffset = signedAmount(g.amount); break;
            case GEN.END_LOOP_ADDRS_OFFSET:   loopEndOffset   = signedAmount(g.amount); break;
          }
        }

        if (sampleId < 0) continue;
        if (midiNote < keyLo || midiNote > keyHi) continue;
        if (velocity  < velLo || velocity  > velHi) continue;

        const shdr = sampleHeaders[sampleId];
        if (!shdr || shdr.sampleType === 0) continue;

        zones.push({
          keyLo, keyHi, velLo, velHi,
          sampleHeader: shdr,
          audioBuffer:  getSampleBuffer(sampleId),
          rootKey:      rootKey >= 0 ? rootKey : shdr.originalPitch,
          pitchCorrection: shdr.pitchCorrection,
          loopMode,
          loopStart:    shdr.loopStart + loopStartOffset,
          loopEnd:      shdr.loopEnd   + loopEndOffset,
          fineTune,
          coarseTune,
          scaleTuning,
        });
      }
    }
    return zones;
  }

  return {
    info,
    presets:       presets.slice(0, -1),   // drop EOP sentinel
    sampleHeaders: sampleHeaders.slice(0, -1), // drop EOS sentinel
    getZones,
    /** Decode and return a specific sample as an AudioBuffer. */
    getSampleBuffer,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectGens(genArray, from, to) {
  return genArray.slice(from, to);
}

/** SF2 generator amounts are signed 16-bit but stored as uint; sign-extend. */
function signedAmount(v) {
  return v > 0x7FFF ? v - 0x10000 : v;
}
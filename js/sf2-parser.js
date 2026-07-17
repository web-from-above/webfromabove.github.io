
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
        readChunk(start + size);
      } else {
        chunks[id] = { offset: start, size };
      }

      r.seek(start + size + (size & 1));
    }
  }

  readChunk(buffer.byteLength);
  return chunks;
}

const GEN = {
  START_ADDRS_OFFSET:       0,
  END_ADDRS_OFFSET:         1,
  START_LOOP_ADDRS_OFFSET:  2,
  END_LOOP_ADDRS_OFFSET:    3,
  KEY_RANGE:               43,
  VEL_RANGE:               44,
  SAMPLE_ID:               53,
  SAMPLE_MODES:            54,
  OVERRIDING_ROOT_KEY:     58,
  SCALE_TUNING:            56,
  FINE_TUNE:               52,
  COARSE_TUNE:             51,
};

async function loadSF2(arrayBuffer, audioContext) {
  const chunks = parseRIFF(arrayBuffer);

  const info = {};
  for (const key of ['INAM', 'ICRD', 'IENG', 'IPRD', 'ICOP', 'ICMT', 'ISFT']) {
    if (chunks[key]) {
      const r = new DataReader(arrayBuffer.slice(chunks[key].offset, chunks[key].offset + chunks[key].size));
      info[key] = r.readString(chunks[key].size);
    }
  }

  if (!chunks['smpl']) throw new Error('SF2: missing smpl chunk');
  const smplOffset = chunks['smpl'].offset;
  const smplSize   = chunks['smpl'].size;
  const smplData   = new Int16Array(arrayBuffer, smplOffset, smplSize / 2);

  const required = ['phdr','pbag','pgen','inst','ibag','igen','shdr'];
  for (const c of required) {
    if (!chunks[c]) throw new Error(`SF2: missing ${c} chunk`);
  }

  function chunkReader(id) {
    return new DataReader(arrayBuffer.slice(chunks[id].offset, chunks[id].offset + chunks[id].size));
  }

  const presets = [];
  {
    const r = chunkReader('phdr');
    const count = chunks['phdr'].size / 38;
    for (let i = 0; i < count; i++) {
      presets.push({
        name:       r.readString(20),
        preset:     r.readUint16(),
        bank:       r.readUint16(),
        bagIndex:   r.readUint16(),
        _lib:       r.readUint32(),
        _genre:     r.readUint32(),
        _morphology:r.readUint32(),
      });
    }
  }

  const pbag = [];
  {
    const r = chunkReader('pbag');
    const count = chunks['pbag'].size / 4;
    for (let i = 0; i < count; i++) {
      pbag.push({ genIndex: r.readUint16(), modIndex: r.readUint16() });
    }
  }

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

  const ibag = [];
  {
    const r = chunkReader('ibag');
    const count = chunks['ibag'].size / 4;
    for (let i = 0; i < count; i++) {
      ibag.push({ genIndex: r.readUint16(), modIndex: r.readUint16() });
    }
  }

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
        sampleType:     r.readUint16(),
      });
    }
  }

  const decodedCache = new Map();

  function getSampleBuffer(shdrIndex) {
    if (decodedCache.has(shdrIndex)) return decodedCache.get(shdrIndex);

    const hdr = sampleHeaders[shdrIndex];
    if (!hdr || hdr.sampleType === 0 || hdr.name === 'EOS') return null;

    if (!audioContext) return null;

    const length = hdr.end - hdr.start;
    if (length <= 0) return null;

    const ab = audioContext.createBuffer(1, length, hdr.sampleRate);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < length; i++) {
      ch[i] = smplData[hdr.start + i] / 32768.0;
    }
    decodedCache.set(shdrIndex, ab);
    return ab;
  }
  
  // Ensure all sample buffers are decoded (call after audio context is ready)
  async function ensureSampleBuffers() {
    if (!audioContext) return;
    for (let i = 0; i < sampleHeaders.length; i++) {
      const hdr = sampleHeaders[i];
      if (hdr && hdr.name !== 'EOS' && hdr.sampleType !== 0) {
        getSampleBuffer(i);
      }
    }
  }

  function getZones(bank, presetNum, midiNote = 60, velocity = 64) {
  const zoneCache = new Map();

function getCachedZones(sf2, bank, presetNum, midiNote, velocity) {
    const velBucket = velocity >> 5;
    const key = `${bank}_${presetNum}_${midiNote}_${velBucket}`;

    if (zoneCache.has(key)) {
        return zoneCache.get(key);
    }

    const result = sf2.getZones(bank, presetNum, midiNote, velocity);

    zoneCache.set(key, result);

    return result;
}
    const pIdx = presets.findIndex(p => p.bank === bank && p.preset === presetNum);
    if (pIdx < 0) return [];
    const preset    = presets[pIdx];
    const nextPreset= presets[pIdx + 1];

    const zones = [];
    const fallbackZones = []; // zones that don't match velocity (for fallback)

    for (let bi = preset.bagIndex; bi < nextPreset.bagIndex; bi++) {
      const pGens = collectGens(pgen, pbag[bi].genIndex, pbag[bi + 1]?.genIndex ?? pgen.length);

      const instrGenIdx = pGens.findIndex(g => g.oper === 41);
      if (instrGenIdx < 0) continue;
      const instrIdx = pGens[instrGenIdx].amount;

      const instr      = instruments[instrIdx];
      const nextInstr  = instruments[instrIdx + 1];

      for (let ibi = instr.bagIndex; ibi < nextInstr.bagIndex; ibi++) {
        const iGens = collectGens(igen, ibag[ibi].genIndex, ibag[ibi + 1]?.genIndex ?? igen.length);

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

        const shdr = sampleHeaders[sampleId];
        if (!shdr || shdr.sampleType === 0) continue;

        const zoneResult = {
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
        };

        // Check velocity - if matches, add to main zones, otherwise keep as fallback
        const velMatches = velocity >= velLo && velocity <= velHi;
        if (velMatches || velLo === 0 && velHi === 127) {
          zones.push(zoneResult);
        } else {
          fallbackZones.push(zoneResult);
        }
      }
    }
    
    // If no zones matched due to velocity, use fallback zones
    if (zones.length === 0 && fallbackZones.length > 0) {
        return fallbackZones;
    }
    
    return zones;
  }

  return {
    info,
    presets:       presets.slice(0, -1),
    sampleHeaders: sampleHeaders.slice(0, -1),
    getZones,
    getSampleBuffer,
    ensureSampleBuffers,
  };
}

function collectGens(genArray, from, to) {
  return genArray.slice(from, to);
}

function signedAmount(v) {
  return v > 0x7FFF ? v - 0x10000 : v;
}

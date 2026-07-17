import { keyToMidi, isSharp, SharpRatio, KeyMap, NoteColors, trackColorIdx } from './piano-constants.js';
import { WinW, WinH, KeyX, KeyWidth, KeyPress, KeyColor } from './webgl.js';
import { playKey, stopKey, resumeAudioSilently } from './audio-engine.js';

function triggerKey(k, velocity=127, color = null){
    if(k < 0) return;
    const j = KeyMap[k];
    KeyPress[j] = true;
    KeyColor[j] = (color != null ? color : NoteColors[trackColorIdx.value % NoteColors.length]);
    if (typeof resumeAudioSilently === 'function') resumeAudioSilently();
    playKey(k, velocity);
}

function pressKeyVisual(k, color = null) {
    if (k < 0) return;
    const j = KeyMap[k];
    KeyPress[j] = true;
    KeyColor[j] = (color != null ? color : NoteColors[trackColorIdx.value % NoteColors.length]);
}

function releaseKeyVisual(k){
    if(k < 0) return;
    const j = KeyMap[k];
    KeyPress[j] = false;
    KeyColor[j] = 0xFFFFFFFF;
}

function releaseKey(k){
    if(k < 0) return;
    const j = KeyMap[k];
    KeyPress[j] = false;
    KeyColor[j] = 0xFFFFFFFF;
    stopKey(k);
}

function hitKey(cx, cy){
    const kbTop = WinH - WinW*82/1000;
    if(cy < kbTop) return -1;
    const fTransitionCY = Math.max(3, Math.floor(WinW*82/1000*0.02+0.5));
    const fRedCY        = Math.floor(WinW*82/1000*0.05+0.5);
    const fSpacerCY     = 2;
    const fTopCY        = Math.floor((WinW*82/1000 - fSpacerCY - fRedCY - fTransitionCY)*0.95+0.5);
    const fSharpCY      = fTopCY * 0.67;
    const fCurY         = fTransitionCY + fRedCY + fSpacerCY;
    const relY          = cy - kbTop - fCurY;
    if(relY < fSharpCY){
        for(let i=75;i<128;i++){
            const j=KeyMap[i], fCX=KeyX[j];
            const bx=fCX-KeyWidth[0]*(SharpRatio/2-0.3), bw=KeyWidth[0]*SharpRatio;
            if(cx>=bx && cx<=bx+bw) return i;
        }
    }
    let fX=0;
    for(let i=0;i<75;i++){
        const j=KeyMap[i];
        if(cx>=fX && cx<fX+KeyWidth[j]) return i;
        fX += KeyWidth[j];
    }
    return -1;
}

export { triggerKey, pressKeyVisual, releaseKeyVisual, releaseKey, hitKey };

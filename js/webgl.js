import { settings } from './settings.js';
import { SharpRatio, KeyMap, isSharp, whiteCount, GenKeyX } from './piano-constants.js';

const canvas = document.getElementById('c');
let gl = null, gl2 = null, wgl = null;
const glSupports = {};
try { gl  = canvas.getContext('webgl',  {alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'high-performance'}); } catch(e) {}
try { gl2 = canvas.getContext('webgl2', {alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'high-performance'}); } catch(e) {}
wgl = gl2 || gl;
if(wgl) {
    var rVendor='unknown',rRenderer='unknown';
    function tryExtAndParam(c) {
        if (!c) return;
        try {
            const ext = c.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
                const v = c.getParameter(ext.UNMASKED_VENDOR_WEBGL);
                const r = c.getParameter(ext.UNMASKED_RENDERER_WEBGL);
                if (typeof v === 'string') rVendor = v;
                if (typeof r === 'string') rRenderer = r;
            }
        } catch (e) {}
    }
    tryExtAndParam(gl);
    tryExtAndParam(gl2);
    glSupports.vendor   = rVendor   || 'unknown';
    glSupports.renderer = rRenderer || 'unknown';
}

let WinW = 0, WinH = 0;
let KeyX     = new Array(128).fill(0);
let KeyWidth = new Array(128).fill(0);
let KeyPress = new Array(128).fill(false);
let KeyColor = new Array(128).fill(0xFFFFFFFF);

let m_iStartNote = 0, m_iEndNote = 127;
let m_fNotesX = 0, m_fWhiteCX = 0;
let m_pNoteState  = new Int16Array(128).fill(-1);
let m_pInputState = new Int16Array(128).fill(-1);
let m_iNotesAlpha = 255;

function recompute() {
    WinW = canvas.width;
    WinH = canvas.height;
    for(let i = 0; i < 128; i++) KeyX[i] = (Math.floor(i/12)*126 + GenKeyX[i%12]) * WinW / 1350;
    for(let i = 0; i < 127; i++) {
        const m = i % 12;
        if(m===1||m===3||m===6||m===8||m===10) KeyWidth[i] = WinW * 9 / 1350;
        else if(m===4||m===11)                  KeyWidth[i] = KeyX[i+1] - KeyX[i];
        else                                     KeyWidth[i] = KeyX[i+2] - KeyX[i];
    }
    KeyWidth[127] = WinW - KeyX[127];

    let iAllWhite = 0;
    for(let i = m_iStartNote; i <= m_iEndNote; i++) if(!isSharp(i)) iAllWhite++;
    const fBuffer = (isSharp(m_iStartNote) ? SharpRatio/2 : 0) + (isSharp(m_iEndNote) ? SharpRatio/2 : 0);
    m_fWhiteCX = WinW / (iAllWhite + fBuffer);
    if(WGL.enabled) WGL.resizeGL();
}

function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; recompute(); }

// ------ Color helpers ------
function bgrToFloats(c) {
    const a = ((c>>>24)&0xFF)/255, b=((c>>>16)&0xFF)/255, g=((c>>>8)&0xFF)/255, r=(c&0xFF)/255;
    return [r,g,b,a];
}
function fourColors(c1,c2,c3,c4) {
    const o = new Float32Array(16), a=[c1,c2,c3,c4];
    for(let i=0;i<4;i++){const[r,g,b,a_]=bgrToFloats(a[i]);o[i*4]=r;o[i*4+1]=g;o[i*4+2]=b;o[i*4+3]=a_;}
    return o;
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = (max === 0 ? 0 : d / max) * 100;
    const v = max * 100;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return [h * 360, s, v];
}

function hsvToRgb(h, s, v) {
    h = h % 360; if (h < 0) h += 360;
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60)      { r = c; g = x; b = 0; }
    else if (h < 120){ r = x; g = c; b = 0; }
    else if (h < 180){ r = 0; g = c; b = x; }
    else if (h < 240){ r = 0; g = x; b = c; }
    else if (h < 300){ r = x; g = 0; b = c; }
    else             { r = c; g = 0; b = x; }
    return [
        Math.max(0, Math.min(255, Math.round((r + m) * 255))),
        Math.max(0, Math.min(255, Math.round((g + m) * 255))),
        Math.max(0, Math.min(255, Math.round((b + m) * 255)))
    ];
}

function getBackgroundColors() {
    let hex = settings.get('backgroundColor') || '#464646';
    if (hex[0] !== '#') hex = '#' + hex;
    let or = parseInt(hex.substr(1,2),16) || 0x46;
    let og = parseInt(hex.substr(3,2),16) || 0x46;
    let ob = parseInt(hex.substr(5,2),16) || 0x46;
    const br = (settings.get('brightness') || 50) / 100;
    const [H, S, V] = rgbToHsv(or, og, ob);
    const vEff = Math.min(100, V * br);
    const [r, g, b] = hsvToRgb(H, S, vEff);
    const primary = 0xFF000000 | (b << 16) | (g << 8) | r;
    const vDark = Math.min(100, vEff * 0.7);
    const [dr, dg, db] = hsvToRgb(H, S, vDark);
    const dark = 0xFF000000 | (db << 16) | (dg << 8) | dr;
    const vVery = Math.min(100, vEff * 1.3);
    const [vdr, vdg, vdb] = hsvToRgb(H, S, vVery);
    const veryDark = 0xFF000000 | (vdb << 16) | (vdg << 8) | vdr;
    return { primary, dark, veryDark, r, g, b, dr, dg, db, vdr, vdg, vdb };
}

function getBackgroundColor() {
    return getBackgroundColors().primary;
}

function getBackgroundDarkColor() {
    return getBackgroundColors().dark;
}

function getBackgroundVeryDarkColor() {
    return getBackgroundColors().veryDark;
}

// ------ Shaders ------
const VERT_COLOR_SRC = `
attribute vec2 a_pos; attribute vec2 a_luv;
attribute vec4 a_c0; attribute vec4 a_c1; attribute vec4 a_c2; attribute vec4 a_c3;
uniform vec2 u_res; uniform float u_pixel;
varying vec4 v_c0,v_c1,v_c2,v_c3; varying vec2 v_luv;
void main(){
  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_luv = a_luv; v_c0 = a_c0; v_c1 = a_c1; v_c2 = a_c2; v_c3 = a_c3;
}
`;
const FRAG_COLOR_SRC = `
precision mediump float;
varying vec4 v_c0,v_c1,v_c2,v_c3; varying vec2 v_luv;
vec4 bilerpTL_TR_BR_BL(vec2 t,vec4 c0,vec4 c1,vec4 c2,vec4 c3){vec4 a=mix(c0,c1,t.x);vec4 b=mix(c3,c2,t.x);return mix(a,b,t.y);}
void main(){vec2 t=clamp(v_luv,0.0,1.0);t=t*t*(3.0-2.0*t);gl_FragColor=bilerpTL_TR_BR_BL(t,v_c0,v_c1,v_c2,v_c3);}
`;
const VERT_GRID_SRC = `
attribute vec2 a_pos; uniform vec2 u_res;
void main(){
  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;
const FRAG_GRID_SRC = `
precision mediump float; uniform vec4 u_color;
void main(){gl_FragColor=u_color;}
`;

const WGL = (function(){
    let _program, _gridProgram;
    let _posLoc,_luvLoc,_c0Loc,_c1Loc,_c2Loc,_c3Loc,_gridPosLoc;
    let _projLoc,_resLoc,_pixelLoc,_gridResLoc,_gridPixelLoc,_gridColorLoc;
    let _vbo,_ibo,_gridVB,_gridIB;
    let _quadBuf,_indexBuf;
    const _MAX_QUADS = 32768;
    let _quadCount = 0;

    function compileShader(type,src){
        const s=wgl.createShader(type);wgl.shaderSource(s,src);wgl.compileShader(s);
        if(!wgl.getShaderParameter(s,wgl.COMPILE_STATUS)){console.error('Shader compile:',wgl.getShaderInfoLog(s));wgl.deleteShader(s);return null;}
        return s;
    }
    function linkProgram(vs,fs){
        const p=wgl.createProgram();wgl.attachShader(p,vs);wgl.attachShader(p,fs);wgl.linkProgram(p);
        if(!wgl.getProgramParameter(p,wgl.LINK_STATUS)){console.error('Program link:',wgl.getProgramInfoLog(p));wgl.deleteProgram(p);return null;}
        return p;
    }

    function init(){
        if(!wgl) return false;
        const vs=compileShader(wgl.VERTEX_SHADER,VERT_COLOR_SRC);
        const fs=compileShader(wgl.FRAGMENT_SHADER,FRAG_COLOR_SRC);
        if(!vs||!fs) return false;
        _program=linkProgram(vs,fs);
        if(!_program) return false;
        _posLoc =wgl.getAttribLocation(_program,'a_pos');
        _luvLoc =wgl.getAttribLocation(_program,'a_luv');
        _c0Loc  =wgl.getAttribLocation(_program,'a_c0');
        _c1Loc  =wgl.getAttribLocation(_program,'a_c1');
        _c2Loc  =wgl.getAttribLocation(_program,'a_c2');
        _c3Loc  =wgl.getAttribLocation(_program,'a_c3');
        _projLoc=_resLoc=wgl.getUniformLocation(_program,'u_res');
        _pixelLoc=wgl.getUniformLocation(_program,'u_pixel');
        const gvs=compileShader(wgl.VERTEX_SHADER,VERT_GRID_SRC);
        const gfs=compileShader(wgl.FRAGMENT_SHADER,FRAG_GRID_SRC);
        _gridProgram=linkProgram(gvs,gfs);
        _gridPosLoc  =wgl.getAttribLocation(_gridProgram,'a_pos');
        _gridResLoc  =wgl.getUniformLocation(_gridProgram,'u_res');
        _gridPixelLoc=wgl.getUniformLocation(_gridProgram,'u_pixel');
        _gridColorLoc=wgl.getUniformLocation(_gridProgram,'u_color');
        _vbo=wgl.createBuffer(); _ibo=wgl.createBuffer();
        _quadBuf =new Float32Array(_MAX_QUADS*4*20);
        _indexBuf=new Uint16Array(_MAX_QUADS*6);
        for(let q=0;q<_MAX_QUADS;q++){
            const b=q*6;
            _indexBuf[b+0]=q*4+0;_indexBuf[b+1]=q*4+1;_indexBuf[b+2]=q*4+2;
            _indexBuf[b+3]=q*4+0;_indexBuf[b+4]=q*4+2;_indexBuf[b+5]=q*4+3;
        }
        wgl.bindBuffer(wgl.ARRAY_BUFFER,_vbo);
        wgl.bufferData(wgl.ARRAY_BUFFER,_quadBuf,wgl.DYNAMIC_DRAW);
        wgl.bindBuffer(wgl.ELEMENT_ARRAY_BUFFER,_ibo);
        wgl.bufferData(wgl.ELEMENT_ARRAY_BUFFER,_indexBuf,wgl.STATIC_DRAW);
        _gridVB=wgl.createBuffer(); _gridIB=wgl.createBuffer();
        resizeGL();
        return true;
    }

    function resizeGL(){
        if(!wgl) return;
        wgl.viewport(0,0,WinW,WinH);
        const pixel=Math.max(WinW,WinH);
        wgl.useProgram(_program);
        wgl.uniform2f(_projLoc,WinW,WinH);
        wgl.uniform1f(_pixelLoc,pixel);
        wgl.useProgram(_gridProgram);
        wgl.uniform2f(_gridResLoc,WinW,WinH);
        wgl.uniform1f(_gridPixelLoc,pixel);
        wgl.useProgram(null);
    }

    function clear(r,g,b){if(!wgl)return;wgl.clearColor(r,g,b,1);wgl.clear(wgl.COLOR_BUFFER_BIT);}

    function drawRect(x,y,cx,cy,c1,c2,c3,c4){
        if(!wgl||cx<=0||cy<=0)return;
        const S=20, qOff=_quadCount*4*S;
        _quadCount++;
        const X2=x+cx,Y2=y+cy;
        const colors=fourColors(c1,c2,c3,c4);
        const v=_quadBuf;
        v[qOff+ 0]=x;  v[qOff+ 1]=y;  v[qOff+ 2]=0; v[qOff+ 3]=0;
        v[qOff+ 4]=colors[0]; v[qOff+ 5]=colors[1]; v[qOff+ 6]=colors[2]; v[qOff+ 7]=colors[3];
        v[qOff+ 8]=colors[4]; v[qOff+ 9]=colors[5]; v[qOff+10]=colors[6]; v[qOff+11]=colors[7];
        v[qOff+12]=colors[8]; v[qOff+13]=colors[9]; v[qOff+14]=colors[10];v[qOff+15]=colors[11];
        v[qOff+16]=colors[12];v[qOff+17]=colors[13];v[qOff+18]=colors[14];v[qOff+19]=colors[15];
        v[qOff+20]=X2; v[qOff+21]=y;  v[qOff+22]=1; v[qOff+23]=0;
        v[qOff+24]=colors[0]; v[qOff+25]=colors[1]; v[qOff+26]=colors[2]; v[qOff+27]=colors[3];
        v[qOff+28]=colors[4]; v[qOff+29]=colors[5]; v[qOff+30]=colors[6]; v[qOff+31]=colors[7];
        v[qOff+32]=colors[8]; v[qOff+33]=colors[9]; v[qOff+34]=colors[10];v[qOff+35]=colors[11];
        v[qOff+36]=colors[12];v[qOff+37]=colors[13];v[qOff+38]=colors[14];v[qOff+39]=colors[15];
        v[qOff+40]=X2; v[qOff+41]=Y2; v[qOff+42]=1; v[qOff+43]=1;
        v[qOff+44]=colors[0]; v[qOff+45]=colors[1]; v[qOff+46]=colors[2]; v[qOff+47]=colors[3];
        v[qOff+48]=colors[4]; v[qOff+49]=colors[5]; v[qOff+50]=colors[6]; v[qOff+51]=colors[7];
        v[qOff+52]=colors[8]; v[qOff+53]=colors[9]; v[qOff+54]=colors[10];v[qOff+55]=colors[11];
        v[qOff+56]=colors[12];v[qOff+57]=colors[13];v[qOff+58]=colors[14];v[qOff+59]=colors[15];
        v[qOff+60]=x;  v[qOff+61]=Y2; v[qOff+62]=0; v[qOff+63]=1;
        v[qOff+64]=colors[0]; v[qOff+65]=colors[1]; v[qOff+66]=colors[2]; v[qOff+67]=colors[3];
        v[qOff+68]=colors[4]; v[qOff+69]=colors[5]; v[qOff+70]=colors[6]; v[qOff+71]=colors[7];
        v[qOff+72]=colors[8]; v[qOff+73]=colors[9]; v[qOff+74]=colors[10];v[qOff+75]=colors[11];
        v[qOff+76]=colors[12];v[qOff+77]=colors[13];v[qOff+78]=colors[14];v[qOff+79]=colors[15];
        if(_quadCount>=_MAX_QUADS) flushRects();
    }

    function drawSkew(x1,y1, x2,y2, x3,y3, x4,y4, c1,c2,c3,c4){
        if(!wgl) return;
        const A = 1/255;
        function fc(c){
            const a=(c>>>24)&0xFF, r=c&0xFF, g=(c>>>8)&0xFF, b=(c>>>16)&0xFF;
            return [r*A, g*A, b*A, a*A];
        }
        const [r1,g1,b1,a1] = fc(c1);
        const [r2,g2,b2,a2] = fc(c2);
        const [r3,g3,b3,a3] = fc(c3);
        const [r4,g4,b4,a4] = fc(c4);
        const qOff = _quadCount * 80;
        _quadCount++;
        const v = _quadBuf;
        v[qOff+ 0]=x1; v[qOff+ 1]=y1; v[qOff+ 2]=0; v[qOff+ 3]=0;
        v[qOff+ 4]=r1; v[qOff+ 5]=g1; v[qOff+ 6]=b1; v[qOff+ 7]=a1;
        v[qOff+ 8]=r2; v[qOff+ 9]=g2; v[qOff+10]=b2; v[qOff+11]=a2;
        v[qOff+12]=r3; v[qOff+13]=g3; v[qOff+14]=b3; v[qOff+15]=a3;
        v[qOff+16]=r4; v[qOff+17]=g4; v[qOff+18]=b4; v[qOff+19]=a4;
        v[qOff+20]=x2; v[qOff+21]=y2; v[qOff+22]=1; v[qOff+23]=0;
        v[qOff+24]=r1; v[qOff+25]=g1; v[qOff+26]=b1; v[qOff+27]=a1;
        v[qOff+28]=r2; v[qOff+29]=g2; v[qOff+30]=b2; v[qOff+31]=a2;
        v[qOff+32]=r3; v[qOff+33]=g3; v[qOff+34]=b3; v[qOff+35]=a3;
        v[qOff+36]=r4; v[qOff+37]=g4; v[qOff+38]=b4; v[qOff+39]=a4;
        v[qOff+40]=x3; v[qOff+41]=y3; v[qOff+42]=1; v[qOff+43]=1;
        v[qOff+44]=r1; v[qOff+45]=g1; v[qOff+46]=b1; v[qOff+47]=a1;
        v[qOff+48]=r2; v[qOff+49]=g2; v[qOff+50]=b2; v[qOff+51]=a2;
        v[qOff+52]=r3; v[qOff+53]=g3; v[qOff+54]=b3; v[qOff+55]=a3;
        v[qOff+56]=r4; v[qOff+57]=g4; v[qOff+58]=b4; v[qOff+59]=a4;
        v[qOff+60]=x4; v[qOff+61]=y4; v[qOff+62]=0; v[qOff+63]=1;
        v[qOff+64]=r1; v[qOff+65]=g1; v[qOff+66]=b1; v[qOff+67]=a1;
        v[qOff+68]=r2; v[qOff+69]=g2; v[qOff+70]=b2; v[qOff+71]=a2;
        v[qOff+72]=r3; v[qOff+73]=g3; v[qOff+74]=b3; v[qOff+75]=a3;
        v[qOff+76]=r4; v[qOff+77]=g4; v[qOff+78]=b4; v[qOff+79]=a4;
        if(_quadCount >= _MAX_QUADS) flushRects();
    }

    function flushRects(){
        if(_quadCount===0||!wgl) return;
        wgl.useProgram(_program);
        wgl.bindBuffer(wgl.ARRAY_BUFFER,_vbo);
        wgl.bufferSubData(wgl.ARRAY_BUFFER,0,_quadBuf.subarray(0,_quadCount*4*20));
        wgl.enableVertexAttribArray(_posLoc);wgl.vertexAttribPointer(_posLoc, 2,wgl.FLOAT,false,80, 0);
        wgl.enableVertexAttribArray(_luvLoc);wgl.vertexAttribPointer(_luvLoc, 2,wgl.FLOAT,false,80, 8);
        wgl.enableVertexAttribArray(_c0Loc); wgl.vertexAttribPointer(_c0Loc,  4,wgl.FLOAT,false,80,16);
        wgl.enableVertexAttribArray(_c1Loc); wgl.vertexAttribPointer(_c1Loc,  4,wgl.FLOAT,false,80,32);
        wgl.enableVertexAttribArray(_c2Loc); wgl.vertexAttribPointer(_c2Loc,  4,wgl.FLOAT,false,80,48);
        wgl.enableVertexAttribArray(_c3Loc); wgl.vertexAttribPointer(_c3Loc,  4,wgl.FLOAT,false,80,64);
        wgl.drawElements(wgl.TRIANGLES,_quadCount*6,wgl.UNSIGNED_SHORT,0);
        _quadCount=0;
        wgl.useProgram(null);
    }

    return { init, resizeGL, clear, drawRect, drawSkew, flush: flushRects, flushRects,
             get ctx(){ return wgl; }, get enabled(){ return !!wgl; }, get info(){ return glSupports; } };
})();

function drawKeyboard() {
    const kbTop = WinH - WinW * 82 / 1000;
    const fTransitionCY = Math.max(3, Math.floor(WinW * 82 / 1000 * 0.02 + 0.5));
    const fRedCY        = Math.floor(WinW * 82 / 1000 * 0.05 + 0.5);
    const fSpacerCY     = 2;
    const fTopCY        = Math.floor((WinW * 82 / 1000 - fSpacerCY - fRedCY - fTransitionCY) * 0.95 + 0.5);
    const fNearCY       = WinW * 82 / 1000 - fSpacerCY - fRedCY - fTransitionCY - fTopCY;
    const fKeyGap       = Math.max(1, Math.floor(KeyWidth[0] * 0.05 + 0.5));
    const fKeyGap1      = fKeyGap - Math.floor(fKeyGap / 2 + 0.5);
    const fSharpCY = fTopCY * 0.67;
    let fCurX = 0;
    let fCurY = fTransitionCY + fRedCY + fSpacerCY;

    const kbVeryDark = 0xFF000000;
    const bgPrimary = getBackgroundColor();
    WGL.drawRect(0, kbTop, WinW, WinW * 82 / 1000, kbVeryDark, kbVeryDark, kbVeryDark, kbVeryDark);
    WGL.drawRect(0, kbTop, WinW, fTransitionCY, bgPrimary, bgPrimary, kbVeryDark, kbVeryDark);
    WGL.drawRect(0, kbTop + fTransitionCY, WinW, fRedCY, 0xFF06054C, 0xFF06054C, 0xFF0D0A98, 0xFF0D0A98);
    WGL.drawRect(0, kbTop + fTransitionCY + fRedCY, WinW, fSpacerCY, 0xFF1C1C1C, 0xFF1C1C1C, 0xFF1C1C1C, 0xFF1C1C1C);

    for (let i = 0; i < 75; i++) {
        const j = KeyMap[i];
        if (!KeyPress[j]) {
            WGL.drawRect(fCurX + fKeyGap1, fCurY + kbTop, KeyWidth[j] - fKeyGap, fTopCY, 0xFFCCCCCC, 0xFFCCCCCC, 0xFFDDDDDD, 0xFFDDDDDD);
            WGL.drawRect(fCurX + fKeyGap1, fCurY + fTopCY + kbTop, KeyWidth[j] - fKeyGap, fNearCY, 0xFF8A8A8A, 0xFF8A8A8A, 0xFF9A9A9A, 0xFF9A9A9A);
            WGL.drawRect(fCurX + fKeyGap1, fCurY + fTopCY + kbTop, KeyWidth[j] - fKeyGap, 2, 0xFF3D3D3D, 0xFF3D3D3D, 0xFF999999, 0xFF999999);
        } else {
            const c = KeyColor[j];
            const r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
            const r2 = (r * 0.85) | 0, g2 = (g * 0.85) | 0, b2 = (b * 0.85) | 0;
            const c_bgr  = 0xFF000000 | (b  << 16) | (g  << 8) | r;
            const darker = 0xFF000000 | (b2 << 16) | (g2 << 8) | r2;
            const r3 = (r2 * 0.6) | 0, g3 = (g2 * 0.6) | 0, b3 = (b2 * 0.6) | 0;
            const darkest = 0xFF000000 | (b3 << 16) | (g3 << 8) | r3;
            WGL.drawRect(fCurX + fKeyGap1, fCurY + kbTop, KeyWidth[j] - fKeyGap, fTopCY + fNearCY - 2, darker, darker, darker, darker);
            WGL.drawRect(fCurX + fKeyGap1, fCurY + fTopCY + kbTop + fNearCY - 2, KeyWidth[j] - fKeyGap, 2, darkest, darkest, darkest, darkest);
        }
        if (j === 60) {
            const fMXGap = Math.floor(KeyWidth[j] * 0.25 + 0.5);
            const fMCX   = KeyWidth[j] - fMXGap * 2 - fKeyGap;
            const fMY    = Math.max(fCurY + fTopCY - fMCX - 5, fCurY + fSharpCY + 5);
            const mh     = fCurY + fTopCY - 5 - fMY;
            if (fMCX > 0 && mh > 0) {
                if (!KeyPress[j]) {
                    WGL.drawRect(Math.round(fCurX + fKeyGap1 + fMXGap), fMY + kbTop, Math.floor(fMCX), Math.round(mh), 0xFFAAAAAA, 0xFFAAAAAA, 0xFFAAAAAA, 0xFFAAAAAA);
                } else {
                    const c = KeyColor[j];
                    const r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
                    const r2 = (r * 0.7) | 0, g2 = (g * 0.7) | 0, b2 = (b * 0.7) | 0;
                    const markerColor = 0xFF000000 | (b2 << 16) | (g2 << 8) | r2;

                    const fMYpressed = Math.max(fCurY + fTopCY + fNearCY - fMCX - 7, fCurY + fSharpCY + 5);
                    const mhpressed  = fCurY + fTopCY + fNearCY - 7 - fMYpressed;
                    if (mhpressed > 0) WGL.drawRect(Math.round(fCurX + fKeyGap1 + fMXGap), fMYpressed + kbTop, Math.floor(fMCX), Math.round(mhpressed), markerColor, markerColor, markerColor, markerColor);
                }
            }
        }
        WGL.drawRect(Math.floor(fCurX + fKeyGap1 + KeyWidth[j] - fKeyGap + 0.5), fCurY + kbTop, fKeyGap, fTopCY + fNearCY, 0xFF000000, 0xFF999999, 0xFF999999, 0xFF000000);
        fCurX += KeyWidth[j];
    }

    const fSharpTop = SharpRatio * 0.7;
    fCurY = fTransitionCY + fRedCY + fSpacerCY;

    for (let i = 75; i !== 128; ++i) {
        const j = KeyMap[i];
        const fNudgeX = 0.3;
        fCurX = KeyX[j];
        const cx = KeyWidth[0] * SharpRatio;
        const x = fCurX - KeyWidth[0] * (SharpRatio / 2.0 - fNudgeX);
        const fSharpTopX1 = x + KeyWidth[0] * (SharpRatio - fSharpTop) / 2.0;
        const fSharpTopX2 = fSharpTopX1 + KeyWidth[0] * fSharpTop;

        if (!KeyPress[j]) {
            WGL.drawSkew(fSharpTopX1, fCurY + fSharpCY - fNearCY + kbTop, fSharpTopX2, fCurY + fSharpCY - fNearCY + kbTop, x + cx, fCurY + fSharpCY + kbTop, x, fCurY + fSharpCY + kbTop, 0xFF404040, 0xFF404040, 0xFF000000, 0xFF000000);
            WGL.drawSkew(fSharpTopX1, fCurY - fNearCY + kbTop, fSharpTopX1, fCurY + fSharpCY - fNearCY + kbTop, x, fCurY + fSharpCY + kbTop, x, fCurY + kbTop, 0xFF404040, 0xFF404040, 0xFF000000, 0xFF000000);
            WGL.drawSkew(fSharpTopX2, fCurY + fSharpCY - fNearCY + kbTop, fSharpTopX2, fCurY - fNearCY + kbTop, x + cx, fCurY + kbTop, x + cx, fCurY + fSharpCY + kbTop, 0xFF404040, 0xFF404040, 0xFF000000, 0xFF000000);
            WGL.drawRect(fSharpTopX1, fCurY - fNearCY + kbTop, fSharpTopX2 - fSharpTopX1, fSharpCY, 0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000);
            WGL.drawSkew(fSharpTopX1, fCurY - fNearCY + kbTop, fSharpTopX2, fCurY - fNearCY + kbTop, fSharpTopX2, fCurY - fNearCY + fSharpCY * 0.45 + kbTop, fSharpTopX1, fCurY - fNearCY + fSharpCY * 0.35 + kbTop, 0xFF202020, 0xFF202020, 0xFF404040, 0xFF404040);
            WGL.drawSkew(fSharpTopX1, fCurY - fNearCY + fSharpCY * 0.35 + kbTop, fSharpTopX2, fCurY - fNearCY + fSharpCY * 0.45 + kbTop, fSharpTopX2, fCurY - fNearCY + fSharpCY * 0.65 + kbTop, fSharpTopX1, fCurY - fNearCY + fSharpCY * 0.55 + kbTop, 0xFF404040, 0xFF404040, 0xFF000000, 0xFF000000);
        } else {
            const fNewNear = fNearCY * 0.25;
            const c = KeyColor[j];
            const r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
            const r1 = r * 0.5, g1 = g * 0.5, b1 = b * 0.5;
            const c_bgr = 0xFF000000 | (b << 16) | (g << 8) | r;
            const darker = 0xFF000000 | (b1 << 16) | (g1 << 8) | r1;
            WGL.drawSkew(fSharpTopX1, fCurY + fSharpCY - fNewNear + kbTop, fSharpTopX2, fCurY + fSharpCY - fNewNear + kbTop, x + cx, fCurY + fSharpCY + kbTop, x, fCurY + fSharpCY + kbTop, c_bgr, c_bgr, darker, darker);
            WGL.drawSkew(fSharpTopX1, fCurY - fNewNear + kbTop, fSharpTopX1, fCurY + fSharpCY - fNewNear + kbTop, x, fCurY + fSharpCY + kbTop, x, fCurY + kbTop, c_bgr, c_bgr, darker, darker);
            WGL.drawSkew(fSharpTopX2, fCurY + fSharpCY - fNewNear + kbTop, fSharpTopX2, fCurY - fNewNear + kbTop, x + cx, fCurY + kbTop, x + cx, fCurY + fSharpCY + kbTop, c_bgr, c_bgr, darker, darker);
            WGL.drawRect(fSharpTopX1, fCurY - fNewNear + kbTop, fSharpTopX2 - fSharpTopX1, fSharpCY, darker, darker, darker, darker);
            WGL.drawSkew(fSharpTopX1, fCurY - fNewNear + kbTop, fSharpTopX2, fCurY - fNewNear + kbTop, fSharpTopX2, fCurY - fNewNear + fSharpCY * 0.35 + kbTop, fSharpTopX1, fCurY - fNewNear + fSharpCY * 0.25 + kbTop, c_bgr, c_bgr, c_bgr, c_bgr);
            WGL.drawSkew(fSharpTopX1, fCurY - fNewNear + fSharpCY * 0.25 + kbTop, fSharpTopX2, fCurY - fNewNear + fSharpCY * 0.35 + kbTop, fSharpTopX2, fCurY - fNewNear + fSharpCY * 0.75 + kbTop, fSharpTopX1, fCurY - fNewNear + fSharpCY * 0.65 + kbTop, c_bgr, c_bgr, darker, darker);
        }
    }
    WGL.flushRects();
}

function createNote(k, yb, ye, c, cheap = false, laneOffset = 0, opacity = 1, layerType = null, velocity = 127, glowStrength = null, notesCY = 0, fadeAlpha = 255) {
    const j   = KeyMap[k];
    let x   = KeyX[j] + (laneOffset || 0);
    const cx  = KeyWidth[j];
    if(cx <= 0) return;
    const h = yb - ye;
    if(h <= 0) return;

    const gs = (glowStrength != null) ? glowStrength : ((typeof settings !== 'undefined' && settings.get) ? (settings.get('glowStrength') || 0) : 0.5);
    const hasGlow = (layerType && (layerType.indexOf('gliss') >= 0 || layerType.indexOf('lane') >= 0 || layerType.indexOf('decor') >= 0 || layerType.indexOf('density') >= 0)) || (gs > 0.2 && layerType);
    if (hasGlow) {
        let gr = ((c >> 16) & 0xFF) * 0.3 | 0;
        let gg = ((c >> 8) & 0xFF) * 0.3 | 0;
        let gb = (c & 0xFF) * 0.3 | 0;
        const glowC = 0xFF000000 | (gb << 16) | (gg << 8) | gr;
        const gw = cx * 1.25, gx = x - (gw - cx) * 0.5;
        WGL.drawRect(gx, ye - 1, gw, h + 2, glowC, glowC, glowC, glowC);
    }

    if (cheap) {
        const cFlat = 0xFF000000 | (c & 0x00FFFFFF);
        WGL.drawRect(x, ye, cx, h, cFlat, cFlat, cFlat, cFlat);
        return;
    }

    if (notesCY <= 0) notesCY = WinH - WinW * 82 / 1000;

    let r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
    const [H, S, V] = rgbToHsv(r, g, b);
    const [dr, dg, db] = hsvToRgb(H, S, Math.min(100, V * 0.6));
    const [vr, vg, vb] = hsvToRgb(H, S, Math.min(100, V * 0.2));

    const alphaTop = Math.max(0, Math.min(255, Math.round(0xFF * (notesCY - ye) / notesCY)));
    const alphaBot = Math.max(0, Math.min(alphaTop, Math.round(0xFF * (notesCY - yb) / notesCY)));
    const fadeA = Math.max(0, Math.min(255, fadeAlpha));

    const cPrimary  = (0xFF      << 24) | (b  << 16) | (g  << 8) | r;
    const cDark     = (alphaTop  << 24) | (db << 16) | (dg << 8) | dr;
    const cVeryDark = (fadeA     << 24) | (vb << 16) | (vg << 8) | vr;
    const fDeflate = Math.max(1, Math.min(3, Math.floor(cx * 0.15 / 2 + 0.5)));
    WGL.drawRect(x, ye, cx, h, cVeryDark, cVeryDark, cVeryDark, cVeryDark);
    if(h - fDeflate * 2 > 0 && cx - fDeflate * 2 > 0)
        WGL.drawRect(x + fDeflate, ye + fDeflate, cx - fDeflate * 2, h - fDeflate * 2, cPrimary, cDark, cDark, cPrimary);
}

function drawGrid() {
    const kbTop = WinH - WinW * 82 / 1000;
    const notesY = 0, notesCY = kbTop;
    const primary = getBackgroundColor();
    WGL.drawRect(0, notesY, WinW, notesCY, primary, primary, primary, primary);
    if (!settings.get('showGrid')) return;
    const dark  = getBackgroundDarkColor();
    const vdark = getBackgroundVeryDarkColor();
    for (let i = m_iStartNote + 1; i <= m_iEndNote; i++) {
        if (!isSharp(i - 1) && !isSharp(i)) {
            const iWhiteKeys = whiteCount(m_iStartNote, i);
            const fStartX = isSharp(m_iStartNote) ? SharpRatio / 2.0 : 0.0;
            let x = m_fWhiteCX * (iWhiteKeys + fStartX);
            x = Math.floor(x + 0.5);
            WGL.drawRect(x - 1, notesY, 3, notesCY, dark, vdark, vdark, dark);
        }
    }
}

function drawMeasureGrid(midiPlayer) {
    if (!midiPlayer || !midiPlayer.allEvents || midiPlayer.allEvents.length === 0) return;
    const kbTop = WinH - WinW * 82 / 1000;
    const notesY = 0, notesCY = kbTop;
    const primary = getBackgroundColor();
    const division = midiPlayer.division || 480;
    if (division & 0x8000) return;
    const currentTimeMs = midiPlayer.isPlaying
        ? (performance.now() - midiPlayer.startTimestamp)
        : midiPlayer.currentTime;
    const pxPerMs = settings.get('noteSpeed') / 8;
    const visibleMs = Math.max(1, notesCY / pxPerMs);
    const bottomTimeMs = currentTimeMs, topTimeMs = currentTimeMs + visibleMs;

    let iMicroSecsPerBeat = 500000;
    let iBeatsPerMeasure = 4;
    let iBeatType = 4;
    let iLastTempoTick = 0;
    let llLastTempoTime = 0;
    let iLastSignatureTick = 0;
    const events = midiPlayer.allEvents;
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const evMs = ev.absMs != null ? ev.absMs : midiPlayer.getTimeForTick(ev.time);
        if (evMs > bottomTimeMs) break;
        if (ev.type === 'tempo') {
            iMicroSecsPerBeat = ev.tempo || iMicroSecsPerBeat;
            iLastTempoTick = ev.time;
            llLastTempoTime = evMs;
        } else if (ev.type === 'timeSignature') {
            iBeatsPerMeasure = ev.numerator || 4;
            iBeatType = ev.denominator || 4;
            iLastSignatureTick = ev.time;
        }
    }
    if (iBeatType <= 0) iBeatType = 4;

    const lineDark  = getBackgroundDarkColor();
    const lineVDark = getBackgroundVeryDarkColor();

    const ticksPerMs = division / (iMicroSecsPerBeat / 1000.0);
    const ticksPerMeasure = iBeatsPerMeasure * (division * 4 / iBeatType);

    let measureTick = Math.max(0, Math.floor(bottomTimeMs * ticksPerMs) - ticksPerMeasure);
    measureTick = Math.floor(measureTick / ticksPerMeasure) * ticksPerMeasure;

    let safety = 0;
    while (safety < 4096) {
        const measureTimeMs = getTickTime(measureTick, iLastTempoTick, llLastTempoTime, iMicroSecsPerBeat, division);
        if (measureTimeMs > topTimeMs) break;

        if (measureTimeMs >= bottomTimeMs - 50) {
            const y = notesCY * (1.0 - (measureTimeMs - bottomTimeMs) / visibleMs);
            if (y + 1 > notesY) {
                const yR = Math.floor(y + 0.5);
                WGL.drawRect(0, yR - 1, WinW, 3, lineDark, lineDark, lineVDark, lineVDark);
            }
        }

        measureTick += ticksPerMeasure;
        safety++;
    }
}

function getTickTime(iTick, iLastTempoTick, llLastTempoTime, iMicroSecsPerBeat, iDivision) {
    if (iDivision & 0x8000) return -1;
    return llLastTempoTime + (iMicroSecsPerBeat * (iTick - iLastTempoTick)) / iDivision;
}

export { canvas, gl, wgl, glSupports, WinW, WinH, KeyX, KeyWidth, KeyPress, KeyColor,
         m_iStartNote, m_iEndNote, m_fNotesX, m_fWhiteCX, m_pNoteState, m_pInputState, m_iNotesAlpha,
         recompute, resize, WGL, drawKeyboard, createNote, drawGrid, drawMeasureGrid,
         getBackgroundColors, getBackgroundColor, getBackgroundDarkColor, getBackgroundVeryDarkColor,
         bgrToFloats, fourColors, rgbToHsv, hsvToRgb };

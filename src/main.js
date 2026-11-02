import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ================================================================
   0. URL 参数 / 小工具
================================================================ */
window.addEventListener('error', e=>{
  const s=document.getElementById('loadStep');
  if(s){ s.textContent='ERR: '+(e.message||e.type)+' @'+(e.lineno||''); s.style.color='#ff6a5a'; }
});
window.addEventListener('unhandledrejection', e=>{
  const s=document.getElementById('loadStep');
  if(s){ s.textContent='ERR: '+(e.reason && (e.reason.message||e.reason)); s.style.color='#ff6a5a'; }
});
const Q = new URLSearchParams(location.search);
const PRM = {
  t:      Q.has('t') ? parseFloat(Q.get('t')) : null,      // 轨道相位 0..1
  speed:  Q.has('speed') ? parseFloat(Q.get('speed')) : 1, // 初始流速
  hideui: Q.get('hideui') === '1',
  hud:    Q.get('hud') === '1',
  view:   Q.get('view') || '',                             // "theta,pitch"
  focus:  Q.get('focus') || '',                            // 舷窗 id
  snap:   Q.get('snap') === '1',                           // 截图模式：首帧即收敛
};

const D2R = Math.PI / 180;
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const lerp  = (a,b,t)=>a+(b-a)*t;
const sstep = (a,b,x)=>{ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const easeIO = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;

function mulberry(seed){ let s = seed>>>0; return ()=>{ s=(s+0x6D2B79F5)>>>0; let t=s; t=Math.imul(t^(t>>>15), t|1); t^=t+Math.imul(t^(t>>>7), t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }

/* 周期化二维值噪声（x 方向可按周期回绕，用于无缝经度纹理） */
function makeNoise(seed){
  const rng = mulberry(seed);
  const base = Array.from({length:256},(_,i)=>i);
  for(let i=255;i>0;i--){ const j=(rng()*(i+1))|0; const t=base[i]; base[i]=base[j]; base[j]=t; }
  const p = new Uint8Array(512);
  for(let i=0;i<512;i++) p[i]=base[i&255];
  const fade = t=>t*t*(3-2*t);
  function lat(x,y,per){
    if(per>0){ x%=per; if(x<0)x+=per; }
    return p[(p[x&255]+(y&255))&255]/255;
  }
  function noise(x,y,per=0){
    const xf=Math.floor(x), yf=Math.floor(y);
    const u=fade(x-xf), v=fade(y-yf);
    const a=lat(xf,yf,per), b=lat(xf+1,yf,per), c=lat(xf,yf+1,per), d=lat(xf+1,yf+1,per);
    return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
  }
  function fbm(x,y,{oct=5,gain=0.5,lac=2.03,per=0}={}){
    let s=0, amp=0.5, f=1, norm=0;
    for(let i=0;i<oct;i++){ s+=amp*noise(x*f,y*f,per?per*f:0); norm+=amp; amp*=gain; f*=lac; }
    return s/norm;
  }
  function ridge(x,y,o={}){ const v=fbm(x,y,o); return 1-Math.abs(v*2-1); }
  return { noise, fbm, ridge };
}

function canvasTex(w,h,draw,{srgb=true,wrap=true}={}){
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d'); draw(ctx,w,h);
  const t=new THREE.CanvasTexture(c);
  if(srgb) t.colorSpace=THREE.SRGBColorSpace;
  if(wrap){ t.wrapS=t.wrapT=THREE.RepeatWrapping; }
  t.anisotropy=4;
  return t;
}

/* 加载提示 */
const loadBar=document.getElementById('loadBar'), loadStep=document.getElementById('loadStep');
let loadPct=0;
async function step(pct,msg){
  loadPct=pct; loadBar.style.width=pct+'%'; loadStep.textContent=msg;
  await new Promise(r=>setTimeout(r,16));
}


/* ================================================================
   1. 渲染器 / 场景 / 相机
================================================================ */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.38;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.className = 'webgl';
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(71, innerWidth/innerHeight, 0.03, 4000);
const camRig = new THREE.Group();          // 位置漂移 / 聚焦推近
camRig.add(camera);
scene.add(camRig);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.55, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* 环境反射贴图：深空渐变 + 下方地球蓝光 + 侧向暖光（一次性烘焙） */
{
  const env = new THREE.Scene();
  const g = canvasTex(64, 32, (ctx,w,h)=>{
    const gr = ctx.createLinearGradient(0,0,0,h);
    gr.addColorStop(0,'#060709'); gr.addColorStop(0.55,'#0a0d12'); gr.addColorStop(0.78,'#16283e'); gr.addColorStop(1,'#0a1018');
    ctx.fillStyle=gr; ctx.fillRect(0,0,w,h);
  },{wrap:false});
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10,16,12), new THREE.MeshBasicMaterial({ map:g, side:THREE.BackSide }));
  env.add(sky);
  const eBlue = new THREE.Mesh(new THREE.PlaneGeometry(9,9), new THREE.MeshBasicMaterial({ color:0x4a82c0 }));
  eBlue.position.set(0,-7,0); eBlue.rotation.x=-Math.PI/2; env.add(eBlue);
  const eWarm = new THREE.Mesh(new THREE.PlaneGeometry(5,5), new THREE.MeshBasicMaterial({ color:0x8c5a2c }));
  eWarm.position.set(7,1,-2); eWarm.rotation.y=-Math.PI/2; env.add(eWarm);
  const eTop = new THREE.Mesh(new THREE.PlaneGeometry(8,8), new THREE.MeshBasicMaterial({ color:0x2e343c }));
  eTop.position.set(0,7,0); eTop.rotation.x=Math.PI/2; env.add(eTop);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.05).texture;
  pm.dispose();
}

/* ================================================================
   2. 程序化纹理（全部 canvas 生成，无外部资源）
================================================================ */
await step(8, '锻造舱体金属');

/* --- 舱体金属蒙皮（颜色 + 粗糙度复用） --- */
const metalN = makeNoise(7);
const metalTex = canvasTex(512,512,(ctx,w,h)=>{
  ctx.fillStyle='#2b2e33'; ctx.fillRect(0,0,w,h);
  const img = ctx.getImageData(0,0,w,h), d = img.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const n = metalN.fbm(x/64,y/64,{oct:4,per:8})*0.5 + metalN.fbm(x/9,y/9,{oct:3,per:64})*0.5;
    const v = 58 + n*10;
    d[i]=v; d[i+1]=v+3; d[i+2]=v+9;
  }
  ctx.putImageData(img,0,0);
  // 划痕与磨损（保持细腻，不加跨板接缝——拼板分块由几何承担）
  const rng = mulberry(31);
  for(let i=0;i<90;i++){
    const x=rng()*w, y=rng()*h, a=rng()*Math.PI, l=4+rng()*30;
    ctx.strokeStyle=`rgba(${140+rng()*60|0},${145+rng()*60|0},${150+rng()*60|0},${0.02+rng()*0.05})`;
    ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.cos(a)*l, y+Math.sin(a)*l); ctx.stroke();
  }
  for(let i=0;i<10;i++){ // 暗沉污渍
    const x=rng()*w, y=rng()*h, r=8+rng()*30;
    const g=ctx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0,'rgba(12,13,15,.09)'); g.addColorStop(1,'rgba(12,13,15,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill();
  }
});
const metalRough = canvasTex(256,256,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const n = metalN.fbm(x/40+9,y/40+3,{oct:4,per:7});
    const v = 150 + n*55;
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
},{srgb:false});

const MAT = {
  hull:  new THREE.MeshStandardMaterial({ map:metalTex, roughnessMap:metalRough, color:0xccd1d8, metalness:0.38, roughness:1.0, envMapIntensity:0.7 }),
  frame: new THREE.MeshStandardMaterial({ map:metalTex, color:0xe8edf3, metalness:0.55, roughness:0.46, envMapIntensity:1.2 }),
  dark:  new THREE.MeshStandardMaterial({ color:0x3f444c, metalness:0.5, roughness:0.7, envMapIntensity:0.4 }),
  bolt:  new THREE.MeshStandardMaterial({ color:0x70767e, metalness:0.9, roughness:0.35, envMapIntensity:1.2 }),
  railBlue: new THREE.MeshStandardMaterial({ color:0x2f5e92, metalness:0.8, roughness:0.32, envMapIntensity:1.0 }),
  railGray: new THREE.MeshStandardMaterial({ color:0x6a6f76, metalness:0.85, roughness:0.4, envMapIntensity:0.8 }),
  cable: new THREE.MeshStandardMaterial({ color:0x1f2228, metalness:0.3, roughness:0.9 }),
  cableOr: new THREE.MeshStandardMaterial({ color:0x9a5a22, metalness:0.4, roughness:0.7 }),
  box:   new THREE.MeshStandardMaterial({ map:metalTex, color:0xffffff, metalness:0.5, roughness:0.6, envMapIntensity:0.8 }),
};
/* 贴图路由标记：AI 舱内贴图加载完成后按 userData.tex 重新挂图（clone 会继承该标记） */
MAT.hull.userData.tex  = 'wall';
MAT.frame.userData.tex = 'frame';
MAT.dark.userData.tex  = 'dark';
MAT.box.userData.tex   = 'equip';

/* --- 设备标签 --- */
function labelTex(lines, {w=256,h=96, accent='#c8d2dc'}={}){
  return canvasTex(w,h,(ctx)=>{
    ctx.fillStyle='#22252a'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(200,210,220,.35)'; ctx.lineWidth=2; ctx.strokeRect(3,3,w-6,h-6);
    ctx.fillStyle=accent; ctx.textAlign='center'; ctx.textBaseline='middle';
    const fs = Math.min(26, (h-16)/lines.length - 4);
    ctx.font=`600 ${fs}px ui-monospace, "PingFang SC", monospace`;
    lines.forEach((s,i)=> ctx.fillText(s, w/2, h/2 + (i-(lines.length-1)/2)*(fs+6)));
    ctx.fillStyle='rgba(200,60,50,.8)';
    ctx.fillRect(8,h-12,w-16,4);
  },{wrap:false});
}
function winTagTex(txt){
  return canvasTex(160,56,(ctx,w,h)=>{
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='rgba(190,200,212,.9)'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='600 30px ui-monospace, monospace';
    ctx.fillText(txt,w/2,h/2);
    ctx.strokeStyle='rgba(190,200,212,.5)'; ctx.lineWidth=2;
    ctx.strokeRect(4,4,w-8,h-8);
  },{wrap:false});
}

/* --- 地球：共享大陆场 → 白昼 / 夜晚灯光 / 海面高光 三张贴图 --- */
await step(20, '生成行星地表');
const EW=1024, EH=512;
const landN = makeNoise(11), warpN = makeNoise(23), detN = makeNoise(47);
const landField = new Float32Array(EW*EH);
{
  for(let y=0;y<EH;y++){
    const v=y/EH, lat=Math.abs(v-0.5)*2;              // 0 赤道 → 1 极点
    for(let x=0;x<EW;x++){
      const u=x/EW;
      const wx = warpN.fbm(u*3, v*3, {oct:4, per:3}) - 0.5;
      const wy = warpN.fbm(u*3+7.3, v*3+2.1, {oct:4, per:3}) - 0.5;
      let c = landN.fbm(u*4 + wx*1.35, v*4 + wy*1.35, {oct:6, per:4});
      c += (detN.fbm(u*12, v*12, {oct:3, per:12}) - 0.5) * 0.16;
      c -= lat*lat*0.18;                               // 高纬度多海
      landField[y*EW+x] = c;
    }
  }
}
const SEA = 0.545;
const earthDay = canvasTex(EW,EH,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  for(let y=0;y<h;y++){
    const v=y/h, lat=Math.abs(v-0.5)*2;
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4, c=landField[y*w+x];
      let r,g,b;
      if(c < SEA){
        const depth = sstep(SEA, SEA-0.3, c);          // 0 浅海 → 1 深海
        r=lerp(26,6,depth); g=lerp(98,32,depth); b=lerp(150,74,depth);
      } else {
        const el = sstep(SEA, SEA+0.28, c);            // 海拔
        const moist = detN.fbm(x/w*6+3, v*6+8, {oct:4, per:6});
        const desertBand = Math.exp(-Math.pow((lat-0.32)/0.16,2));
        let veg = clamp(moist*1.25 - desertBand*0.55 - lat*0.5, 0, 1);
        r=lerp(lerp(58,150,el), lerp(170,186,desertBand), 1-veg*0.85);
        g=lerp(lerp(96,120,el), lerp(140,158,desertBand), 1-veg*0.75);
        b=lerp(lerp(44,84,el), lerp(104,120,desertBand), 1-veg*0.9);
        if(el>0.82){ const s=(el-0.82)/0.18; r=lerp(r,225,s); g=lerp(g,230,s); b=lerp(b,235,s); } // 高山雪
      }
      const iceLine = 0.86 + (detN.noise(x/w*8, 0.3, 8)-0.5)*0.1;   // 极地冰盖
      if(lat>iceLine){ const s=sstep(iceLine, iceLine+0.06, lat); r=lerp(r,232,s); g=lerp(g,240,s); b=lerp(b,246,s); }
      d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
});
const earthNight = canvasTex(EW,EH,(ctx,w,h)=>{
  ctx.fillStyle='#000'; ctx.fillRect(0,0,w,h);
  const rng = mulberry(77);
  for(let k=0;k<26000;k++){
    const x=(rng()*w)|0, y=(rng()*h)|0;
    const c=landField[y*w+x]; if(c<SEA+0.01) continue;
    const v=y/h, lat=Math.abs(v-0.5)*2; if(lat>0.78) continue;
    const density = detN.fbm(x/w*5+11, v*5+4, {oct:4, per:5});
    if(density < 0.56 + lat*0.2) continue;
    const b = 0.25+rng()*0.75;
    ctx.fillStyle = `rgba(255,${170+rng()*50|0},${100+rng()*40|0},${b})`;
    const s = rng()<0.92?1:2;
    ctx.fillRect(x,y,s,s);
  }
  // 微弱气辉底色
  ctx.fillStyle='rgba(20,30,50,.05)'; ctx.fillRect(0,0,w,h);
});
const earthSpec = canvasTex(EW,EH,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4, c=landField[y*w+x];
    const v = c<SEA ? 235 : 18;
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
},{srgb:false});

await step(34, '编织云层');
const cloudTex = canvasTex(1024,512,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  const cn = makeNoise(91);
  for(let y=0;y<h;y++){
    const v=y/h;
    for(let x=0;x<w;x++){
      const u=x/w;
      let a = cn.fbm(u*5, v*11, {oct:6, per:5});
      a = sstep(0.58, 0.85, a);
      a *= 0.6 + 0.4*cn.fbm(u*2+9, v*3+1, {oct:3, per:2});
      const i=(y*w+x)*4;
      d[i]=d[i+1]=d[i+2]=255; d[i+3]=a*255;
    }
  }
  ctx.putImageData(img,0,0);
},{srgb:false});

/* --- 通用噪声纹理（着色器用：极光闪烁等） --- */
const noiseTex = canvasTex(256,256,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  const n1=makeNoise(5), n2=makeNoise(6);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    d[i]  = n1.fbm(x/40,y/40,{oct:4,per:6.4})*255;
    d[i+1]= n2.fbm(x/18,y/18,{oct:4,per:14})*255;
    d[i+2]= n1.fbm(x/80+3,y/80+9,{oct:3,per:3.2})*255;
    d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
},{srgb:false});

/* --- 火星 / 气态巨行星 / 冰月 --- */
await step(46, '铸造远游行星');
const marsTex = canvasTex(1024,512,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  const mn=makeNoise(301);
  for(let y=0;y<h;y++){
    const v=y/h, lat=Math.abs(v-0.5)*2;
    for(let x=0;x<w;x++){
      const u=x/w;
      const n = mn.fbm(u*5, v*5, {oct:6, per:5});
      const maria = sstep(0.62,0.72, mn.fbm(u*3+8, v*3+1, {oct:4, per:3}));
      let r=lerp(176,96,maria)+ (n-0.5)*36;
      let g=lerp(98,58,maria) + (n-0.5)*22;
      let b=lerp(64,44,maria) + (n-0.5)*16;
      if(lat>0.9){ const s=sstep(0.9,0.96,lat); r=lerp(r,238,s); g=lerp(g,240,s); b=lerp(b,244,s); }
      const i=(y*w+x)*4; d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
});
const jovianTex = canvasTex(1024,512,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  const jn=makeNoise(401);
  const bands=[[196,164,124],[150,110,74],[222,204,172],[170,120,80],[236,220,194],[140,96,64],[206,178,142]];
  for(let y=0;y<h;y++){
    const v=y/h;
    for(let x=0;x<w;x++){
      const u=x/w;
      const wob = (jn.fbm(u*3, v*6, {oct:4, per:3})-0.5)*0.14;
      const t = (v + wob)*9;
      const bi = Math.abs(Math.floor(t))%bands.length;
      const f = t-Math.floor(t);
      const c0=bands[bi], c1=bands[(bi+1)%bands.length];
      const m = sstep(0.35,0.65,f)*0.5;
      const turb = (jn.fbm(u*9, v*22, {oct:4, per:9})-0.5)*30;
      let r=lerp(c0[0],c1[0],m)+turb, g=lerp(c0[1],c1[1],m)+turb*0.9, b=lerp(c0[2],c1[2],m)+turb*0.75;
      // 大红斑
      const dx=((u-0.68+1.5)%1-0.5)*3.4, dy=(v-0.62)*9;
      const spot=Math.exp(-(dx*dx+dy*dy)*3.2);
      r=lerp(r,196,spot*0.85); g=lerp(g,84,spot*0.85); b=lerp(b,60,spot*0.85);
      const i=(y*w+x)*4; d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
});
const moonTex = canvasTex(512,256,(ctx,w,h)=>{
  const img=ctx.createImageData(w,h), d=img.data;
  const mn=makeNoise(501);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const n=mn.fbm(x/w*6, y/h*6, {oct:5, per:6});
    const v=118+(n-0.5)*70;
    d[i]=v; d[i+1]=v+2; d[i+2]=v+6; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  const rng=mulberry(9);
  for(let k=0;k<240;k++){
    const x=rng()*w, y=rng()*h, r=1+rng()*rng()*9;
    ctx.strokeStyle=`rgba(60,62,66,${0.25+rng()*0.3})`; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.stroke();
    ctx.fillStyle=`rgba(70,72,76,${0.10+rng()*0.15})`;
    ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill();
  }
});

/* --- 星云 / 太阳与恒星光斑 --- */
function nebulaTex(seed, hueA, hueB){
  return canvasTex(512,512,(ctx,w,h)=>{
    const nn=makeNoise(seed);
    const img=ctx.createImageData(w,h), d=img.data;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const dx=x/w-0.5, dy=y/h-0.5;
      const rad=Math.exp(-(dx*dx+dy*dy)*7);
      const n=nn.fbm(x/90,y/90,{oct:5})*0.6+nn.fbm(x/34,y/34,{oct:4})*0.4;
      const a=rad*sstep(0.38,0.85,n);
      const m=nn.fbm(x/60+9,y/60+4,{oct:3});
      d[i]  =lerp(hueA[0],hueB[0],m);
      d[i+1]=lerp(hueA[1],hueB[1],m);
      d[i+2]=lerp(hueA[2],hueB[2],m);
      d[i+3]=a*190;
    }
    ctx.putImageData(img,0,0);
  },{wrap:false});
}
const glowTex = canvasTex(128,128,(ctx,w,h)=>{
  const g=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(0.12,'rgba(255,246,224,.7)');
  g.addColorStop(0.35,'rgba(255,232,196,.16)');
  g.addColorStop(1,'rgba(255,220,170,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
},{wrap:false});
const starSprTex = canvasTex(64,64,(ctx,w,h)=>{
  const g=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(0.35,'rgba(220,232,255,.4)');
  g.addColorStop(1,'rgba(200,220,255,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
},{wrap:false});

/* ================================================================
   3. 舱体：舷窗 / 窗框 / 螺栓 / 蒙皮壁板 / 扶手 / 线缆 / 设备
================================================================ */
await step(58, '铆接穹顶舱体');
const cabin = new THREE.Group(); scene.add(cabin);

function dirOf(thetaDeg, pitchDeg){
  const phi = (90-pitchDeg)*D2R, th = thetaDeg*D2R;
  return new THREE.Vector3(Math.sin(phi)*Math.sin(th), Math.cos(phi), Math.sin(phi)*Math.cos(th));
}
/* 以舷窗法线建立局部基：z 指向舱内（-dir），y 沿球面"上" */
function frameBasis(dir){
  const z = dir.clone().negate();
  const up0 = Math.abs(dir.y)>0.94 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(0,1,0);
  const y = up0.clone().sub(dir.clone().multiplyScalar(up0.dot(dir))).normalize();
  const x = new THREE.Vector3().crossVectors(y,z).normalize();
  const m = new THREE.Matrix4().makeBasis(x,y,z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
function roundedPolyShape(pts, r){
  const s=new THREE.Shape(); const n=pts.length;
  for(let i=0;i<n;i++){
    const p0=pts[(i+n-1)%n], p1=pts[i], p2=pts[(i+1)%n];
    const v1=new THREE.Vector2(p0[0]-p1[0],p0[1]-p1[1]).normalize();
    const v2=new THREE.Vector2(p2[0]-p1[0],p2[1]-p1[1]).normalize();
    const ax=p1[0]+v1.x*r, ay=p1[1]+v1.y*r, bx=p1[0]+v2.x*r, by=p1[1]+v2.y*r;
    if(i===0) s.moveTo(ax,ay); else s.lineTo(ax,ay);
    s.quadraticCurveTo(p1[0],p1[1],bx,by);
  }
  s.closePath(); return s;
}
const revPts = pts => pts.slice().reverse();

/* ---- 舷窗定义：中央大圆窗 + 环绕梯形窗 + 小圆窗（不规则排布） ---- */
const R_SHELL = 1.78;
const WIN_DEFS = [
  { id:'main', kind:'circle', theta:-52, pitch:-30, r:0.56 },
  { id:'w1', kind:'trap', theta:14,  pitch:-17, th:0.32, bh:0.44, hh:0.40 },
  { id:'w2', kind:'trap', theta:78,  pitch:-4,  th:0.27, bh:0.38, hh:0.34 },
  { id:'w3', kind:'trap', theta:142, pitch:-26, th:0.26, bh:0.36, hh:0.32 },
  { id:'w4', kind:'trap', theta:-141,pitch:40,  th:0.28, bh:0.39, hh:0.36 },
  { id:'w5', kind:'trap', theta:-97, pitch:-7,  th:0.24, bh:0.33, hh:0.30 },
  { id:'w6', kind:'circle', theta:172, pitch:14, r:0.26 },
  { id:'w7', kind:'trap', theta:44,  pitch:45,  th:0.22, bh:0.30, hh:0.26 },
];
const windows = [];   // {id, dir, quat, center(V3), outN, aperturePts/circle, size, glass, hit}
const boltXforms = []; // {pos, quat}

WIN_DEFS.forEach((wd, wi)=>{
  const dir = dirOf(wd.theta, wd.pitch);
  const quat = frameBasis(dir);
  const center = dir.clone().multiplyScalar(R_SHELL-0.055);
  let aperShape, aperPts=null, radiusMax;
  if(wd.kind==='circle'){
    aperShape = new THREE.Shape(); aperShape.absarc(0,0,wd.r,0,Math.PI*2,false);
    radiusMax = wd.r;
  } else {
    aperPts = [[-wd.bh,-wd.hh],[wd.bh,-wd.hh],[wd.th,wd.hh],[-wd.th,wd.hh]];
    aperShape = roundedPolyShape(aperPts, 0.05);
    radiusMax = Math.hypot(wd.bh, wd.hh);
  }
  // 窗框：外形放大 + 内孔
  let frameShape;
  const grow = 0.105;
  if(wd.kind==='circle'){
    frameShape = new THREE.Shape(); frameShape.absarc(0,0,wd.r+grow,0,Math.PI*2,false);
    const hole = new THREE.Path(); hole.absarc(0,0,wd.r,0,Math.PI*2,true);
    frameShape.holes.push(hole);
  } else {
    const s = 1 + grow/Math.max(wd.th, wd.hh)*0.9;
    const outer = aperPts.map(p=>[p[0]*s*1.06, p[1]*s*1.06]);
    frameShape = roundedPolyShape(outer, 0.06);
    const holePts = revPts(aperPts);
    frameShape.holes.push(roundedPolyShape(holePts, 0.05));
  }
  const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
    depth:0.075, bevelEnabled:true, bevelThickness:0.014, bevelSize:0.014, bevelSegments:2,
    curveSegments: wd.kind==='circle'?72:8,
  });
  frameGeo.translate(0,0,-0.038);
  const frame = new THREE.Mesh(frameGeo, MAT.frame);
  frame.position.copy(center); frame.quaternion.copy(quat);
  frame.castShadow = true; frame.receiveShadow = true;
  cabin.add(frame);

  // 玻璃（带厚度边色）：仅环境贴图反射，不响应动态灯光——避免阳光/舱灯在玻璃上形成眩光斑
  const glassMat = new THREE.MeshBasicMaterial({
    color:0x6b8292, transparent:true, opacity:0.055,
    envMap:scene.environment, reflectivity:0.16,
    side:THREE.DoubleSide, depthWrite:false,
  });
  const glass = new THREE.Mesh(new THREE.ShapeGeometry(aperShape, 48), glassMat);
  glass.position.copy(dir.clone().multiplyScalar(R_SHELL-0.075));
  glass.quaternion.copy(quat);
  cabin.add(glass);
  // 玻璃厚度边（夹层色调）
  let edgeGeo;
  if(wd.kind==='circle') edgeGeo = new THREE.TorusGeometry(wd.r, 0.007, 6, 72);
  else {
    const edgeShape = roundedPolyShape(aperPts.map(p=>[p[0]*1.015,p[1]*1.015]), 0.05);
    const h = roundedPolyShape(revPts(aperPts), 0.05); edgeShape.holes.push(h);
    edgeGeo = new THREE.ExtrudeGeometry(edgeShape,{depth:0.012,bevelEnabled:false,curveSegments:8});
  }
  const edge = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({ color:0x3f6a58, transparent:true, opacity:0.35 }));
  edge.position.copy(glass.position); edge.quaternion.copy(quat);
  cabin.add(edge);

  // 隐形点击代理
  const hit = new THREE.Mesh(new THREE.ShapeGeometry(aperShape, 24),
    new THREE.MeshBasicMaterial({ visible:false, side:THREE.DoubleSide }));
  hit.position.copy(dir.clone().multiplyScalar(R_SHELL-0.10));
  hit.quaternion.copy(quat); hit.userData.winId = wd.id;
  cabin.add(hit);

  // 窗框螺栓环
  const nB = wd.kind==='circle' ? Math.round(wd.r*52) : 30;
  for(let k=0;k<nB;k++){
    let px,py;
    if(wd.kind==='circle'){ const a=k/nB*Math.PI*2; const rr=wd.r+0.052; px=Math.cos(a)*rr; py=Math.sin(a)*rr; }
    else {
      const s = 1 + 0.052/Math.max(wd.th, wd.hh)*0.95;
      const per = aperPts.map(p=>[p[0]*s, p[1]*s]);
      const lens=[]; let L=0;
      for(let e=0;e<4;e++){ const a=per[e], b=per[(e+1)%4]; const l=Math.hypot(b[0]-a[0],b[1]-a[1]); lens.push(l); L+=l; }
      let d=k/nB*L, e=0;
      while(d>lens[e]){ d-=lens[e]; e=(e+1)%4; }
      const a=per[e], b=per[(e+1)%4], f=d/lens[e];
      px=lerp(a[0],b[0],f); py=lerp(a[1],b[1],f);
    }
    const pos = new THREE.Vector3(px,py,0.058).applyQuaternion(quat).add(center);
    const bq = quat.clone();
    boltXforms.push({pos, quat:bq});
  }

  // 舷窗编号铭牌
  const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.10,0.035),
    new THREE.MeshBasicMaterial({ map:winTagTex('W-'+(wi+1)), transparent:true, opacity:0.5, toneMapped:false, depthWrite:false }));
  const tagOff = new THREE.Vector3(0, -(radiusMax+0.16), 0.065).applyQuaternion(quat);
  tag.position.copy(center).add(tagOff); tag.quaternion.copy(quat);
  cabin.add(tag);

  windows.push({ id:wd.id, def:wd, dir, quat, center, radiusMax, glass, hit, aperPts });
});

/* ---- 蒙皮壁板：双层错缝球面拼板（避开窗洞，阻挡漏光） ---- */
{
  const plateGeo = new THREE.PlaneGeometry(1,1);
  const cells = [];
  const ROWS = 14;
  for(let layer=0; layer<2; layer++){
    const R = R_SHELL + 0.02 + layer*0.085;
    for(let r=0;r<ROWS;r++){
      const phi = lerp(0.10, 0.90, (r+0.5+(layer?0.5:0))/ROWS) * Math.PI; // 避开极顶/极底
      const cols = Math.max(8, Math.round(30*Math.sin(phi)));
      for(let c=0;c<cols;c++){
        const th = ((c+(layer?0.5:0))/cols) * Math.PI*2;
        const d = new THREE.Vector3().setFromSphericalCoords(1, phi, th);
        // 与所有窗洞保持角距：板心角距须大于 窗洞角半径+板半对角线角距，避免板角伸入窗洞遮挡外景
        const cw = (Math.PI*2*Math.sin(phi)*R/cols)*1.14, ch = (0.8*Math.PI*R/ROWS)*1.12;
        const cellRad = Math.hypot(cw,ch)*0.5/R + 0.012;
        let ok = true;
        for(const w of windows){
          const lim = Math.atan(w.radiusMax/(R_SHELL-0.05)) + cellRad;
          if(d.angleTo(w.dir) < lim){ ok=false; break; }
        }
        if(!ok) continue;
        cells.push({d, R, w: cw, h: ch});
      }
    }
  }
  const plateMat = MAT.hull.clone();
  const plates = new THREE.InstancedMesh(plateGeo, plateMat, cells.length);
  const m4=new THREE.Matrix4(), q4=new THREE.Quaternion(), s3=new THREE.Vector3(), col=new THREE.Color();
  const rng = mulberry(3);
  cells.forEach((cl,i)=>{
    const z = cl.d.clone().negate();
    const up0 = Math.abs(cl.d.y)>0.94 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(0,1,0);
    const y = up0.clone().sub(cl.d.clone().multiplyScalar(up0.dot(cl.d))).normalize();
    const x = new THREE.Vector3().crossVectors(y,z).normalize();
    q4.setFromRotationMatrix(m4.makeBasis(x,y,z));
    // 少量随机旋转（制造非均匀感）
    const roll = new THREE.Quaternion().setFromAxisAngle(z, (rng()-0.5)*0.05);
    q4.premultiply(roll);
    const pos = cl.d.clone().multiplyScalar(cl.R + (rng()-0.5)*0.006);
    s3.set(cl.w, cl.h, 1);
    plates.setMatrixAt(i, m4.compose(pos, q4, s3));
    const v = 0.94 + rng()*0.10, warm = rng()<0.07;
    col.setRGB(v*(warm?1.04:1), v, v*(warm?0.94:1.03));
    plates.setColorAt(i, col);
  });
  plates.castShadow = true; plates.receiveShadow = true;
  cabin.add(plates);

  // 窗洞环形衬板：盖住窗框外缘与蒙皮壁板之间的环形缝隙，封堵外景经板缝漏入舱内视野
  const ringMat = plateMat.clone(); ringMat.side = THREE.DoubleSide;
  windows.forEach((w,wi)=>{
    let g;
    if(w.def.kind==='circle'){
      g = new THREE.RingGeometry(w.radiusMax+0.03, w.radiusMax+1.0, 72);
    } else {
      const so = (w.radiusMax+1.0)/w.radiusMax, si = (w.radiusMax+0.03)/w.radiusMax;
      const sh = roundedPolyShape(w.aperPts.map(p=>[p[0]*so, p[1]*so]), 0.10);
      sh.holes.push(roundedPolyShape(revPts(w.aperPts).map(p=>[p[0]*si, p[1]*si]), 0.06));
      g = new THREE.ShapeGeometry(sh, 8);
    }
    const ring = new THREE.Mesh(g, ringMat);
    ring.position.copy(w.dir).multiplyScalar(R_SHELL+0.045+wi*0.004);
    ring.quaternion.copy(w.quat);
    ring.receiveShadow = true;
    cabin.add(ring);
  });
}

/* ---- 螺栓（全部实例化） ---- */
{
  // 结构零散螺栓：在避开窗洞的球面上撒布
  const rng = mulberry(15);
  for(let k=0;k<240;k++){
    const phi = Math.acos(2*rng()-1), th = rng()*Math.PI*2;
    const d = new THREE.Vector3().setFromSphericalCoords(1, phi, th);
    let ok = true;
    for(const w of windows){
      const lim = Math.atan((w.radiusMax+0.12)/(R_SHELL-0.05));
      if(d.angleTo(w.dir) < lim){ ok=false; break; }
    }
    if(!ok) continue;
    boltXforms.push({ pos: d.clone().multiplyScalar(R_SHELL+0.008), quat: frameBasis(d) });
  }
  const boltGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.018, 6);
  boltGeo.rotateX(Math.PI/2); // 轴向对齐局部 Z
  const bolts = new THREE.InstancedMesh(boltGeo, MAT.bolt, boltXforms.length);
  const m4=new THREE.Matrix4(), s3=new THREE.Vector3(1,1,1);
  boltXforms.forEach((b,i)=> bolts.setMatrixAt(i, m4.compose(b.pos, b.quat, s3)));
  bolts.castShadow = false; bolts.receiveShadow = true;
  cabin.add(bolts);
}

/* ---- 顶部毂盘与底部设备环 ---- */
{
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.42,0.10,24), MAT.frame);
  hub.position.set(0, R_SHELL-0.10, 0); hub.castShadow=true; hub.receiveShadow=true;
  cabin.add(hub);
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(0.30,0.02,8,40), MAT.dark);
  hubRing.position.set(0, R_SHELL-0.16, 0); hubRing.rotation.x=Math.PI/2;
  cabin.add(hubRing);
  const keel = new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.44,0.09,28), MAT.dark);
  keel.position.set(0, -(R_SHELL-0.10), 0); keel.castShadow=true; keel.receiveShadow=true;
  cabin.add(keel);
}

/* ---- 蓝色扶手（U 形弯管） ---- */
function handrail(thetaDeg, pitchDeg, width=0.52, mat=MAT.railBlue){
  const dir = dirOf(thetaDeg, pitchDeg);
  const q = frameBasis(dir);
  const pts = [
    new THREE.Vector3(-width/2, 0, 0.015),
    new THREE.Vector3(-width/2, 0, 0.10),
    new THREE.Vector3(-width/2+0.04, 0, 0.165),
    new THREE.Vector3(0, 0, 0.185),
    new THREE.Vector3(width/2-0.04, 0, 0.165),
    new THREE.Vector3(width/2, 0, 0.10),
    new THREE.Vector3(width/2, 0, 0.015),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
  const rail = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.016, 10), mat);
  rail.position.copy(dir).multiplyScalar(R_SHELL+0.005);
  rail.quaternion.copy(q);
  rail.castShadow = true;
  cabin.add(rail);
  [-width/2, width/2].forEach(px=>{
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.024,0.028,0.03,10), MAT.railGray);
    foot.geometry.rotateX(Math.PI/2);
    foot.position.copy(new THREE.Vector3(px,0,0.005).applyQuaternion(q).add(rail.position));
    foot.quaternion.copy(q);
    cabin.add(foot);
  });
}
handrail(-20, -26, 0.56);
handrail(46, -8, 0.5);
handrail(-118, 14, 0.46, MAT.railGray);
handrail(160, -12, 0.42);

/* ---- 线缆走线 ---- */
function cableRun(thetaA, pitchA, thetaB, pitchB, sag, r, mat, seed){
  const rng = mulberry(seed);
  const a = dirOf(thetaA,pitchA).multiplyScalar(R_SHELL-0.015);
  const b = dirOf(thetaB,pitchB).multiplyScalar(R_SHELL-0.015);
  const pts=[a];
  const N=5;
  for(let i=1;i<N;i++){
    const t=i/N;
    const p = a.clone().lerp(b,t).normalize().multiplyScalar(R_SHELL-0.015 - sag*0.6*Math.sin(t*Math.PI)*(0.7+rng()*0.6));
    p.add(new THREE.Vector3((rng()-0.5)*0.05,(rng()-0.5)*0.05,(rng()-0.5)*0.05));
    pts.push(p);
  }
  pts.push(b);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r, 7), mat);
  tube.castShadow = true;
  cabin.add(tube);
}
cableRun(-70, 20, 30, 30, 0.10, 0.009, MAT.cable, 21);
cableRun(-70, 20, 30, 30, 0.13, 0.0055, MAT.cableOr, 22);
cableRun(100, -34, 176, -8, 0.09, 0.009, MAT.cable, 23);
cableRun(-160, -30, -90, -38, 0.08, 0.008, MAT.cable, 24);
cableRun(8, 52, 90, 40, 0.12, 0.007, MAT.cableOr, 25);

/* ---- 设备盒 + 标签 + 指示灯 ---- */
const leds = [];
const ledRng = mulberry(73);
function equipBox(thetaDeg, pitchDeg, w,h,d, label){
  const dir = dirOf(thetaDeg, pitchDeg), q = frameBasis(dir);
  const box = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), MAT.box);
  const lab = new THREE.Mesh(new THREE.PlaneGeometry(w*0.74, h*0.58),
    new THREE.MeshBasicMaterial({ map:labelTex(label), color:0x9aa2ac }));
  lab.position.z = d/2+0.002;
  box.add(lab);
  box.position.copy(dir).multiplyScalar(R_SHELL+0.005-d/2);
  box.quaternion.copy(q);
  box.castShadow = true; box.receiveShadow = true;
  cabin.add(box);
  const ledMat = new THREE.MeshStandardMaterial({ color:0x0a0a0a, emissive:0xff3524, emissiveIntensity:2.2 });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.008,8,8), ledMat);
  led.position.copy(new THREE.Vector3(w/2-0.03, h/2-0.03, d/2+0.006).applyQuaternion(q).add(box.position));
  cabin.add(led);
  leds.push({ mat:ledMat, phase:ledRng()*7, base:new THREE.Color(0xff3524) });
}
equipBox(108, -24, 0.34,0.22,0.09, ['CUPOLA','NODE 3']);
equipBox(-32, 34, 0.30,0.20,0.08, ['O₂ 21.0%','P 101.3 kPa']);
equipBox(170, -40, 0.32,0.20,0.09, ['ROBO ARM','CTRL']);
equipBox(-66, -44, 0.26,0.16,0.07, ['CAUTION','THRM COVER']);
// 绿色常亮小灯
{
  const dir = dirOf(120, 26), q = frameBasis(dir);
  const m = new THREE.MeshStandardMaterial({ color:0x0a0a0a, emissive:0x2aff70, emissiveIntensity:1.6 });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.007,8,8), m);
  led.position.copy(dir).multiplyScalar(R_SHELL-0.10);
  cabin.add(led); leds.push({ mat:m, phase:2.4, base:new THREE.Color(0x2aff70) });
}

/* --- 仪器显示屏：自发光读数面板（波形/柱状/字符），舱内始终可读 --- */
function screenTex(seed, title){
  return canvasTex(256,160,(ctx,w,h)=>{
    const rng = mulberry(seed);
    ctx.fillStyle='#0b141d'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(90,150,190,.28)'; ctx.lineWidth=1;
    for(let x=0;x<=w;x+=32){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
    for(let y=0;y<=h;y+=32){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
    ctx.strokeStyle='rgba(140,220,255,.9)'; ctx.lineWidth=2; ctx.beginPath();
    for(let x=0;x<w;x++){
      const y=h*0.42 + Math.sin(x*0.09+seed)*14 + Math.sin(x*0.023+seed*2)*22 + (rng()-0.5)*4;
      x?ctx.lineTo(x,y):ctx.moveTo(x,y);
    }
    ctx.stroke();
    ctx.fillStyle='rgba(120,200,245,.75)';
    for(let i=0;i<10;i++){ const bh=8+rng()*30; ctx.fillRect(12+i*15, h-14-bh, 9, bh); }
    ctx.fillStyle='rgba(200,230,250,.92)';
    ctx.font='600 15px ui-monospace, monospace'; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(title, 10, 8);
    ctx.fillStyle='rgba(110,190,140,.9)';
    ctx.fillText('SYS NOMINAL', 10, 28);
    ctx.fillStyle='rgba(255,90,70,.95)'; ctx.beginPath(); ctx.arc(w-16,16,5,0,7); ctx.fill();
    ctx.strokeStyle='rgba(160,210,240,.5)'; ctx.lineWidth=3; ctx.strokeRect(2,2,w-4,h-4);
  },{wrap:false});
}
function screenPanel(thetaDeg, pitchDeg, w, h, seed, title){
  const dir = dirOf(thetaDeg, pitchDeg);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w,h),
    new THREE.MeshBasicMaterial({ map:screenTex(seed,title) }));
  m.position.copy(dir).multiplyScalar(R_SHELL-0.035);
  m.quaternion.copy(frameBasis(dir));
  cabin.add(m);
}
screenPanel(134, -33, 0.20, 0.125, 31, 'ATT CTRL');
screenPanel(-18, 47, 0.18, 0.11, 47, 'ECLSS O₂');
screenPanel(63, -42, 0.16, 0.10, 59, 'PWR BUS');
screenPanel(-158, -18, 0.15, 0.095, 71, 'TRK AUD');

/* ================================================================
   4. 舱外宇宙
================================================================ */
await step(70, '点亮星海');

/* ---- 星空 ---- */
{
  const N=7000, pos=new Float32Array(N*3), col=new Float32Array(N*3), rng=mulberry(88);
  for(let i=0;i<N;i++){
    const u=rng()*2-1, th=rng()*Math.PI*2;
    const r=Math.sqrt(1-u*u);
    pos[i*3]=r*Math.cos(th)*900; pos[i*3+1]=u*900; pos[i*3+2]=r*Math.sin(th)*900;
    const t=rng();
    const c = t<0.7 ? [0.9,0.93,1] : t<0.9 ? [1,0.95,0.85] : [0.75,0.85,1];
    const b = 0.35+Math.pow(rng(),2.4)*1.4;
    col[i*3]=c[0]*b; col[i*3+1]=c[1]*b; col[i*3+2]=c[2]*b;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  const stars=new THREE.Points(g, new THREE.PointsMaterial({
    size:1.6, sizeAttenuation:false, vertexColors:true, map:starSprTex,
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
  }));
  scene.add(stars);
  // 亮星
  const BN=26, bp=new Float32Array(BN*3);
  for(let i=0;i<BN;i++){
    const u=rng()*2-1, th=rng()*Math.PI*2, r=Math.sqrt(1-u*u);
    bp[i*3]=r*Math.cos(th)*880; bp[i*3+1]=u*880; bp[i*3+2]=r*Math.sin(th)*880;
  }
  const bg=new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(bp,3));
  const bright=new THREE.Points(bg, new THREE.PointsMaterial({
    size:4.2, sizeAttenuation:false, color:0xeef4ff, map:starSprTex,
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
  }));
  scene.add(bright);
  // 银河带
  const mw = canvasTex(1024,512,(ctx,w,h)=>{
    ctx.clearRect(0,0,w,h);
    const mn=makeNoise(64);
    const img=ctx.createImageData(w,h), d=img.data;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const band=Math.exp(-Math.pow((y/h-0.5)/0.16,2));
      const n=mn.fbm(x/70,y/26,{oct:5,per:14.6});
      const a=band*sstep(0.42,0.9,n)*46;
      d[i]=150; d[i+1]=170; d[i+2]=205; d[i+3]=a;
    }
    ctx.putImageData(img,0,0);
  },{wrap:false});
  const mwMesh = new THREE.Mesh(new THREE.SphereGeometry(860,32,16),
    new THREE.MeshBasicMaterial({ map:mw, transparent:true, side:THREE.BackSide, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.8 }));
  mwMesh.rotation.set(0.6, 0.4, 1.05);
  scene.add(mwMesh);
}

/* ---- 轨道参数 ---- */
const P = 220;                       // 基准轨道周期（秒，1× 流速）
let orbT = PRM.t!==null ? PRM.t*P : P*0.855;
let timeScale = [0,1,4,16].includes(PRM.speed) ? PRM.speed : 1;

function greatCircle(d1, d2){
  const u = d1.clone().normalize();
  const n = new THREE.Vector3().crossVectors(d1,d2).normalize();
  const v = new THREE.Vector3().crossVectors(n,u).normalize();
  return {u,v};
}
const earthGC = greatCircle(dirOf(-52,-27), dirOf(75,-10));
const sunGC   = greatCircle(dirOf(-60,45), dirOf(120,-20));
const moonGC  = greatCircle(dirOf(-70,-30), dirOf(40,-18));
const marsGC  = greatCircle(dirOf(30,-22),  dirOf(115,2));
const joveGC  = greatCircle(dirOf(85,-16),  dirOf(-45,-6));
const wingGC  = greatCircle(dirOf(-30,-25), dirOf(62,-12));
const radGC   = greatCircle(dirOf(-150,-60), dirOf(30,70));

const sunDirV = new THREE.Vector3(), earthPosV = new THREE.Vector3();
function orbitPos(gc, ang, R){ return gc.u.clone().multiplyScalar(Math.cos(ang)*R).add(gc.v.clone().multiplyScalar(Math.sin(ang)*R)); }

/* ---- 太阳可见光盘 ---- */
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map:glowTex, color:0xfff2dc, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.95 }));
sunSprite.scale.set(64,64,1);
scene.add(sunSprite);

/* ---- 地球系统 ---- */
await step(82, '点亮地球');
const EARTH_R = 118, EARTH_D = 292;
const earthGroup = new THREE.Group(); scene.add(earthGroup);

const earthUniforms = {
  dayMap:{value:earthDay}, nightMap:{value:earthNight}, specMap:{value:earthSpec}, noiseMap:{value:noiseTex},
  sunDir:{value:new THREE.Vector3(1,0,0)}, camPos:{value:new THREE.Vector3()},
  time:{value:0}, sunTint:{value:new THREE.Color(1,0.97,0.9)},
};
const earthMat = new THREE.ShaderMaterial({
  uniforms: earthUniforms,
  vertexShader:`
    varying vec3 vN; varying vec3 vL; varying vec2 vUv; varying vec3 vWP;
    void main(){
      vN = normalize(mat3(modelMatrix) * normal);
      vL = normalize(position);
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position,1.0);
      vWP = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader:`
    uniform sampler2D dayMap, nightMap, specMap, noiseMap;
    uniform vec3 sunDir, camPos, sunTint;
    uniform float time;
    varying vec3 vN; varying vec3 vL; varying vec2 vUv; varying vec3 vWP;
    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(camPos - vWP);
      float ndl = dot(N, sunDir);
      float dayF = smoothstep(-0.10, 0.32, ndl);
      vec3 dayC = texture2D(dayMap, vUv).rgb;
      vec3 nightC = texture2D(nightMap, vUv).rgb;
      vec3 col = dayC * sunTint * (dayF*1.30) + nightC * (1.0-dayF) * 1.5;
      // 晨昏线暖色带
      float term = smoothstep(-0.06,0.14,ndl)*(1.0-smoothstep(0.14,0.46,ndl));
      col += dayC * vec3(1.0,0.42,0.16) * term * 0.7;
      // 海面阳光反射
      vec3 R = reflect(-sunDir, N);
      float spec = pow(max(dot(R,V),0.0), 36.0) * texture2D(specMap, vUv).r * dayF;
      col += vec3(1.0,0.9,0.75) * spec * 0.9;
      // 极光：高纬带 × 噪声帘幕 × 夜侧
      float lat = abs(normalize(vL).y);
      float band = smoothstep(0.60,0.72,lat)*(1.0-smoothstep(0.80,0.92,lat));
      float n1 = texture2D(noiseMap, vec2(vUv.x*3.0 + time*0.008, vUv.y*1.2 - time*0.003)).r;
      float n2 = texture2D(noiseMap, vec2(vUv.x*6.0 - time*0.013, 0.4)).g;
      float aur = band * smoothstep(0.32,0.8,n1*(0.5+n2)) * (1.0-dayF);
      col += vec3(0.15,1.0,0.45)*aur*1.1 + vec3(0.35,0.25,0.9)*aur*0.35;
      // 大气边缘
      float fr = pow(1.0 - max(dot(N,V),0.0), 2.6);
      col += vec3(0.32,0.58,1.0) * fr * (0.10 + 0.55*dayF);
      // 背光金边（凌日/日出）
      float back = pow(max(dot(V,-sunDir),0.0), 5.0);
      col += vec3(1.0,0.75,0.45) * back * fr * 2.2;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 64), earthMat);
earthGroup.add(earth);

const cloudMat = new THREE.ShaderMaterial({
  uniforms: { map:{value:cloudTex}, sunDir:earthUniforms.sunDir, camPos:earthUniforms.camPos, sunTint:earthUniforms.sunTint },
  transparent: true, depthWrite:false,
  vertexShader: earthMat.vertexShader,
  fragmentShader:`
    uniform sampler2D map; uniform vec3 sunDir, camPos, sunTint;
    varying vec3 vN; varying vec2 vUv; varying vec3 vWP;
    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(camPos - vWP);
      float ndl = dot(N, sunDir);
      float dayF = smoothstep(-0.12, 0.30, ndl);
      vec4 c = texture2D(map, vUv);
      float term = smoothstep(-0.05,0.12,ndl)*(1.0-smoothstep(0.12,0.4,ndl));
      vec3 col = c.rgb * sunTint * (0.06 + dayF*1.25) + vec3(1.0,0.5,0.25)*term*0.5;
      float fr = pow(1.0 - max(dot(N,V),0.0), 2.0);
      float a = c.a * (0.12 + dayF*0.88) * (1.0 - fr*0.5);
      gl_FragColor = vec4(col, a);
    }`,
});
const clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R*1.018, 72, 48), cloudMat);
earthGroup.add(clouds);

const atmoMat = new THREE.ShaderMaterial({
  uniforms: { sunDir:earthUniforms.sunDir, camPos:earthUniforms.camPos },
  transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide,
  vertexShader:`
    varying vec3 vN; varying vec3 vWP;
    void main(){
      vN = normalize(mat3(modelMatrix)*normal);
      vec4 wp = modelMatrix*vec4(position,1.0); vWP=wp.xyz;
      gl_Position = projectionMatrix*viewMatrix*wp;
    }`,
  fragmentShader:`
    uniform vec3 sunDir, camPos;
    varying vec3 vN; varying vec3 vWP;
    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(camPos - vWP);
      float rim = pow(clamp(1.0 + dot(N,V)*1.5, 0.0, 1.0), 3.0);   // 沿地球轮廓峰值
      float dayF = smoothstep(-0.25,0.25,dot(N,sunDir));
      float back = pow(max(dot(V,-sunDir),0.0), 4.0);
      vec3 col = vec3(0.30,0.55,1.0)*rim*(0.10+dayF*0.9) + vec3(1.0,0.7,0.4)*back*rim*1.6;
      gl_FragColor = vec4(col, rim*0.9);
    }`,
});
const atmo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R*1.075, 64, 48), atmoMat);
earthGroup.add(atmo);

/* ---- 行星（共享“白昼 + 晨昏”着色器） ---- */
function planetMat(map, tint=0xffffff){
  return new THREE.ShaderMaterial({
    uniforms:{ dayMap:{value:map}, sunDir:earthUniforms.sunDir, camPos:earthUniforms.camPos, tint:{value:new THREE.Color(tint)} },
    vertexShader: earthMat.vertexShader,
    fragmentShader:`
      uniform sampler2D dayMap; uniform vec3 sunDir, camPos, tint;
      varying vec3 vN; varying vec2 vUv; varying vec3 vWP;
      void main(){
        vec3 N=normalize(vN); vec3 V=normalize(camPos-vWP);
        float ndl=dot(N,sunDir);
        float dayF=smoothstep(-0.10,0.30,ndl);
        vec3 c=texture2D(dayMap,vUv).rgb*tint;
        float term=smoothstep(-0.05,0.12,ndl)*(1.0-smoothstep(0.12,0.4,ndl));
        vec3 col=c*(0.035+dayF*1.25)+c*vec3(1.0,0.5,0.25)*term*0.6;
        float fr=pow(1.0-max(dot(N,V),0.0),2.5);
        col+=vec3(0.5,0.65,0.9)*fr*0.12;
        gl_FragColor=vec4(col,1.0);
      }`,
  });
}
const bodies = [];   // {mesh/group, gc, freq, phase, R, spin}
{
  const mars = new THREE.Mesh(new THREE.SphereGeometry(26,48,32), planetMat(marsTex));
  scene.add(mars); bodies.push({obj:mars, gc:marsGC, freq:0.45, phase:0.242, R:330, spin:0.006});
  const jove = new THREE.Mesh(new THREE.SphereGeometry(58,64,40), planetMat(jovianTex));
  scene.add(jove); bodies.push({obj:jove, gc:joveGC, freq:0.28, phase:3.639, R:540, spin:0.010});
  const moon = new THREE.Mesh(new THREE.SphereGeometry(11,40,28), planetMat(moonTex, 0xd8dade));
  scene.add(moon); bodies.push({obj:moon, gc:moonGC, freq:0.80, phase:1.2, R:205, spin:0.004});
}

/* ---- 写实星球地表：本地生成的等距柱状投影贴图，替换程序化地表 ---- */
await step(48, '铺设写实星球地表');
{
  const texLoader = new THREE.TextureLoader();
  const loadMap = (url, srgb=true) => texLoader.loadAsync(url).then(t=>{
    if(srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
  const [dEarth, nEarth, sEarth, dMars, dJove, dMoon] = await Promise.all([
    loadMap('tex/earth.jpg'), loadMap('tex/earth_night.jpg'), loadMap('tex/earth_spec.jpg', false),
    loadMap('tex/mars.jpg'), loadMap('tex/jupiter.jpg'), loadMap('tex/moon.jpg'),
  ]);
  earthUniforms.dayMap.value   = dEarth;
  earthUniforms.nightMap.value = nEarth;
  earthUniforms.specMap.value  = sEarth;
  bodies[0].obj.material.uniforms.dayMap.value = dMars;
  bodies[1].obj.material.uniforms.dayMap.value = dJove;
  bodies[2].obj.material.uniforms.dayMap.value = dMoon;
}

/* ---- 舱内机械材质 AI 贴图 ---- */
await step(52, '铺设舱内机械材质');
{
  const texLoader2 = new THREE.TextureLoader();
  const loadMap2 = (url, srgb=true) => texLoader2.loadAsync(url).then(t=>{
    if(srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
  const [wallC, wallN, wallR, frameC, frameN, equipC, equipN] = await Promise.all([
    loadMap2('tex/wall.jpg'), loadMap2('tex/wall_n.jpg', false), loadMap2('tex/wall_r.jpg', false),
    loadMap2('tex/frame.jpg'), loadMap2('tex/frame_n.jpg', false),
    loadMap2('tex/equip.jpg'), loadMap2('tex/equip_n.jpg', false),
  ]);
  // 舱壁大面：3×3 平铺；壁板实例：每块板一张完整图（纹理随板走，像真实机加壁板）
  wallC.repeat.set(3,3); wallN.repeat.set(3,3); wallR.repeat.set(3,3);
  const wallPlateC = wallC.clone(); wallPlateC.repeat.set(1,1); wallPlateC.needsUpdate = true;
  const wallPlateN = wallN.clone(); wallPlateN.repeat.set(1,1); wallPlateN.needsUpdate = true;
  const apply = (m, {c, n, r, ns, rough, metal, env})=>{
    m.map = c || null;
    m.normalMap = n || null;
    if(ns !== undefined) m.normalScale.set(ns, ns);
    m.roughnessMap = r || null;
    if(rough !== undefined) m.roughness = rough;
    if(metal !== undefined) m.metalness = metal;
    if(env  !== undefined) m.envMapIntensity = env;
    m.needsUpdate = true;
  };
  const uniq = new Set();
  scene.traverse(o=>{
    if(!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m=>{
      if(!m.userData || !m.userData.tex || uniq.has(m)) return;
      uniq.add(m);
      const kind = m.userData.tex;
      if(kind==='frame')      apply(m, {c:frameC, n:frameN, ns:0.35, rough:0.46, metal:0.55, env:1.2});
      else if(kind==='equip') apply(m, {c:equipC, n:equipN, ns:0.5,  rough:0.6,  metal:0.5,  env:0.8});
      else if(kind==='dark')  apply(m, {c:frameC, n:frameN, ns:0.25, rough:0.7,  metal:0.5,  env:0.4});
      else if(o.isInstancedMesh) apply(m, {c:wallPlateC, n:wallPlateN, r:wallR, ns:0.5, rough:1.0, metal:0.38, env:0.7});
      else                    apply(m, {c:wallC, n:wallN, r:wallR, ns:0.5, rough:1.0, metal:0.38, env:0.7});
    });
  });
}

/* ---- 星云 ---- */
[
  { tex:nebulaTex(611,[80,60,160],[40,140,150]), dir:dirOf(150,25), s:560, o:0.5 },
  { tex:nebulaTex(617,[150,70,90],[60,80,170]),  dir:dirOf(-160,-40), s:480, o:0.42 },
  { tex:nebulaTex(623,[50,110,150],[120,70,150]),dir:dirOf(60,55),  s:640, o:0.38 },
].forEach(n=>{
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:n.tex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:n.o }));
  sp.position.copy(n.dir).multiplyScalar(820);
  sp.scale.set(n.s, n.s*0.72, 1);
  scene.add(sp);
});

/* ---- 空间站外部结构：对接舱段 / 机械臂 / 太阳能帆板 ---- */
const foilTex = canvasTex(256,256,(ctx,w,h)=>{
  ctx.fillStyle='#c9b795'; ctx.fillRect(0,0,w,h);
  const fn=makeNoise(71);
  const img=ctx.getImageData(0,0,w,h), d=img.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const n=fn.fbm(x/30,y/30,{oct:4,per:8.5})*0.5+fn.fbm(x/7,y/7,{oct:3,per:36})*0.5;
    const v=175+(n-0.5)*60;
    d[i]=v; d[i+1]=v*0.9; d[i+2]=v*0.72;
  }
  ctx.putImageData(img,0,0);
});
const panelTex = canvasTex(256,128,(ctx,w,h)=>{
  ctx.fillStyle='#0a1830'; ctx.fillRect(0,0,w,h);
  const pn=makeNoise(83);
  const img=ctx.getImageData(0,0,w,h), d=img.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const n=pn.fbm(x/20,y/20,{oct:3,per:12.8});
    d[i]=10+n*14; d[i+1]=22+n*18; d[i+2]=48+n*30;
  }
  ctx.putImageData(img,0,0);
  ctx.strokeStyle='#c9a44a'; ctx.lineWidth=2.5;
  for(let x=0;x<=w;x+=16){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for(let y=0;y<=h;y+=16){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  ctx.strokeStyle='rgba(160,190,255,.4)';
  for(let x=8;x<w;x+=16){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
});
const whiteMat = new THREE.MeshStandardMaterial({ color:0xcdd3dc, metalness:0.25, roughness:0.6, envMapIntensity:0.6 });
const foilMat  = new THREE.MeshStandardMaterial({ map:foilTex, color:0xd8c8a8, metalness:0.55, roughness:0.45, envMapIntensity:0.8 });
const panelMat = new THREE.MeshStandardMaterial({ map:panelTex, color:0x8a9cc0, metalness:0.4, roughness:0.45, envMapIntensity:0.45 });
const trussMat = new THREE.MeshStandardMaterial({ color:0x9aa0a8, metalness:0.8, roughness:0.45 });

/* 对接舱段（参考图中的天鹅座式舱体） */
const dockModule = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.1,2.1,6.4,24), foilMat);
  dockModule.add(body);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(1.1,2.1,1.6,24), foilMat);
  nose.position.y = 4.0; dockModule.add(nose);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.6,1.1,0.9,20), whiteMat);
  cap.position.y = 5.2; dockModule.add(cap);
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(1.0,1.5,1.4,20), trussMat);
  engine.position.y = -3.9; dockModule.add(engine);
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(1.5,0.7,1.2,20,1,true), new THREE.MeshStandardMaterial({ color:0x3a3d42, metalness:0.9, roughness:0.35, side:THREE.DoubleSide }));
  bell.position.y = -5.0; dockModule.add(bell);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9,16,10,0,Math.PI*2,0,Math.PI/2), whiteMat);
  dish.position.set(2.3,1.5,0); dish.rotation.z = -1.2; dockModule.add(dish);
  for(let k=0;k<4;k++){
    const a=k/4*Math.PI*2;
    const th = new THREE.Mesh(new THREE.ConeGeometry(0.16,0.4,8), trussMat);
    th.position.set(Math.cos(a)*2.2,-2.6,Math.sin(a)*2.2);
    th.rotation.z = Math.cos(a)*0.7; th.rotation.x = -Math.sin(a)*0.7;
    dockModule.add(th);
  }
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.12,2.12,0.5,24,1,true),
    new THREE.MeshStandardMaterial({ color:0x8c3226, metalness:0.5, roughness:0.6, side:THREE.DoubleSide }));
  stripe.position.y = 1.8; dockModule.add(stripe);
  dockModule.traverse(o=>{ if(o.isMesh){ o.castShadow=false; } });
}
scene.add(dockModule);

/* 机械臂（缓慢关节摆动） */
const arm = { group:new THREE.Group(), joints:[] };
{
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.6,1.2,14), whiteMat);
  arm.group.add(base);
  let parent = arm.group, y = 0.6;
  const segs = [4.2, 3.6, 2.8];
  segs.forEach((len,i)=>{
    const joint = new THREE.Group(); joint.position.y = y; parent.add(joint);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42,14,10), trussMat);
    joint.add(ball);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.26,len,12), whiteMat);
    seg.position.y = len/2; joint.add(seg);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,0.3,12), new THREE.MeshStandardMaterial({ color:0xb03428, metalness:0.5, roughness:0.5 }));
    band.position.y = len*0.25; joint.add(band);
    arm.joints.push(joint);
    parent = joint; y = len;
  });
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.22,1.0,10), trussMat);
  tip.position.y = y+0.5; parent.add(tip);
}
scene.add(arm.group);

/* 太阳能帆板翼（周期性掠过） */
const wing = new THREE.Group();
{
  const truss = new THREE.Mesh(new THREE.BoxGeometry(46,0.5,0.5), trussMat);
  wing.add(truss);
  [-1,1].forEach(sx=>{
    [-1,1].forEach(sz=>{
      const p = new THREE.Mesh(new THREE.BoxGeometry(10.5,0.06,4.6), panelMat);
      p.position.set(sx*16.5, 0, sz*2.6);
      wing.add(p);
      const p2 = new THREE.Mesh(new THREE.BoxGeometry(10.5,0.06,4.6), panelMat);
      p2.position.set(sx*16.5 + sx*10.8, 0, sz*2.6);
      wing.add(p2);
    });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,6.5,8), trussMat);
    mast.rotation.x = Math.PI/2; mast.position.set(sx*11, 0, 0);
    wing.add(mast);
  });
}
scene.add(wing);

/* 散热器板阵（另一组外部结构，沿不同轨道掠过天顶/天底方向） */
const rad = new THREE.Group();
{
  const spine = new THREE.Mesh(new THREE.BoxGeometry(20,0.35,0.35), trussMat);
  rad.add(spine);
  const radMat = new THREE.MeshStandardMaterial({ color:0xe3e7ec, metalness:0.35, roughness:0.5, envMapIntensity:0.7 });
  for(let i=-1;i<=1;i++){
    const p = new THREE.Mesh(new THREE.BoxGeometry(5.4,0.1,7.2), radMat);
    p.position.set(i*6.6, 0, 4.0); rad.add(p);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(5.4,0.1,7.2), radMat);
    p2.position.set(i*6.6, 0, -4.0); rad.add(p2);
  }
  const radMast = new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,5,8), trussMat);
  radMast.rotation.x = Math.PI/2; rad.add(radMast);
}
scene.add(rad);

/* ================================================================
   5. 光影系统：太阳光 / 地球反照 / 星光 + 光柱 + 尘埃
================================================================ */
await step(90, '校准舱内光影');
const sunLight = new THREE.DirectionalLight(0xffffff, 0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048,2048);
sunLight.shadow.camera.near = 2; sunLight.shadow.camera.far = 22;
const sc = 3.2;
sunLight.shadow.camera.left=-sc; sunLight.shadow.camera.right=sc;
sunLight.shadow.camera.top=sc; sunLight.shadow.camera.bottom=-sc;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.02;
scene.add(sunLight); scene.add(sunLight.target);

const earthShine = new THREE.DirectionalLight(0x7fa8d8, 0);
scene.add(earthShine); scene.add(earthShine.target);

const starLight = new THREE.HemisphereLight(0x4a5a72, 0x161920, 0.36);
scene.add(starLight);
const baseAmb = new THREE.AmbientLight(0x3d4653, 0.55);
scene.add(baseAmb);

const fillLight = new THREE.PointLight(0xdfe4ea, 0.55, 6, 1.6);
fillLight.position.set(0.3,0.2,0.2);
scene.add(fillLight);
// 舱内工作灯：斜掠设备区，给灰色仪器与舱壁柔和的明暗层次
const workLight = new THREE.PointLight(0xdfe8f2, 0.5, 4.5, 1.7);
workLight.position.copy(dirOf(128,-12)).multiplyScalar(0.7);
scene.add(workLight);

/* ---- 舷窗光柱（伪体积光：沿光路叠放舷窗形光斑） ---- */
function shaftTexFor(w){
  return canvasTex(256,256,(ctx)=>{
    ctx.clearRect(0,0,256,256);
    ctx.filter='blur(16px)';
    ctx.fillStyle='rgba(255,255,255,.9)';
    ctx.beginPath();
    if(w.def.kind==='circle'){ ctx.arc(128,128, w.def.r*110, 0, 7); }
    else {
      const d=w.def, pts=[[-d.bh,-d.hh],[d.bh,-d.hh],[d.th,d.hh],[-d.th,d.hh]];
      pts.forEach((p,i)=>{ const x=128+p[0]*110, y=128-p[1]*110; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.closePath();
    }
    ctx.fill();
  },{wrap:false});
}
const shafts = [];
windows.forEach(w=>{
  const tex = shaftTexFor(w);
  const planes = [];
  for(let k=0;k<4;k++){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1,1),
      new THREE.MeshBasicMaterial({ map:tex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0, side:THREE.DoubleSide }));
    scene.add(m); planes.push(m);
  }
  shafts.push({ w, planes });
});

/* ---- 舱内尘埃 ---- */
const DUST_N = 550;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N*3), dustVel = new Float32Array(DUST_N*3);
{
  const rng = mulberry(41);
  for(let i=0;i<DUST_N;i++){
    const r = Math.pow(rng(),0.5)*1.15, u=rng()*2-1, th=rng()*Math.PI*2, rr=Math.sqrt(1-u*u);
    dustPos[i*3]=rr*Math.cos(th)*r; dustPos[i*3+1]=u*r; dustPos[i*3+2]=rr*Math.sin(th)*r;
    dustVel[i*3]=(rng()-0.5)*0.006; dustVel[i*3+1]=(rng()-0.5)*0.005; dustVel[i*3+2]=(rng()-0.5)*0.006;
  }
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos,3));
const dustMat = new THREE.PointsMaterial({ size:0.0055, color:0xdce8ff, transparent:true, opacity:0.0,
  blending:THREE.AdditiveBlending, depthWrite:false, map:starSprTex });
const dust = new THREE.Points(dustGeo, dustMat);
scene.add(dust);

/* ================================================================
   6. 环境音（WebAudio 现场合成：低频轰鸣 + 气流 + 偶尔蜂鸣）
================================================================ */
const audio = { ctx:null, master:null, on:false };
function initAudio(){
  if(audio.ctx) return;
  const rng = mulberry(181);
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  audio.ctx = ctx;
  const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  audio.master = master;
  // 布朗噪声
  const len = ctx.sampleRate*4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0); let last=0;
  for(let i=0;i<len;i++){ const w=rng()*2-1; last=(last+0.02*w)/1.02; ch[i]=last*3.2; }
  const rum = ctx.createBufferSource(); rum.buffer=buf; rum.loop=true;
  const lp = ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=130;
  const rumG = ctx.createGain(); rumG.gain.value=0.55;
  rum.connect(lp).connect(rumG).connect(master); rum.start();
  // 气流嘶声
  const buf2 = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch2 = buf2.getChannelData(0);
  for(let i=0;i<len;i++) ch2[i]=rng()*2-1;
  const hiss = ctx.createBufferSource(); hiss.buffer=buf2; hiss.loop=true;
  const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=750; bp.Q.value=0.6;
  const hissG = ctx.createGain(); hissG.gain.value=0.028;
  hiss.connect(bp).connect(hissG).connect(master); hiss.start();
  // 缓慢呼吸 LFO
  const lfo = ctx.createOscillator(); lfo.frequency.value=0.06;
  const lfoG = ctx.createGain(); lfoG.gain.value=0.10;
  lfo.connect(lfoG).connect(rumG.gain); lfo.start();
  // 偶发蜂鸣
  (function beep(){
    setTimeout(()=>{
      if(audio.on){
        const o=ctx.createOscillator(), g=ctx.createGain();
        o.type='sine'; o.frequency.value = rng()<0.5?740:1175;
        g.gain.setValueAtTime(0, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.045, ctx.currentTime+0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.5);
        o.connect(g).connect(master); o.start(); o.stop(ctx.currentTime+0.6);
        if(rng()<0.3) setTimeout(()=>{ if(audio.on){
          const o2=ctx.createOscillator(), g2=ctx.createGain();
          o2.type='sine'; o2.frequency.value=988;
          g2.gain.setValueAtTime(0, ctx.currentTime);
          g2.gain.linearRampToValueAtTime(0.035, ctx.currentTime+0.03);
          g2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.4);
          o2.connect(g2).connect(master); o2.start(); o2.stop(ctx.currentTime+0.5);
        }}, 650);
      }
      beep();
    }, 16000 + rng()*24000);
  })();
}
function setAudio(on){
  audio.on = on;
  document.getElementById('audioBtn').classList.toggle('on', on);
  if(on){ initAudio(); audio.ctx.resume(); }
  if(audio.master) audio.master.gain.linearRampToValueAtTime(on?0.85:0, audio.ctx.currentTime+1.2);
}
document.getElementById('audioBtn').addEventListener('click', ()=>setAudio(!audio.on));

/* ================================================================
   7. 交互：自由环视 / 点击聚焦 / 变焦 / 流速
================================================================ */
const view = { yaw:-46, pitch:-20, tYaw:-46, tPitch:-20, roll:0, fov:71, tFov:71 };
if(PRM.view){ const [vy,vp]=PRM.view.split(',').map(Number); if(!isNaN(vy)) view.yaw=view.tYaw=vy; if(!isNaN(vp)) view.pitch=view.tPitch=vp; }
const focus = { active:null, tween:0, from:{pos:new THREE.Vector3(), q:new THREE.Quaternion()},
                to:{pos:new THREE.Vector3(), q:new THREE.Quaternion()}, dir:1, home:{pos:new THREE.Vector3(), q:new THREE.Quaternion()} };
const baseCamPos = new THREE.Vector3(0,0,0);

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let dragging=false, dragMoved=0, dragStart={x:0,y:0}, lastP={x:0,y:0}, dragT=0;
const mousePar = {x:0,y:0};

const el = renderer.domElement;
const arrowKeys = new Set();
const arrowCodes = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const isTypingTarget = target => target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

function updateArrowLook(dt){
  if(!arrowKeys.size) return;
  let x = Number(arrowKeys.has('ArrowRight')) - Number(arrowKeys.has('ArrowLeft'));
  let y = Number(arrowKeys.has('ArrowUp')) - Number(arrowKeys.has('ArrowDown'));
  if(!x && !y) return;
  const length = Math.hypot(x, y);
  x /= length; y /= length;
  const step = (focus.active ? 30 : 48) * (view.fov/71) * dt;
  if(focus.active){
    focus.lookYaw = clamp((focus.lookYaw||0) + x*step, -30, 30);
    focus.lookPitch = clamp((focus.lookPitch||0) - y*step, -22, 22);
  } else {
    view.tYaw += x*step;
    view.tPitch = clamp(view.tPitch + y*step*0.8, -86, 86);
  }
}

el.addEventListener('pointerdown', e=>{
  dragging=true; dragMoved=0; dragT=performance.now();
  dragStart={x:e.clientX,y:e.clientY}; lastP={x:e.clientX,y:e.clientY};
  el.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
  hideIntro();
});
el.addEventListener('pointermove', e=>{
  mousePar.x = (e.clientX/innerWidth)*2-1;
  mousePar.y = (e.clientY/innerHeight)*2-1;
  if(!dragging) return;
  const dx=e.clientX-lastP.x, dy=e.clientY-lastP.y;
  lastP={x:e.clientX,y:e.clientY};
  dragMoved += Math.abs(dx)+Math.abs(dy);
  const k = 0.16 * (view.fov/71);
  if(focus.active && focus.tween>=1){
    // 聚焦状态下小幅环顾
    focus.lookYaw = clamp((focus.lookYaw||0)+dx*k*0.5, -30, 30);
    focus.lookPitch = clamp((focus.lookPitch||0)+dy*k*0.5, -22, 22);
  } else {
    view.tYaw   -= dx*k;
    view.tPitch  = clamp(view.tPitch + dy*k*0.7, -86, 86);
  }
});
el.addEventListener('pointerup', e=>{
  dragging=false; stage.classList.remove('dragging');
  const quick = performance.now()-dragT < 500;
  if(dragMoved < 8 && quick) handleClick(e);
});
el.addEventListener('pointercancel', ()=>{ dragging=false; stage.classList.remove('dragging'); });
el.addEventListener('wheel', e=>{
  e.preventDefault();
  view.tFov = clamp(view.tFov + e.deltaY*0.02, 50, 80);
},{passive:false});
el.addEventListener('contextmenu', e=>{ e.preventDefault(); if(focus.active) unfocus(); });
addEventListener('keydown', e=>{
  if(arrowCodes.has(e.code) && !isTypingTarget(e.target)){
    e.preventDefault();
    arrowKeys.add(e.code);
    hideIntro();
    pokeHud();
  }
  if(e.key==='Escape' && focus.active) unfocus();
  if(e.key==='1') setSpeed(1); if(e.key==='2') setSpeed(4); if(e.key==='3') setSpeed(16);
  if(e.key==='m'||e.key==='M') setAudio(!audio.on);
});
addEventListener('keyup', e=>{ arrowKeys.delete(e.code); });
addEventListener('blur', ()=>{ arrowKeys.clear(); });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) arrowKeys.clear(); });

function windowById(id){ return windows.find(w=>w.id===id); }
function focusWindow(w){
  if(!w) return;
  focus.active = w; focus.tween = 0; focus.dir = 1; focus.lookYaw=0; focus.lookPitch=0;
  focus.from.pos.copy(camRig.position);
  focus.from.q.copy(camera.quaternion);
  const n = w.dir.clone();
  focus.to.pos.copy(w.center).add(n.clone().multiplyScalar(-0.92));
  focus.to.pos.y += 0.02;
  const m = new THREE.Matrix4().lookAt(focus.to.pos, w.center.clone().add(n.multiplyScalar(6)), new THREE.Vector3(0,1,0));
  focus.to.q.setFromRotationMatrix(m);
  toast('W-'+(windows.indexOf(w)+1)+' · 再次点击空白处或按 ESC 返回');
}
function unfocus(){
  if(!focus.active) return;
  focus.dir = -1; focus.tween = 0;
  focus.from.pos.copy(camRig.position);
  focus.from.q.copy(camera.quaternion);
  focus.to.pos.set(0,0,0);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0,0,0), dirOf(view.tYaw, view.tPitch), new THREE.Vector3(0,1,0));
  focus.to.q.setFromRotationMatrix(m);
  toast('');
}
function handleClick(e){
  pointerNdc.set((e.clientX/innerWidth)*2-1, -(e.clientY/innerHeight)*2+1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(windows.map(w=>w.hit), false);
  if(hits.length){ focusWindow(windowById(hits[0].object.userData.winId)); }
  else if(focus.active) unfocus();
}

/* 流速按钮 */
function setSpeed(s){
  timeScale = s;
  document.querySelectorAll('#speedGrp button').forEach(b=>b.classList.toggle('on', +b.dataset.speed===s));
}
document.querySelectorAll('#speedGrp button').forEach(b=> b.addEventListener('click', ()=>setSpeed(+b.dataset.speed)));
setSpeed(timeScale);

/* HUD 自动隐藏 */
const hud=document.getElementById('hud'), hint=document.getElementById('hint'), toastEl=document.getElementById('toast');
let hudTimer=null, toastTimer=null;
function pokeHud(){
  if(PRM.hideui || PRM.hud) return;
  hud.classList.add('show');
  clearTimeout(hudTimer); hudTimer=setTimeout(()=>hud.classList.remove('show'), 3200);
}
addEventListener('pointermove', pokeHud);
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.toggle('show', !!msg);
  clearTimeout(toastTimer); if(msg) toastTimer=setTimeout(()=>toastEl.classList.remove('show'), 3000);
}
let introHidden=false;
function hideIntro(){
  if(introHidden) return; introHidden=true;
  document.getElementById('intro').classList.remove('show');
  setTimeout(()=>hint.classList.remove('show'), 1200);
}

/* ================================================================
   8. 主循环
================================================================ */
const clock = new THREE.Clock();
const camTargetQ = new THREE.Quaternion();
let snapped = false;
const tmpM = new THREE.Matrix4();
const tmpV3 = new THREE.Vector3();
const upV = new THREE.Vector3(0,1,0);
const COLD = new THREE.Color(0xdfe8ff), WARM = new THREE.Color(0xff7d2a), sunCol = new THREE.Color();
const ambCold = new THREE.Color(0x3d4653), ambWarm = new THREE.Color(0x7a3c1c), fillCold = new THREE.Color(0xc9d2da);
const esColA = new THREE.Color(0x6f9cd8), esColB = new THREE.Color(0x8fb8e8);

let simT = 0;

function frame(){
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  simT += dt;
  window.__fc=(window.__fc||0)+1;
  orbT += dt * timeScale;
  const T = orbT / P;   // 轨道周期数

  /* --- 太阳 / 地球 / 天体位置 --- */
  const sunAng = Math.PI*2 * (T*1.0) + 0.7;
  sunDirV.copy(orbitPos(sunGC, sunAng, 1)).normalize();
  const earthAng = Math.PI*2 * (T*0.97) + 1.35;
  earthPosV.copy(orbitPos(earthGC, earthAng, EARTH_D));
  earthGroup.position.copy(earthPosV);
  earth.rotation.y = simT*0.004 + T*1.2;
  clouds.rotation.y = simT*0.0055 + T*1.5;
  sunSprite.position.copy(sunDirV).multiplyScalar(940);

  bodies.forEach(b=>{
    const a = Math.PI*2*(T*b.freq)+b.phase;
    b.obj.position.copy(orbitPos(b.gc, a, b.R));
    b.obj.rotation.y += b.spin*dt*timeScale;
  });
  // 外部结构
  const md = dirOf(-120, 55);
  dockModule.position.copy(md).multiplyScalar(30)
    .add(new THREE.Vector3(Math.sin(simT*0.05)*1.2, Math.cos(simT*0.04)*0.8, Math.sin(simT*0.033)*1.0));
  dockModule.quaternion.copy(frameBasis(md));
  dockModule.rotateX(simT*0.02); dockModule.rotateZ(Math.sin(simT*0.03)*0.1);
  const ad = dirOf(96, -10);
  arm.group.position.copy(ad).multiplyScalar(26);
  arm.group.quaternion.copy(frameBasis(ad));
  arm.joints.forEach((j,i)=>{
    j.rotation.x = Math.sin(simT*0.07+i*1.7)*0.35 - 0.2;
    j.rotation.z = Math.cos(simT*0.05+i*2.1)*0.25;
  });
  const wingAng = Math.PI*2*(T*0.68)+2.6;
  wing.position.copy(orbitPos(wingGC, wingAng, 62));
  wing.lookAt(0,0,0);
  wing.rotateZ(simT*0.01);
  wing.rotateX(0.5);
  const radAng = Math.PI*2*(T*0.55)+5.0;
  rad.position.copy(orbitPos(radGC, radAng, 70));
  rad.lookAt(0,0,0);
  rad.rotateX(0.35 + simT*0.006);

  /* --- 光照推算 --- */
  const sunEarthAng = sunDirV.angleTo(earthPosV.clone().normalize()); // 0=凌日(食), π=满地球
  const cosPhase = -Math.cos(sunEarthAng);
  const litFrac = clamp((1+cosPhase)/2, 0, 1);                        // 可见地球照亮比例
  const grazing = Math.exp(-Math.pow((sunEarthAng-1.62)/0.5, 2));     // 晨昏附近 → 暖色
  const eclipse = 1 - sstep(0.10, 0.38, sunEarthAng);                 // 太阳躲到地球背后
  sunCol.copy(COLD).lerp(WARM, clamp(grazing*1.15,0,1));
  const sunI = lerp(3.4, 0.0, eclipse) * lerp(1.0, 0.75, grazing);
  sunLight.color.copy(sunCol);
  sunLight.intensity = sunI;
  sunLight.position.copy(sunDirV).multiplyScalar(12);
  sunLight.target.position.set(0,0,0);
  earthShine.position.copy(earthPosV).normalize().multiplyScalar(12);
  earthShine.target.position.set(0,0,0);
  earthShine.intensity = 1.15 * litFrac * (1-eclipse*0.85) + 0.05;
  earthShine.color.copy(esColA).lerp(esColB, litFrac);
  starLight.intensity = 0.36 + eclipse*0.16;
  fillLight.intensity = 0.55 + eclipse*0.20;
  // 晨昏浸染：舱内环境光与补光在日落窗口转暖橙（窄峰，地影中减弱）
  const gWarm = Math.exp(-Math.pow((sunEarthAng-1.62)/0.30, 2)) * (1-eclipse*0.55);
  window.__dbg = { ang:sunEarthAng, eclipse, grazing, gWarm, litFrac };
  baseAmb.color.copy(ambCold).lerp(ambWarm, gWarm*0.85);
  baseAmb.intensity = 0.55 + gWarm*0.22;
  fillLight.color.copy(fillCold).lerp(WARM, gWarm);
  sunSprite.material.opacity = (1-eclipse)*0.95;
  bloom.strength = 0.5 + eclipse*0.25 + grazing*0.1;

  // 地球着色器 uniform
  earthUniforms.sunDir.value.copy(sunDirV);
  earthUniforms.camPos.value.copy(camRig.position);
  earthUniforms.time.value = simT;
  // 地球自身受光色调：只在真正接近日落时才转暖
  const earthWarm = sstep(0.55, 0.95, grazing);
  earthUniforms.sunTint.value.copy(COLD).lerp(WARM, earthWarm);

  /* --- 舷窗光柱 --- */
  const rayDir = sunDirV.clone().negate();   // 光线行进方向
  const shaftBase = clamp(sunI/3.2, 0, 1);
  shafts.forEach(({w, planes})=>{
    const align = Math.max(0, rayDir.dot(w.dir));
    const strength = Math.pow(align, 2.2) * shaftBase;
    planes.forEach((m,k)=>{
      const d = 0.16 + k*0.40;
      m.position.copy(w.center).add(rayDir.clone().multiplyScalar(d));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), rayDir);
      const s = w.radiusMax*2 * (1 + d*0.30);
      m.scale.set(s,s,1);
      // 侧视时衰减，避免悬浮亮片的穿帮感
      const toCam = camRig.position.clone().sub(m.position).normalize();
      const face = 0.06 + 0.94*Math.abs(toCam.dot(rayDir));
      m.material.opacity = sstep(0.10, 0.35, strength) * Math.pow(1-d/1.6, 2) * 0.045 * face;
      m.material.color.copy(sunCol);
    });
  });
  dustMat.opacity = 0.06 + shaftBase*0.30;
  {
    const pa = dustGeo.attributes.position;
    for(let i=0;i<DUST_N;i++){
      let x=pa.array[i*3]+dustVel[i*3]*dt*60*0.016, y=pa.array[i*3+1]+dustVel[i*3+1]*dt*60*0.016, z=pa.array[i*3+2]+dustVel[i*3+2]*dt*60*0.016;
      const r2=x*x+y*y+z*z;
      if(r2>1.32){ x*=-0.9; y*=-0.9; z*=-0.9; }
      pa.array[i*3]=x; pa.array[i*3+1]=y; pa.array[i*3+2]=z;
    }
    pa.needsUpdate = true;
  }

  /* --- 相机：呼吸浮动 + 视差 + 聚焦补间 --- */
  updateArrowLook(dt);
  const drift = focus.active ? 0.35 : 1;
  baseCamPos.set(
    Math.sin(simT*0.31)*0.018*drift,
    Math.sin(simT*0.23+1.7)*0.015*drift,
    Math.cos(simT*0.27+0.6)*0.018*drift
  );
  if(focus.active){
    focus.tween = clamp(focus.tween + dt/1.7, 0, 1);
    const e = easeIO(focus.tween);
    camRig.position.lerpVectors(focus.from.pos, focus.to.pos, e).add(baseCamPos);
    camera.quaternion.slerpQuaternions(focus.from.q, focus.to.q, e);
    if(focus.dir===1 && focus.tween>=1){
      // 聚焦后小幅环顾
      const ly = (focus.lookYaw||0)*D2R + mousePar.x*0.03, lp = (focus.lookPitch||0)*D2R + mousePar.y*0.02;
      const q = focus.to.q.clone();
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-lp, -ly, 0, 'YXZ')));
      camera.quaternion.slerp(q, Math.min(1, dt*5));
    }
    if(focus.dir===-1 && focus.tween>=1){ focus.active=null; }
  } else {
    // 凝视倾靠：沿视线方向微位移，转头时窗框与舱外景产生真实视差
    const ld = dirOf(view.yaw, view.pitch);
    tmpV3.set(ld.x, ld.y*0.35, ld.z).multiplyScalar(0.13);
    tmpV3.x += mousePar.x*0.025; tmpV3.y += -mousePar.y*0.018;
    tmpV3.add(baseCamPos);
    if(PRM.snap) camRig.position.copy(tmpV3);
    else camRig.position.lerp(tmpV3, Math.min(1, dt*3));
  }
  if(!focus.active){
    if(PRM.snap){ view.yaw=view.tYaw; view.pitch=view.tPitch; }
    view.yaw   += (view.tYaw-view.yaw)*Math.min(1, dt*11);
    view.pitch += (view.tPitch-view.pitch)*Math.min(1, dt*11);
    const fwd = dirOf(view.yaw + mousePar.x*2.2, view.pitch - mousePar.y*1.6);
    tmpM.lookAt(new THREE.Vector3(0,0,0), fwd, upV);
    camTargetQ.setFromRotationMatrix(tmpM);
    if(PRM.snap && !snapped){ snapped=true; camera.quaternion.copy(camTargetQ); }
    const roll = Math.sin(simT*0.19)*0.006;
    camTargetQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), roll));
    camera.quaternion.slerp(camTargetQ, Math.min(1, dt*8));
  }
  view.fov += (view.tFov-view.fov)*Math.min(1, dt*6);
  if(Math.abs(view.fov-camera.fov)>0.01){ camera.fov=view.fov; camera.updateProjectionMatrix(); }

  // LED 呼吸闪烁
  leds.forEach(l=>{ l.mat.emissiveIntensity = 1.2 + Math.sin(simT*1.4+l.phase)*0.9; });

  composer.render();
}

/* ---- 胶片颗粒 ---- */
const grainCtx = document.getElementById('grain').getContext('2d');
const grainTiles = [];
{
  const rng = mulberry(97);
  for(let t=0;t<4;t++){
    const c=document.createElement('canvas'); c.width=160; c.height=90;
    const g=c.getContext('2d'); const img=g.createImageData(160,90);
    for(let i=0;i<img.data.length;i+=4){ const v=rng()*255|0; img.data[i]=img.data[i+1]=img.data[i+2]=v; img.data[i+3]=255; }
    g.putImageData(img,0,0); grainTiles.push(c);
  }
}
let grainTick=0;
(function grainLoop(){
  requestAnimationFrame(grainLoop);
  if(++grainTick%3) return;
  grainCtx.clearRect(0,0,160,90);
  grainCtx.drawImage(grainTiles[(grainTick/3|0)%4],0,0);
})();

/* ---- 自适应 ---- */
addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

/* ================================================================
   9. 启动
================================================================ */
await step(100, '入轨');
document.getElementById('loader').classList.add('done');
frame();
setTimeout(()=>{
  if(PRM.hideui) return;
  if(!PRM.hud){
    document.getElementById('intro').classList.add('show');
    hint.classList.add('show');
    setTimeout(hideIntro, 6500);
  }
}, 900);
if(PRM.hud){ hud.classList.add('show'); hint.classList.add('show'); }
if(PRM.focus){
  const goFocus = ()=>{ focusWindow(windowById(PRM.focus)); if(PRM.snap) focus.tween=1; };
  if(PRM.snap) goFocus(); else setTimeout(goFocus, 1200);
}
window.__cupola = { view, focus, focusWindow, windowById, setSpeed, setT:(t)=>{orbT=t*P;}, unfocus };
if(Q.get('debug')==='1'){
  window.__err='';
  addEventListener('error', e=>{ window.__err = (e.message||'')+' @'+(e.lineno||0); });
  const dv=document.createElement('div');
  dv.style.cssText='position:fixed;left:10px;top:10px;color:#0f0;font:12px monospace;z-index:99;white-space:pre';
  document.body.appendChild(dv);
  setInterval(()=>{
    const p=camRig.position;
    const fw=new THREE.Vector3(0,0,-1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const fth=Math.atan2(fw.x,fw.z)*180/Math.PI, fpi=Math.asin(fw.y)*180/Math.PI;
    const d=window.__dbg||{};
    let s=`pos ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}\nyaw ${view.yaw.toFixed(1)} pitch ${view.pitch.toFixed(1)}\ncamFwd th ${fth.toFixed(1)} pi ${fpi.toFixed(1)}\nfc ${window.__fc||0} err ${window.__err||'-'}\nang ${(d.ang||0).toFixed(2)} ec ${(d.eclipse||0).toFixed(2)} gw ${(d.gWarm||0).toFixed(2)} lit ${(d.litFrac||0).toFixed(2)}\nfocus ${focus.active?focus.active.id:'-'} tween ${focus.tween.toFixed(2)} dirn ${focus.dir}\norbT ${(orbT/P).toFixed(3)}\n`;
    windows.forEach(w=>{
      const v=w.center.clone().project(camera);
      s+=`${w.id}: ndc ${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}\n`;
    });
    [['EARTH',earthGroup.position],['MARS',bodies[0].obj.position],['JOVE',bodies[1].obj.position],['MOON',bodies[2].obj.position],['SUN',sunSprite.position]].forEach(([nm,pos])=>{
      const v=pos.clone().project(camera);
      s+=`${nm}: ndc ${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}\n`;
    });
    dv.textContent=s;
  },500);
}

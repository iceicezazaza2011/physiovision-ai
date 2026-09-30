import {FilesetResolver,PoseLandmarker} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm";

const $=id=>document.getElementById(id);
const video=$("video"),canvas=$("canvas"),ctx=canvas.getContext("2d");

const CFG={reps:10,sets:3,rest:30};
const VISIBILITY_MIN=0.18;
const LOST_FRAME_LIMIT=18;
const REP_DEBOUNCE_MS=700;

let pose,stream,running=false,exercise="elbow",side="left";
let facingMode="user";
let reps=0,setNo=1,phase="ready",resting=false,restEnd=0,lastVideo=-1;
let displayAngle=null,miss=0,lastRepAt=0,logs=[],frames=0,fpsAt=performance.now();

const con=[
  [11,13],[13,15],[12,14],[14,16],[11,12],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28]
];

function ids(){
  const L=side==="left";
  if(exercise==="elbow") return L?[11,13,15]:[12,14,16];
  if(exercise==="shoulder") return L?[23,11,13]:[24,12,14];
  return L?[23,25,27]:[24,26,28];
}

function validPoint(p){
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function visibleEnough(p){
  // MediaPipe may return a low/undefined visibility while the x/y coordinates
  // are still usable. Keep a modest threshold and never reject undefined visibility.
  return validPoint(p) && (p.visibility==null || p.visibility>=VISIBILITY_MIN);
}

function ang(a,b,c){
  if(!validPoint(a)||!validPoint(b)||!validPoint(c)) return null;
  const abx=a.x-b.x, aby=a.y-b.y;
  const cbx=c.x-b.x, cby=c.y-b.y;
  const mag1=Math.hypot(abx,aby), mag2=Math.hypot(cbx,cby);
  if(mag1<1e-6||mag2<1e-6) return null;
  let cosine=(abx*cbx+aby*cby)/(mag1*mag2);
  cosine=Math.max(-1,Math.min(1,cosine));
  return Math.acos(cosine)*180/Math.PI;
}

function limits(){
  if(exercise==="elbow") return {low:70,high:145};
  if(exercise==="shoulder") return {low:35,high:75};
  return {low:100,high:155};
}

function stateForAngle(a){
  if(a==null) return "position";
  const t=limits();
  if(exercise==="squat"){
    if(a<t.low) return "down";
    if(a>t.high) return "up";
    return phase==="ready"?"moving":phase;
  }
  if(a<t.low) return "contracted";
  if(a>t.high) return "extended";
  return phase==="ready"?"moving":phase;
}

function count(a){
  if(resting||a==null)return;
  const t=limits(),now=performance.now();

  if(exercise==="squat"){
    if(a<t.low) phase="down";
    if(a>t.high && phase==="down" && now-lastRepAt>REP_DEBOUNCE_MS){
      phase="up"; rep(now);
    }
  }else{
    if(a<t.low) phase="contracted";
    if(a>t.high && phase==="contracted" && now-lastRepAt>REP_DEBOUNCE_MS){
      phase="extended"; rep(now);
    }
  }
}

function rep(now){
  lastRepAt=now;
  reps++;
  if(reps>=CFG.reps){
    logs.push({time:new Date().toISOString(),exercise,side,set:setNo,reps});
    if(setNo>=CFG.sets){
      phase="complete";
      $("sessionStatus").textContent="ฝึกครบแล้ว";
    }else{
      resting=true;
      restEnd=Date.now()+CFG.rest*1000;
      phase="rest";
    }
  }
}

function nextSet(){
  if(setNo<CFG.sets){
    resting=false; setNo++; reps=0; phase="ready";
    displayAngle=null; miss=0;
  }
}

function ui(){
  const p=Math.min(1,reps/CFG.reps);
  $("repRing").style.setProperty("--p",`${p*360}deg`);
  $("repsBig").textContent=reps;
  $("setNow").textContent=setNo;
  $("angle").textContent=displayAngle==null?"--°":`${Math.round(displayAngle)}°`;
  $("state").textContent=resting?"REST":phase.toUpperCase();

  document.querySelectorAll(".set-dots i").forEach((d,i)=>d.classList.toggle("on",i<setNo));

  if(resting){
    const l=Math.max(0,Math.ceil((restEnd-Date.now())/1000));
    $("restCount").textContent=l;
    $("restOverlay").classList.remove("hidden");
    if(l<=0) nextSet();
  }else{
    $("restOverlay").classList.add("hidden");
  }
}

function draw(r){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const lm=r?.landmarks?.[0];

  if(!lm){
    miss++;
    phase=resting?"rest":"position";
    if(miss>LOST_FRAME_LIMIT) displayAngle=null;
    $("trackingText").textContent="ไม่พบร่างกาย";
    return;
  }

  ctx.lineWidth=3;
  ctx.lineCap="round";
  ctx.strokeStyle="#35e0c3";
  ctx.fillStyle="#ffd166";

  for(const [a,b] of con){
    if(!visibleEnough(lm[a])||!visibleEnough(lm[b])) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x*canvas.width,lm[a].y*canvas.height);
    ctx.lineTo(lm[b].x*canvas.width,lm[b].y*canvas.height);
    ctx.stroke();
  }

  const selected=ids();
  const main=new Set(selected);

  for(let i=0;i<lm.length;i++){
    const p=lm[i];
    if(!visibleEnough(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x*canvas.width,p.y*canvas.height,main.has(i)?7:3,0,Math.PI*2);
    ctx.fill();
  }

  const [a,b,c]=selected;
  const pts=[lm[a],lm[b],lm[c]];
  const usable=pts.every(validPoint);
  const visible=pts.every(visibleEnough);

  if(usable){
    const raw=ang(...pts);
    if(raw!=null && Number.isFinite(raw)){
      // Keep angle responsive but suppress single-frame jitter.
      displayAngle=displayAngle==null?raw:(displayAngle*0.68+raw*0.32);
      miss=0;

      if(visible){
        $("trackingText").textContent=`ตรวจจับร่างกายแล้ว · ${side==="left"?"LEFT":"RIGHT"}`;
        count(displayAngle);
        if(phase==="ready"||phase==="position") phase=stateForAngle(displayAngle);
      }else{
        // Coordinates are usable, but confidence is weak: show the angle,
        // do not count a repetition until confidence improves.
        $("trackingText").textContent=`เห็นข้อต่อ แต่ความมั่นใจต่ำ · ${side==="left"?"LEFT":"RIGHT"}`;
        phase="position";
      }
      return;
    }
  }

  miss++;
  phase=resting?"rest":"position";
  $("trackingText").textContent=`จัดตำแหน่ง ${side==="left"?"ด้านซ้าย":"ด้านขวา"} ให้เห็นครบ`;
  if(miss>LOST_FRAME_LIMIT) displayAngle=null;
}

async function init(){
  $("aiBadge").lastElementChild.textContent="กำลังโหลด AI";
  const v=await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm"
  );
  pose=await PoseLandmarker.createFromOptions(v,{
    baseOptions:{modelAssetPath:"pose_landmarker_lite.task",delegate:"GPU"},
    runningMode:"VIDEO",
    numPoses:1,
    minPoseDetectionConfidence:.5,
    minPosePresenceConfidence:.5,
    minTrackingConfidence:.5
  });
  $("aiBadge").lastElementChild.textContent="AI พร้อมใช้งาน";
}

async function start(){
  try{
    if(!pose) await init();
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:facingMode},width:{ideal:1280},height:{ideal:720}},
      audio:false
    });
    video.srcObject=stream;
    await video.play();
    canvas.width=video.videoWidth;
    canvas.height=video.videoHeight;
    $("message").style.display="none";
    $("cameraControls")?.classList.remove("hidden");
    running=true;
    $("sessionStatus").textContent="กำลังฝึก";
    requestAnimationFrame(loop);
  }catch(e){
    $("message").style.display="flex";
    $("message").innerHTML=`<b>เปิดกล้องไม่สำเร็จ</b><span>${e.message}</span>`;
  }
}

function stop(){
  running=false;
  stream?.getTracks().forEach(t=>t.stop());
  stream=null;
  video.srcObject=null;
  $("cameraControls")?.classList.add("hidden");
  $("sessionStatus").textContent="พร้อมเริ่ม";
  $("message").style.display="flex";
  $("message").innerHTML='<div class="camera-orb">◎</div><b>กล้องปิดอยู่</b><span>กดปุ่มด้านล่างเพื่อเริ่มอีกครั้ง</span><button id="cameraBtn" class="camera-start">เปิดกล้อง</button>';
  $("cameraBtn").onclick=start;
}

function loop(){
  if(!running)return;
  if(video.currentTime!==lastVideo){
    lastVideo=video.currentTime;
    draw(pose.detectForVideo(video,performance.now()));
    frames++;
    const n=performance.now();
    if(n-fpsAt>1000){
      $("fpsLabel").textContent=`${frames} FPS · AI tracking`;
      frames=0; fpsAt=n;
    }
  }
  ui();
  requestAnimationFrame(loop);
}

function reset(){
  reps=0;setNo=1;phase="ready";resting=false;
  displayAngle=null;miss=0;logs=[];lastRepAt=0;
  ui();
}

$("cameraBtn").onclick=start;
$("stopCameraBtn").onclick=stop;
$("switchCameraBtn").onclick=async()=>{
  const wasRunning=!!stream;
  if(wasRunning){
    running=false;
    stream?.getTracks().forEach(t=>t.stop());
    stream=null;
    video.srcObject=null;
  }
  facingMode=facingMode==="user"?"environment":"user";
  await start();
};
$("skipBtn").onclick=nextSet;
$("resetBtn").onclick=reset;

document.querySelectorAll(".exercise").forEach(b=>b.onclick=()=>{
  exercise=b.dataset.exercise;
  document.querySelectorAll(".exercise").forEach(x=>x.classList.toggle("active",x===b));
  $("tipText").textContent=
    exercise==="elbow"?"ยืนให้เห็นช่วงไหล่ ศอก และข้อมือชัดเจน เพื่อการวัดมุมที่แม่นยำ":
    exercise==="shoulder"?"ยืนให้เห็นลำตัว ไหล่ และข้อศอก โดยเว้นพื้นที่ด้านข้างสำหรับยกแขน":
    "ถอยจากกล้องให้เห็นสะโพก เข่า และข้อเท้าครบทั้งสามจุด";
  reset();
});

document.querySelectorAll(".side").forEach(b=>b.onclick=()=>{
  side=b.dataset.side;
  document.querySelectorAll(".side").forEach(x=>x.classList.toggle("active",x===b));
  reset();
});

$("csvBtn").onclick=()=>{
  const rows=[["time","exercise","side","set","reps"],...logs.map(x=>[x.time,x.exercise,x.side,x.set,x.reps])];
  const blob=new Blob(["\ufeff"+rows.map(r=>r.join(",")).join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="workout_session.csv";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
};

ui();

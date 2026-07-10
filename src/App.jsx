import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
const PitchCanvas3D = lazy(() => import("./PitchCanvas3D"));

// ─── Design tokens ──────────────────────────────────────────────────────────
const T = {
  bg:      "#070A0F",
  surface: "#0E1318",
  panel:   "#131920",
  border:  "#1E2733",
  textPri: "#E8EFF7",
  textSec: "#7A8FA6",
  textDim: "#3D5068",
  team0:   "#FF2D6B",
  team1:   "#00D4FF",
  ref:     "#FFB800",
  accent:  "#3D8EF0",
  warn:    "#F59E0B",
};
const TEAM_COLORS = { 0: T.team0, 1: T.team1, 3: T.ref };
const TEAM_NAMES  = { 0: "Team A", 1: "Team B", 3: "Referee" };
const PITCH_W = 105;
const PITCH_H = 68;
const FPS = 25;

// Discard impossible single-frame jumps / unrealistic speeds instead of
// summing/displaying them as real movement. Without this, homography
// glitches (camera pans causing the pitch mapping to jump briefly) get
// counted as the player teleporting at 200-600km/h, inflating distance
// totals by 50%+ and showing absurd "top speed" values.
const MAX_REALISTIC_SPEED_KMH = 38;   // ~fastest recorded football sprints
const MAX_STEP_DIST_M         = 2; 
const MIN_FRAMES_REAL_PLAYER  = 50;  

// ─── Skeleton connections (pairs of joint names) ─────────────────────────────
const SKEL = [
  ["left_shoulder",  "right_shoulder"],
  ["left_shoulder",  "left_elbow"],
  ["left_elbow",     "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow",    "right_wrist"],
  ["left_shoulder",  "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip",       "right_hip"],
  ["left_hip",       "left_knee"],
  ["left_knee",      "left_ankle"],
  ["right_hip",      "right_knee"],
  ["right_knee",     "right_ankle"],
];
const SKEL_JOINTS = [
  "nose",
  "left_shoulder","right_shoulder",
  "left_elbow","right_elbow",
  "left_wrist","right_wrist",
  "left_hip","right_hip",
  "left_knee","right_knee",
  "left_ankle","right_ankle",
];

// ─── CSV parsers ─────────────────────────────────────────────────────────────
function parseTrackingCSV(text) {
  const lines = text.trim().split("\n");
  const hdrs  = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(",");
    const r = {};
    hdrs.forEach((h, i) => r[h] = vals[i]?.trim());
    return {
      frame:      parseInt(r.frame)      || 0,
      tracker_id: parseInt(r.tracker_id) || 0,
      team_id:    parseInt(r.team_id)    ?? 3,
      role:       r.role || "player",
      field_x_m:  parseFloat(r.field_x_m) || 0,
      field_y_m:  parseFloat(r.field_y_m) || 0,
      speed_kmh:  parseFloat(r.speed_kmh) || 0,
    };
  });
}

function parsePoseCSV(text) {
  // Returns Map: "frame_trackerid" → { joint_x, joint_y, ... }
  const lines = text.trim().split("\n");
  const hdrs  = lines[0].split(",").map(h => h.trim());
  const map   = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = line.split(",");
    const r    = {};
    hdrs.forEach((h, i) => r[h] = vals[i]?.trim());
    const key  = `${r.frame}_${r.tracker_id}`;
    const joints = {};
    for (const name of SKEL_JOINTS) {
      const x = parseFloat(r[`${name}_x`]);
      const y = parseFloat(r[`${name}_y`]);
      if (!isNaN(x) && !isNaN(y)) {
        joints[`${name}_x`] = x;
        joints[`${name}_y`] = y;
      }
    }
    if (Object.keys(joints).length > 0) map.set(key, joints);
  }
  return map;
}

function groupByFrame(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.frame)) map.set(r.frame, []);
    map.get(r.frame).push(r);
  }
  return map;
}

// ─── Ghost track filtering ────────────────────────────────────────────────────
// Removes tracker_ids that only appear for a handful of frames. These are
// almost always ByteTrack ID switches (a real player briefly loses tracking
// and gets re-assigned a new ID) or false detections, not real distinct
// players — and they pollute "top distance" / "top speed" rankings if left in.
function filterGhostTracks(allRows, minFrames = MIN_FRAMES_REAL_PLAYER) {
  const frameCounts = new Map();
  for (const r of allRows) {
    frameCounts.set(r.tracker_id, (frameCounts.get(r.tracker_id) || 0) + 1);
  }
  const ghostIds = new Set();
  for (const [id, count] of frameCounts) {
    if (count < minFrames) ghostIds.add(id);
  }
  if (ghostIds.size > 0 && typeof console !== "undefined") {
    console.log(
      `[Cleaning] Dropped ${ghostIds.size} ghost tracker_id(s) with <${minFrames} frames:`,
      [...ghostIds]
    );
  }
  return allRows.filter(r => !ghostIds.has(r.tracker_id));
}

// ─── Player stats ────────────────────────────────────────────────────────────
function buildPlayerStats(allRowsRaw) {
  // Step 1: remove ID-switch ghost tracks before computing anything
  const allRows = filterGhostTracks(allRowsRaw);

  const stats   = new Map();
  const prevPos = new Map();
  let glitchCount = 0;
  let glitchDistTotal = 0;

  for (const r of [...allRows].sort((a,b) => a.frame - b.frame)) {
    if (!stats.has(r.tracker_id)) {
      stats.set(r.tracker_id, {
        tracker_id: r.tracker_id, team_id: r.team_id, role: r.role,
        distance_m: 0, max_speed: 0, speed_sum: 0, speed_n: 0, frames: 0,
        minX:999, maxX:0, minY:999, maxY:0,
      });
    }
    const s = stats.get(r.tracker_id);
    s.frames++;

    // Speed: discard unrealistic readings instead of using them raw —
    // a glitch frame's speed_kmh would otherwise still count toward
    // max_speed / avg_speed even though the underlying movement was fake.
    const speedValid = r.speed_kmh > 0 && r.speed_kmh <= MAX_REALISTIC_SPEED_KMH;
    if (speedValid) {
      if (r.speed_kmh > s.max_speed) s.max_speed = r.speed_kmh;
      s.speed_sum += r.speed_kmh; s.speed_n++;
    }

    // Distance: discard glitch jumps instead of summing them as real movement
    const prev = prevPos.get(r.tracker_id);
    if (prev && prev.frame === r.frame - 1) {
      const stepDist = Math.hypot(r.field_x_m - prev.x, r.field_y_m - prev.y);
      if (stepDist <= MAX_STEP_DIST_M) {
        s.distance_m += stepDist;
      } else {
        glitchCount++;
        glitchDistTotal += stepDist;
      }
    }
    prevPos.set(r.tracker_id, { frame: r.frame, x: r.field_x_m, y: r.field_y_m });
    if (r.field_x_m < s.minX) s.minX = r.field_x_m;
    if (r.field_x_m > s.maxX) s.maxX = r.field_x_m;
    if (r.field_y_m < s.minY) s.minY = r.field_y_m;
    if (r.field_y_m > s.maxY) s.maxY = r.field_y_m;
  }

  if (glitchCount > 0 && typeof console !== "undefined") {
    console.log(
      `[Distance] Discarded ${glitchCount} glitch jumps (${glitchDistTotal.toFixed(1)}m of tracking noise removed)`
    );
  }

  for (const [,s] of stats) {
    s.avg_speed   = s.speed_n > 0 ? +(s.speed_sum/s.speed_n).toFixed(1) : 0;
    s.distance_m  = +s.distance_m.toFixed(1);
    s.max_speed   = +s.max_speed.toFixed(1);
    s.coverage_m2 = Math.round((s.maxX-s.minX)*(s.maxY-s.minY));
    delete s.speed_sum; delete s.speed_n;
  }
  return stats;
}

function buildSpeedEvents(allRows, thr=28) {
  const ev = new Map();
  for (const r of allRows) {
    if (r.speed_kmh >= thr && !ev.has(r.frame))
      ev.set(r.frame, { frame:r.frame, tracker_id:r.tracker_id,
        team_id:r.team_id, speed:r.speed_kmh });
  }
  return [...ev.values()].sort((a,b)=>a.frame-b.frame);
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────
function buildHeatmap(allRows, teamId, gw=60, gh=40) {
  const grid = new Float32Array(gw*gh); let max=0;
  for (const r of allRows) {
    if (r.team_id !== teamId) continue;
    const gx = Math.min(gw-1,Math.max(0,Math.floor((r.field_x_m/PITCH_W)*(gw-1))));
    const gy = Math.min(gh-1,Math.max(0,Math.floor((r.field_y_m/PITCH_H)*(gh-1))));
    grid[gy*gw+gx]++;
    if (grid[gy*gw+gx]>max) max=grid[gy*gw+gx];
  }
  return {grid,gw,gh,max};
}
function drawHeatmap(ctx,hm,teamId,ox,oy,pw,ph) {
  if (!hm||hm.max===0) return;
  const {grid,gw,gh,max}=hm;
  const cw2=pw/gw, ch2=ph/gh;
  const rgb=teamId===0?"255,45,107":"0,212,255";
  for (let gy=0;gy<gh;gy++) for (let gx=0;gx<gw;gx++) {
    const v=grid[gy*gw+gx]; if(!v) continue;
    ctx.fillStyle=`rgba(${rgb},${(Math.pow(v/max,0.55)*0.6).toFixed(3)})`;
    ctx.fillRect(ox+gx*cw2,oy+gy*ch2,cw2+1,ch2+1);
  }
}

// ─── Demo data (22 players + 2 GK + 1 ref — full match) ─────────────────────
function generateDemo() {
  // 4-4-2 vs 4-3-3, realistic starting positions
  const entities = [
    // Team A (pink) — 4-4-2
    {id:1,  team:0, role:"goalkeeper", bx:3,  by:34},
    {id:2,  team:0, role:"player",     bx:18, by:12},
    {id:3,  team:0, role:"player",     bx:18, by:28},
    {id:4,  team:0, role:"player",     bx:18, by:42},
    {id:5,  team:0, role:"player",     bx:18, by:58},
    {id:6,  team:0, role:"player",     bx:32, by:10},
    {id:7,  team:0, role:"player",     bx:32, by:26},
    {id:8,  team:0, role:"player",     bx:32, by:44},
    {id:9,  team:0, role:"player",     bx:32, by:60},
    {id:10, team:0, role:"player",     bx:44, by:24},
    {id:11, team:0, role:"player",     bx:44, by:46},
    // Team B (cyan) — 4-3-3
    {id:12, team:1, role:"goalkeeper", bx:102,by:34},
    {id:13, team:1, role:"player",     bx:87, by:12},
    {id:14, team:1, role:"player",     bx:87, by:28},
    {id:15, team:1, role:"player",     bx:87, by:42},
    {id:16, team:1, role:"player",     bx:87, by:58},
    {id:17, team:1, role:"player",     bx:73, by:18},
    {id:18, team:1, role:"player",     bx:73, by:34},
    {id:19, team:1, role:"player",     bx:73, by:52},
    {id:20, team:1, role:"player",     bx:60, by:14},
    {id:21, team:1, role:"player",     bx:60, by:34},
    {id:22, team:1, role:"player",     bx:60, by:56},
    // Referee
    {id:30, team:3, role:"referee",    bx:52, by:34},
  ];

  const pos = entities.map(e => ({
    x: e.bx, y: e.by,
    vx:(Math.random()-.5)*.35,
    vy:(Math.random()-.5)*.25,
  }));

  // GK bounds — stay near their goal
  const gkBounds = {
    1:  {minX:1,  maxX:18, minY:20, maxY:48},
    12: {minX:88, maxX:104,minY:20, maxY:48},
  };

  const rows = [];
  for (let frame=1; frame<=450; frame++) {
    entities.forEach((e,i) => {
      pos[i].x += pos[i].vx + Math.sin(frame*.04+i*1.1)*.2;
      pos[i].y += pos[i].vy + Math.cos(frame*.055+i*0.9)*.15;
      const b = gkBounds[e.id];
      if (b) {
        pos[i].x = Math.max(b.minX, Math.min(b.maxX, pos[i].x));
        pos[i].y = Math.max(b.minY, Math.min(b.maxY, pos[i].y));
      } else {
        pos[i].x = Math.max(2, Math.min(103, pos[i].x));
        pos[i].y = Math.max(2, Math.min(66,  pos[i].y));
      }
      if (Math.random()<.02) pos[i].vx=(Math.random()-.5)*.5;
      if (Math.random()<.02) pos[i].vy=(Math.random()-.5)*.4;
      const spd = Math.min(38, Math.abs(pos[i].vx*3.6*10 + Math.sin(frame*.1+i)*.4*20));
      rows.push({
        frame, tracker_id:e.id, team_id:e.team, role:e.role,
        field_x_m: +(pos[i].x.toFixed(2)),
        field_y_m: +(pos[i].y.toFixed(2)),
        speed_kmh: +spd.toFixed(1),
      });
    });
  }
  return rows;
}

// Demo pose data — random but structurally valid joints per player per frame
function generateDemoPose(trackingRows) {
  const map = new Map();
  for (const r of trackingRows) {
    if (r.role === "referee") continue;
    const key = `${r.frame}_${r.tracker_id}`;
    const t   = r.frame * 0.1 + r.tracker_id * 0.7;
    map.set(key, {
      nose_x:           0.5 + Math.sin(t)*0.05,
      nose_y:           0.15 + Math.cos(t)*0.03,
      left_shoulder_x:  0.38, left_shoulder_y:  0.3,
      right_shoulder_x: 0.62, right_shoulder_y: 0.3,
      left_elbow_x:     0.28 + Math.sin(t)*0.08,
      left_elbow_y:     0.5  + Math.cos(t)*0.06,
      right_elbow_x:    0.72 - Math.sin(t)*0.08,
      right_elbow_y:    0.5  + Math.cos(t)*0.06,
      left_wrist_x:     0.22 + Math.sin(t+1)*0.1,
      left_wrist_y:     0.68 + Math.cos(t+1)*0.08,
      right_wrist_x:    0.78 - Math.sin(t+1)*0.1,
      right_wrist_y:    0.68 + Math.cos(t+1)*0.08,
      left_hip_x:       0.42, left_hip_y:       0.58,
      right_hip_x:      0.58, right_hip_y:      0.58,
      left_knee_x:      0.38 + Math.sin(t+2)*0.07,
      left_knee_y:      0.76 + Math.cos(t+2)*0.04,
      right_knee_x:     0.62 - Math.sin(t+2)*0.07,
      right_knee_y:     0.76 + Math.cos(t+2)*0.04,
      left_ankle_x:     0.36 + Math.sin(t+3)*0.06,
      left_ankle_y:     0.92 + Math.cos(t+3)*0.03,
      right_ankle_x:    0.64 - Math.sin(t+3)*0.06,
      right_ankle_y:    0.92 + Math.cos(t+3)*0.03,
    });
  }
  return map;
}

// ─── Pitch drawing ────────────────────────────────────────────────────────────
function drawPitch(ctx, cw, ch) {
  const PAD={t:28,b:28,l:28,r:28};
  const pw=cw-PAD.l-PAD.r, ph=ch-PAD.t-PAD.b;
  const ox=PAD.l, oy=PAD.t;
  const grad=ctx.createLinearGradient(ox,oy,ox+pw,oy+ph);
  grad.addColorStop(0,"#1A5C28"); grad.addColorStop(.5,"#1E6B2F"); grad.addColorStop(1,"#1A5C28");
  ctx.fillStyle=grad; ctx.fillRect(ox,oy,pw,ph);
  for (let i=0;i<12;i++) {
    ctx.fillStyle=i%2===0?"rgba(0,0,0,0.055)":"rgba(255,255,255,0.025)";
    ctx.fillRect(ox+(pw/12)*i,oy,pw/12,ph);
  }
  const sc=(xm,ym)=>[ox+(xm/PITCH_W)*pw,oy+(ym/PITCH_H)*ph];
  ctx.strokeStyle="rgba(255,255,255,0.82)"; ctx.lineWidth=1.4; ctx.lineJoin="round";
  const line=(x0,y0,x1,y1)=>{
    const [ax,ay]=sc(x0,y0),[bx,by]=sc(x1,y1);
    ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();
  };
  const dot=(xm,ym,r=3)=>{
    const [cx,cy]=sc(xm,ym);
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle="rgba(255,255,255,0.9)";ctx.fill();
  };
  line(0,0,PITCH_W,0);line(PITCH_W,0,PITCH_W,PITCH_H);
  line(PITCH_W,PITCH_H,0,PITCH_H);line(0,PITCH_H,0,0);
  line(PITCH_W/2,0,PITCH_W/2,PITCH_H); dot(PITCH_W/2,PITCH_H/2);
  const [ccx,ccy]=sc(PITCH_W/2,PITCH_H/2);
  ctx.beginPath();ctx.arc(ccx,ccy,(9.15/PITCH_W)*pw,0,Math.PI*2);ctx.stroke();
  const paY1=(PITCH_H-40.32)/2,paY2=paY1+40.32,paD=16.5;
  line(0,paY1,paD,paY1);line(paD,paY1,paD,paY2);line(paD,paY2,0,paY2);
  line(PITCH_W,paY1,PITCH_W-paD,paY1);line(PITCH_W-paD,paY1,PITCH_W-paD,paY2);line(PITCH_W-paD,paY2,PITCH_W,paY2);
  const gbY1=(PITCH_H-18.32)/2,gbY2=gbY1+18.32;
  line(0,gbY1,5.5,gbY1);line(5.5,gbY1,5.5,gbY2);line(5.5,gbY2,0,gbY2);
  line(PITCH_W,gbY1,PITCH_W-5.5,gbY1);line(PITCH_W-5.5,gbY1,PITCH_W-5.5,gbY2);line(PITCH_W-5.5,gbY2,PITCH_W,gbY2);
  dot(11,PITCH_H/2); dot(PITCH_W-11,PITCH_H/2);
  return {ox,oy,pw,ph,sc};
}

function fieldToCanvas(xm,ym,ox,oy,pw,ph) {
  return [ox+(xm/PITCH_W)*pw, oy+(ym/PITCH_H)*ph];
}

// ─── Skeleton drawing ────────────────────────────────────────────────────────
function drawSkeleton(ctx, cx, cy, joints, color, scale=18) {
  // joints are 0-1 normalised within the player crop
  // we remap them around the player's canvas position
  const pt = (name) => {
    const x = joints[`${name}_x`];
    const y = joints[`${name}_y`];
    if (x==null||y==null||isNaN(x)||isNaN(y)) return null;
    // centre the skeleton: subtract 0.5 so (0.5,0.5) maps to (cx,cy)
    return [cx + (x-0.5)*scale*1.6, cy + (y-0.5)*scale*2.2];
  };

  // Bones
  ctx.lineWidth=1.5; ctx.lineCap="round";
  for (const [a,b] of SKEL) {
    const pa=pt(a), pb=pt(b);
    if (!pa||!pb) continue;
    ctx.strokeStyle=color+"BB";
    ctx.beginPath();ctx.moveTo(pa[0],pa[1]);ctx.lineTo(pb[0],pb[1]);ctx.stroke();
  }

  // Joints
  for (const name of SKEL_JOINTS) {
    const p=pt(name); if (!p) continue;
    const r = name==="nose"?2.5:1.8;
    ctx.beginPath();ctx.arc(p[0],p[1],r,0,Math.PI*2);
    ctx.fillStyle=name==="nose"?"#fff":color+"DD";
    ctx.fill();
  }
}

// ─── PitchCanvas ─────────────────────────────────────────────────────────────
function PitchCanvas({frameMap,frames,currentIdx,playerStats,
  showHeatmap,showTrails,showPose,allRows,heatmaps,
  poseMap,selectedPlayer,onSelectPlayer}) {

  const canvasRef=useRef(null);
  const [hovered,setHovered]=useState(null);

  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas||!frameMap||!frames.length) return;
    const ctx=canvas.getContext("2d");
    const cw=canvas.width,ch=canvas.height;
    ctx.clearRect(0,0,cw,ch);
    ctx.fillStyle=T.bg; ctx.fillRect(0,0,cw,ch);

    const {ox,oy,pw,ph}=drawPitch(ctx,cw,ch);
    const ftc=(x,y)=>fieldToCanvas(x,y,ox,oy,pw,ph);

    if (showHeatmap&&heatmaps) {
      drawHeatmap(ctx,heatmaps[0],0,ox,oy,pw,ph);
      drawHeatmap(ctx,heatmaps[1],1,ox,oy,pw,ph);
    }

    // Trails
    if (showTrails) {
      const trailLen=6;
      const trailMap=new Map();
      const sf=[...frameMap.keys()].sort((a,b)=>a-b);
      for (let i=Math.max(0,currentIdx-trailLen);i<=currentIdx;i++) {
        for (const r of (frameMap.get(sf[i])||[])) {
          if (!trailMap.has(r.tracker_id)) trailMap.set(r.tracker_id,[]);
          trailMap.get(r.tracker_id).push({x:r.field_x_m,y:r.field_y_m,tid:r.team_id});
        }
      }
      for (const [,trail] of trailMap) {
        if (trail.length<2) continue;
        const col=TEAM_COLORS[trail[trail.length-1].tid]||"#fff";
        for (let i=1;i<trail.length;i++) {
          const [x0,y0]=ftc(trail[i-1].x,trail[i-1].y);
          const [x1,y1]=ftc(trail[i].x,trail[i].y);
          ctx.globalAlpha=(i/trail.length)*0.45;
          ctx.strokeStyle=col; ctx.lineWidth=1.8;
          ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
        }
      }
      ctx.globalAlpha=1;
    }

    // Players
    const frame=frames[currentIdx];
    const rows=frameMap.get(frame)||[];

    for (const row of rows) {
      const [cx,cy]=ftc(row.field_x_m,row.field_y_m);
      const col=TEAM_COLORS[row.team_id]||"#aaa";
      const isGK=row.role==="goalkeeper";
      const isRef=row.role==="referee";
      const isSel=selectedPlayer===row.tracker_id;
      const isHov=hovered?.tracker_id===row.tracker_id;
      const r=9;

      // Draw skeleton behind dot if pose available and showPose on
      if (showPose&&poseMap&&!isRef) {
        const key=`${frame}_${row.tracker_id}`;
        const joints=poseMap.get(key);
        if (joints) drawSkeleton(ctx,cx,cy,joints,col,20);
      }

      if (isSel) {
        ctx.beginPath();ctx.arc(cx,cy,r+6,0,Math.PI*2);
        ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke();
        ctx.beginPath();ctx.arc(cx,cy,r+9,0,Math.PI*2);
        ctx.strokeStyle=col+"55";ctx.lineWidth=1;ctx.stroke();
      }
      if (isGK) {
        ctx.beginPath();ctx.arc(cx,cy,r+4,0,Math.PI*2);
        ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.stroke();
      }
      if (row.speed_kmh>22 && row.speed_kmh<=MAX_REALISTIC_SPEED_KMH) {
        const intensity=Math.min((row.speed_kmh-22)/16,1);
        ctx.beginPath();ctx.arc(cx,cy,r+3,0,Math.PI*2);
        ctx.strokeStyle=`rgba(255,220,50,${(intensity*0.75).toFixed(2)})`;
        ctx.lineWidth=2;ctx.stroke();
      }
      ctx.beginPath();ctx.arc(cx+1.5,cy+2,r,0,Math.PI*2);
      ctx.fillStyle="rgba(0,0,0,0.35)";ctx.fill();
      ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
      if (isRef) { ctx.fillStyle=T.ref; }
      else {
        const g=ctx.createRadialGradient(cx-2,cy-2,1,cx,cy,r);
        g.addColorStop(0,col+"EE"); g.addColorStop(1,col+"88");
        ctx.fillStyle=g;
      }
      ctx.fill();
      ctx.strokeStyle=isHov||isSel?"#fff":"rgba(255,255,255,0.55)";
      ctx.lineWidth=isSel?2:1.2; ctx.stroke();
      if (!isRef) {
        ctx.fillStyle="#fff";
        ctx.font="bold 7.5px 'Inter',monospace";
        ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText(row.tracker_id,cx,cy);
      }
    }

    // Hover tooltip
    if (hovered) {
      const [hx,hy]=ftc(hovered.field_x_m,hovered.field_y_m);
      const tw=155,th=60,pad2=8;
      let tx=hx+14,ty=hy-th/2;
      if (tx+tw>cw-8) tx=hx-tw-14;
      if (ty<8) ty=8; if (ty+th>ch-8) ty=ch-th-8;
      ctx.fillStyle="rgba(7,10,15,0.94)";
      ctx.strokeStyle=TEAM_COLORS[hovered.team_id]||"#fff"; ctx.lineWidth=1.5;
      ctx.beginPath();ctx.roundRect(tx,ty,tw,th,7);ctx.fill();ctx.stroke();
      ctx.font="bold 11px 'Inter',monospace"; ctx.fillStyle=T.textPri;
      ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText(`#${hovered.tracker_id} · ${TEAM_NAMES[hovered.team_id]||"?"}`,tx+pad2,ty+pad2);
      ctx.font="10px 'Inter',monospace"; ctx.fillStyle=T.textSec;
      ctx.fillText(`Speed  ${hovered.speed_kmh.toFixed(1)} km/h`,tx+pad2,ty+pad2+17);
      const ps=playerStats?.get(hovered.tracker_id);
      if (ps) {
        ctx.fillText(`Dist   ${ps.distance_m.toFixed(0)} m`,tx+pad2,ty+pad2+30);
        ctx.fillText(`Max    ${ps.max_speed} km/h`,tx+pad2+78,ty+pad2+30);
      }
      const hasPose=poseMap?.has(`${frames[currentIdx]}_${hovered.tracker_id}`);
      if (hasPose) {
        ctx.fillStyle=T.accent;
        ctx.fillText("🦴 pose",tx+pad2,ty+pad2+44);
      }
    }
  },[currentIdx,frameMap,frames,showHeatmap,showTrails,showPose,
     heatmaps,poseMap,selectedPlayer,hovered,playerStats]);

  const handleMouseMove=useCallback((e)=>{
    if (!frameMap||!frames.length) return;
    const canvas=canvasRef.current;
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left)*(canvas.width/rect.width);
    const my=(e.clientY-rect.top)*(canvas.height/rect.height);
    const PAD=28,pw=canvas.width-PAD*2,ph=canvas.height-PAD*2;
    const rows=frameMap.get(frames[currentIdx])||[];
    let closest=null,minD=15;
    for (const r of rows) {
      const [cx,cy]=fieldToCanvas(r.field_x_m,r.field_y_m,PAD,PAD,pw,ph);
      const d=Math.hypot(mx-cx,my-cy);
      if (d<minD){minD=d;closest=r;}
    }
    setHovered(closest);
  },[frameMap,frames,currentIdx]);

  return (
    <canvas ref={canvasRef} width={860} height={540}
      style={{width:"100%",height:"auto",display:"block",
              cursor:hovered?"pointer":"crosshair"}}
      onMouseMove={handleMouseMove}
      onMouseLeave={()=>setHovered(null)}
      onClick={()=>{ if(hovered) onSelectPlayer(p=>p===hovered.tracker_id?null:hovered.tracker_id); }}
    />
  );
}

// ─── StatsPanel ───────────────────────────────────────────────────────────────
function StatsPanel({allRows,frames,currentIdx,playerStats}) {
  const stats=useMemo(()=>{
    if (!allRows||!playerStats) return null;
    let p0=0,p1=0;
    for (const r of allRows) {
      if (r.role==="player"||r.role==="goalkeeper") {
        if (r.team_id===0) p0++; else if (r.team_id===1) p1++;
      }
    }
    const tot=p0+p1||1;
    const td={0:0,1:0},ms={0:0,1:0};
    for (const [,s] of playerStats) {
      if (s.team_id===0||s.team_id===1) {
        td[s.team_id]+=s.distance_m;
        if (s.max_speed>ms[s.team_id]) ms[s.team_id]=s.max_speed;
      }
    }
    const elapsed=frames?Math.round(frames[currentIdx]/FPS):0;
    return {
      p0:Math.round(p0/tot*100), p1:Math.round(p1/tot*100),
      d0:Math.round(td[0]), d1:Math.round(td[1]),
      s0:ms[0].toFixed(1), s1:ms[1].toFixed(1),
      elapsed,
    };
  },[allRows,playerStats,frames,currentIdx]);

  if (!stats) return null;
  const Row=({label,v0,v1,unit="",bar=false,pct=50})=>(
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
        <span style={{color:T.team0,fontWeight:700,fontSize:14}}>{v0}{unit}</span>
        <span style={{color:T.textDim,fontSize:10,textTransform:"uppercase",letterSpacing:1}}>{label}</span>
        <span style={{color:T.team1,fontWeight:700,fontSize:14}}>{v1}{unit}</span>
      </div>
      {bar&&<div style={{height:4,background:T.border,borderRadius:2,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",
          background:`linear-gradient(90deg,${T.team0},${T.team0}88)`,
          borderRadius:2,transition:"width 0.4s ease"}}/>
      </div>}
    </div>
  );
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:16,
                   paddingBottom:12,borderBottom:`1px solid ${T.border}`}}>
        <span style={{fontSize:11,fontWeight:700,color:T.team0,letterSpacing:1}}>TEAM A</span>
        <span style={{fontSize:10,color:T.textDim}}>
          {Math.floor(stats.elapsed/60)}:{String(stats.elapsed%60).padStart(2,"0")}
        </span>
        <span style={{fontSize:11,fontWeight:700,color:T.team1,letterSpacing:1}}>TEAM B</span>
      </div>
      <Row label="Possession" v0={stats.p0} v1={stats.p1} unit="%" bar pct={stats.p0}/>
      <Row label="Distance"   v0={stats.d0} v1={stats.d1} unit=" m"/>
      <Row label="Top Speed"  v0={stats.s0} v1={stats.s1} unit=" km/h"/>
      <div style={{marginTop:8,paddingTop:12,borderTop:`1px solid ${T.border}`,
                   display:"flex",justifyContent:"space-between"}}>
        <span style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:1}}>Frame</span>
        <span style={{fontSize:13,fontWeight:700,color:T.textPri,fontVariantNumeric:"tabular-nums"}}>
          {frames?.[currentIdx]||0} / {frames?.[frames.length-1]||0}
        </span>
      </div>
    </div>
  );
}

// ─── PlayerSidebar ────────────────────────────────────────────────────────────
function PlayerSidebar({playerStats,selectedPlayer,onSelectPlayer,frameMap,frames,currentIdx,poseMap}) {
  const sorted=useMemo(()=>{
    if (!playerStats) return [];
    return [...playerStats.values()].filter(s=>s.role!=="referee")
      .sort((a,b)=>b.distance_m-a.distance_m);
  },[playerStats]);

  const liveMap=useMemo(()=>{
    if (!frameMap||!frames.length) return new Map();
    const m=new Map();
    for (const r of (frameMap.get(frames[currentIdx])||[])) m.set(r.tracker_id,r);
    return m;
  },[frameMap,frames,currentIdx]);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:2,overflowY:"auto",maxHeight:440}}>
      <div style={{fontSize:10,color:T.textDim,textTransform:"uppercase",letterSpacing:1,
                   marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${T.border}`}}>
        Players · {sorted.length}
      </div>
      {sorted.map(s=>{
        const live=liveMap.get(s.tracker_id);
        const isSel=selectedPlayer===s.tracker_id;
        const col=TEAM_COLORS[s.team_id]||"#aaa";
        const rawSpd=live?.speed_kmh||0;
        const spd=rawSpd<=MAX_REALISTIC_SPEED_KMH ? rawSpd : 0;
        const frame=frames?.[currentIdx];
        const hasPose=frame&&poseMap?.has(`${frame}_${s.tracker_id}`);
        return (
          <div key={s.tracker_id}
            onClick={()=>onSelectPlayer(p=>p===s.tracker_id?null:s.tracker_id)}
            style={{padding:"8px 10px",borderRadius:7,cursor:"pointer",
              background:isSel?`${col}18`:"transparent",
              border:`1px solid ${isSel?col+"55":"transparent"}`,
              transition:"all 0.15s ease"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:24,height:24,borderRadius:"50%",
                background:s.role==="goalkeeper"?"transparent":col,
                border:s.role==="goalkeeper"?`2px solid ${col}`:"none",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:9,fontWeight:700,color:s.role==="goalkeeper"?col:"#fff",flexShrink:0}}>
                {s.tracker_id}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                  <span style={{fontSize:11,fontWeight:600,color:T.textPri}}>#{s.tracker_id}</span>
                  <span style={{fontSize:9,color:col,textTransform:"uppercase",letterSpacing:0.5}}>
                    {s.role==="goalkeeper"?"GK":TEAM_NAMES[s.team_id]}
                  </span>
                  {hasPose&&<span style={{fontSize:8,color:T.accent}}>🦴</span>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:4,marginTop:3}}>
                  <div style={{flex:1,height:3,background:T.border,borderRadius:2}}>
                    <div style={{width:`${Math.min(spd/38*100,100)}%`,height:"100%",
                      background:spd>25?T.warn:col,borderRadius:2,transition:"width 0.2s ease"}}/>
                  </div>
                  <span style={{fontSize:9,color:T.textSec,minWidth:32,textAlign:"right",
                                fontVariantNumeric:"tabular-nums"}}>
                    {spd.toFixed(1)}<span style={{fontSize:8,color:T.textDim}}> km/h</span>
                  </span>
                </div>
              </div>
            </div>
            {isSel&&(
              <div style={{marginTop:8,paddingTop:8,borderTop:`1px dashed ${T.border}`,
                           display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 0"}}>
                {[["Dist",`${s.distance_m.toFixed(0)} m`],
                  ["Max spd",`${s.max_speed} km/h`],
                  ["Avg spd",`${s.avg_speed} km/h`],
                  ["Coverage",`${s.coverage_m2} m²`],
                ].map(([k,v])=>(
                  <div key={k}>
                    <div style={{fontSize:9,color:T.textDim}}>{k}</div>
                    <div style={{fontSize:11,fontWeight:600,color:T.textPri}}>{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────
function Timeline({frames,currentIdx,setCurrentIdx,playing,setPlaying,speed,setSpeed,events}) {
  const barRef=useRef(null);
  const seek=useCallback((e)=>{
    const rect=barRef.current.getBoundingClientRect();
    const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    setCurrentIdx(Math.round(pct*(frames.length-1)));
    setPlaying(false);
  },[frames.length,setCurrentIdx,setPlaying]);

  useEffect(()=>{
    const hk=(e)=>{
      if (e.key==="ArrowRight") setCurrentIdx(i=>Math.min(i+1,frames.length-1));
      if (e.key==="ArrowLeft")  setCurrentIdx(i=>Math.max(i-1,0));
      if (e.key===" "){e.preventDefault();setPlaying(p=>!p);}
    };
    window.addEventListener("keydown",hk);
    return ()=>window.removeEventListener("keydown",hk);
  },[frames.length,setCurrentIdx,setPlaying]);

  const pct=frames.length>1?(currentIdx/(frames.length-1))*100:0;
  return (
    <div style={{padding:"12px 16px"}}>
      <div ref={barRef} onClick={seek} style={{
        height:36,background:T.surface,borderRadius:6,position:"relative",
        cursor:"pointer",marginBottom:10,overflow:"hidden",border:`1px solid ${T.border}`}}>
        <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,
          background:`${T.accent}22`,borderRight:`2px solid ${T.accent}`,
          transition:"width 0.05s linear"}}/>
        {events.map((ev,i)=>{
          const ep=frames.length>1?(frames.indexOf(ev.frame)/(frames.length-1))*100:0;
          return <div key={i} title={`#${ev.tracker_id} · ${ev.speed.toFixed(1)} km/h`}
            style={{position:"absolute",left:`${ep}%`,top:4,bottom:4,width:2,
              background:TEAM_COLORS[ev.team_id]||T.ref,opacity:0.7,borderRadius:1,
              transform:"translateX(-50%)"}}/>;
        })}
        <div style={{position:"absolute",left:`${pct}%`,top:-2,bottom:-2,width:3,
          background:T.textPri,borderRadius:2,transform:"translateX(-50%)",
          boxShadow:"0 0 6px rgba(255,255,255,0.4)"}}/>
        <div style={{position:"absolute",left:`${pct}%`,top:"50%",
          transform:"translate(-50%,-50%)",background:T.accent,color:"#fff",
          fontSize:9,padding:"2px 5px",borderRadius:3,fontWeight:700,
          pointerEvents:"none",whiteSpace:"nowrap"}}>
          {frames[currentIdx]||0}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4}}>
          {[["⏮",()=>{setCurrentIdx(0);setPlaying(false);}],
            ["←", ()=>{setCurrentIdx(i=>Math.max(0,i-1));setPlaying(false);}],
            [playing?"⏸":"▶",()=>setPlaying(p=>!p)],
            ["→", ()=>{setCurrentIdx(i=>Math.min(i+1,frames.length-1));setPlaying(false);}],
            ["⏭",()=>{setCurrentIdx(frames.length-1);setPlaying(false);}],
          ].map(([lbl,fn])=>(
            <button key={lbl} onClick={fn} style={{background:T.surface,
              border:`1px solid ${T.border}`,borderRadius:6,color:T.textPri,
              padding:"5px 10px",cursor:"pointer",fontSize:13,fontFamily:"inherit"}}>{lbl}</button>
          ))}
        </div>
        <select value={speed} onChange={e=>setSpeed(+e.target.value)} style={{
          background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,
          color:T.textSec,padding:"5px 8px",fontSize:11,fontFamily:"inherit"}}>
          {[0.25,0.5,1,2,4,8].map(s=><option key={s} value={s}>{s}×</option>)}
        </select>
        <div style={{marginLeft:"auto",fontSize:10,color:T.textDim}}>
          {events.length} sprint events ·
          <span style={{color:T.textSec}}> space / arrow keys</span>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [allRows,        setAllRows]        = useState(null);
  const [frameMap,       setFrameMap]       = useState(null);
  const [frames,         setFrames]         = useState([]);
  const [poseMap,        setPoseMap]        = useState(null);
  const [currentIdx,     setCurrentIdx]     = useState(0);
  const [playing,        setPlaying]        = useState(false);
  const [speed,          setSpeed]          = useState(1);
  const [showHeatmap,    setShowHeatmap]    = useState(false);
  const [showTrails,     setShowTrails]     = useState(true);
  const [showPose,       setShowPose]       = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [usingDemo,      setUsingDemo]      = useState(false);
  const [view3D,         setView3D]         = useState(false);
  const animRef = useRef(null);

  // ── Mode selection (MACRO / PERFORMANCE / FULL) ──
  const [selectedMode,   setSelectedMode]   = useState("PERFORMANCE");
  const [uploadFile,     setUploadFile]     = useState(null);
  const [uploadStatus,   setUploadStatus]   = useState("idle"); // idle | uploading | processing | done | error
  const [jobId,          setJobId]          = useState(null);
  const [jobProgress,    setJobProgress]    = useState(null);
  const [showUploadPanel,setShowUploadPanel]= useState(false);

  const playerStats = useMemo(()=>allRows?buildPlayerStats(allRows):null,[allRows]);
  const heatmaps    = useMemo(()=>allRows?{0:buildHeatmap(allRows,0),1:buildHeatmap(allRows,1)}:null,[allRows]);
  const events      = useMemo(()=>allRows?buildSpeedEvents(allRows,28):[],[allRows]);

  const loadRows = useCallback((rows)=>{
    const fm=groupByFrame(rows);
    const sorted=[...fm.keys()].sort((a,b)=>a-b);
    setAllRows(rows);setFrameMap(fm);setFrames(sorted);
    setCurrentIdx(0);setPlaying(false);
  },[]);

  // ── Upload video to pipeline ──
  const handleVideoUpload = useCallback(async () => {
    if (!uploadFile) return;
    setUploadStatus("uploading");
    const fd = new FormData();
    fd.append("file", uploadFile);
    fd.append("tier", selectedMode);
    fd.append("mode", selectedMode === "MACRO" ? "MACRO" : "RADAR");
    try {
      const res = await fetch("https://your-pipeline-url.zeabur.app/jobs", { method: "POST", body: fd });
      const data = await res.json();
      setJobId(data.job_id);
      setUploadStatus("processing");
      // Poll for completion
      const poll = setInterval(async () => {
        const r2   = await fetch(`/status/${data.job_id}`);
        const info = await r2.json();
        setJobProgress(info);
        if (info.status === "done" || info.status === "failed") {
          clearInterval(poll);
          setUploadStatus(info.status === "done" ? "done" : "error");
          // Auto-load CSV if available
          if (info.status === "done" && info.artifacts?.csv) {
            const csvRes  = await fetch(`/download/${data.job_id}/tracking.csv`);
            const csvText = await csvRes.text();
            setUsingDemo(false);
            loadRows(parseTrackingCSV(csvText));
            // Auto-load pose if FULL mode
            if (selectedMode === "FULL" && info.artifacts?.pose) {
              const poseRes  = await fetch(`/download/${data.job_id}/pose.csv`);
              const poseText = await poseRes.text();
              setPoseMap(parsePoseCSV(poseText));
            }
          }
        }
      }, 3000);
    } catch(err) {
      setUploadStatus("error");
    }
  }, [uploadFile, selectedMode, loadRows]);

  // Load demo on mount
  useEffect(()=>{
    const rows=generateDemo();
    setUsingDemo(true);
    loadRows(rows);
    setPoseMap(generateDemoPose(rows));
  },[loadRows]);

  // Animation loop
  useEffect(()=>{
    if (!playing) return;
    let last=0;
    const ms=Math.round(1000/FPS)/speed;
    const tick=(ts)=>{
      if (ts-last>=ms){
        last=ts;
        setCurrentIdx(i=>{
          if (i>=frames.length-1){setPlaying(false);return i;}
          return i+1;
        });
      }
      animRef.current=requestAnimationFrame(tick);
    };
    animRef.current=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(animRef.current);
  },[playing,speed,frames.length]);

  // Load tracking CSV
  const handleTrackingFile=(e)=>{
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{setUsingDemo(false);loadRows(parseTrackingCSV(ev.target.result));}
      catch(err){alert("tracking.csv parse error: "+err.message);}
    };
    reader.readAsText(f);
  };

  // Load pose CSV
  const handlePoseFile=(e)=>{
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{setPoseMap(parsePoseCSV(ev.target.result));}
      catch(err){alert("pose.csv parse error: "+err.message);}
    };
    reader.readAsText(f);
  };

  const poseLoaded=poseMap&&poseMap.size>0&&!usingDemo;

  return (
    <div style={{background:T.bg,minHeight:"100vh",color:T.textPri,
      fontFamily:"'Inter','Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>

      {/* Top bar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"10px 16px",borderBottom:`1px solid ${T.border}`,background:T.surface}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:20}}>⚽</span>
          <div>
            <div style={{fontWeight:800,fontSize:13,letterSpacing:0.8,color:T.textPri}}>
              TACTICAL REPLAY
              <span style={{marginLeft:8,fontSize:9,padding:"2px 7px",borderRadius:4,fontWeight:600,
                background:selectedMode==="MACRO"?"#1baf7a22":selectedMode==="PERFORMANCE"?"#3D8EF022":"#7F77DD22",
                color:selectedMode==="MACRO"?"#1baf7a":selectedMode==="PERFORMANCE"?T.accent:"#7F77DD",
                border:`1px solid ${selectedMode==="MACRO"?"#1baf7a33":selectedMode==="PERFORMANCE"?T.accent+"33":"#7F77DD33"}`
              }}>{selectedMode}</span>
            </div>
            <div style={{fontSize:10,color:T.textDim,letterSpacing:0.5}}>
              {usingDemo
                ? "Demo · upload match clip or load tracking.csv"
                : `${frames.length} frames · ${allRows?.length||0} detections · ${poseLoaded?`${poseMap.size} pose rows`:"no pose loaded"}`}
            </div>
          </div>
        </div>

        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {/* Upload video button */}
          <button onClick={()=>setShowUploadPanel(v=>!v)} style={{
            background:showUploadPanel?`${T.accent}22`:T.panel,
            border:`1px solid ${showUploadPanel?T.accent:T.border}`,
            borderRadius:6,color:showUploadPanel?T.accent:T.textPri,
            padding:"5px 12px",cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:700}}>
            🎬 Analyze Match
          </button>

          {/* Toggle buttons */}
          {[
            ["🔥 Heatmap", showHeatmap, ()=>setShowHeatmap(v=>!v)],
            ["〰 Trails",  showTrails,  ()=>setShowTrails(v=>!v)],
            ["🦴 Pose",    showPose,    ()=>setShowPose(v=>!v), selectedMode!=="FULL"],
          ].map(([lbl,active,fn,disabled])=>(
            !disabled && <button key={lbl} onClick={fn} style={{
              background:active?`${T.accent}22`:T.surface,
              border:`1px solid ${active?T.accent:T.border}`,
              borderRadius:6,color:active?T.accent:T.textSec,
              padding:"5px 10px",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>
              {lbl}
            </button>
          ))}

          {/* 2D / 3D toggle */}
          <button onClick={()=>setView3D(v=>!v)} style={{
            background: view3D ? `${T.accent}22` : T.surface,
            border:`1px solid ${view3D ? T.accent : T.border}`,
            borderRadius:6, color: view3D ? T.accent : T.textSec,
            padding:"5px 10px", cursor:"pointer", fontSize:11,
            fontFamily:"inherit", fontWeight: view3D ? 700 : 400,
          }}>
            {view3D ? "🌐 3D" : "⬜ 2D"}
          </button>

          {/* Load tracking CSV */}
          <label style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:6,
            padding:"5px 10px",fontSize:11,cursor:"pointer",color:T.accent,fontFamily:"inherit"}}>
            📂 tracking.csv
            <input type="file" accept=".csv" onChange={handleTrackingFile} style={{display:"none"}}/>
          </label>

          {/* Load pose CSV — only show for FULL mode */}
          {selectedMode==="FULL" && <label style={{
            background:poseLoaded?`${T.accent}22`:T.panel,
            border:`1px solid ${poseLoaded?T.accent:T.border}`,
            borderRadius:6,padding:"5px 10px",fontSize:11,cursor:"pointer",
            color:poseLoaded?T.accent:T.textSec,fontFamily:"inherit"}}>
            🦴 pose.csv
            <input type="file" accept=".csv" onChange={handlePoseFile} style={{display:"none"}}/>
          </label>}
        </div>
      </div>

      {/* Upload Panel */}
      {showUploadPanel && (
        <div style={{background:T.panel,borderBottom:`1px solid ${T.border}`,padding:"16px 20px"}}>
          {/* Mode selector */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
            {[
              {key:"MACRO",       label:"Tactical overview",  time:"~3 min GPU",
               desc:"Formations · Heatmaps · Defensive lines",
               color:"#1baf7a", features:["Team heatmaps","Formation detection","Defensive line","Press map"]},
              {key:"PERFORMANCE", label:"Performance analysis",time:"~10 min GPU",
               desc:"Speed · Distance · Per-player CSV",
               color:T.accent, features:["Everything in Tactical","Per-player CSV","Speed & distance","Re-ID tracking"]},
              {key:"FULL",        label:"Full analysis",       time:"~35 min CPU",
               desc:"Everything + Pose estimation",
               color:"#7F77DD", features:["Everything in Performance","Pose estimation","Reliability report","Pose CSV export"]},
            ].map(m=>(
              <div key={m.key} onClick={()=>setSelectedMode(m.key)} style={{
                border:`2px solid ${selectedMode===m.key?m.color:T.border}`,
                borderRadius:10,padding:"12px 14px",cursor:"pointer",
                background:selectedMode===m.key?`${m.color}11`:T.surface,
                transition:"all 0.15s"
              }}>
                <div style={{fontWeight:700,fontSize:12,color:selectedMode===m.key?m.color:T.textPri,marginBottom:3}}>{m.label}</div>
                <div style={{fontSize:10,color:T.textSec,marginBottom:8}}>{m.desc}</div>
                <div style={{fontSize:9,padding:"2px 6px",borderRadius:4,display:"inline-block",
                  background:selectedMode===m.key?`${m.color}22`:T.border,
                  color:selectedMode===m.key?m.color:T.textDim,marginBottom:8}}>{m.time}</div>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  {m.features.map(f=>(
                    <div key={f} style={{fontSize:9,color:T.textSec,display:"flex",alignItems:"center",gap:4}}>
                      <span style={{color:m.color,fontSize:8}}>✓</span>{f}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* File upload */}
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <label style={{flex:1,background:T.surface,border:`1px dashed ${T.border}`,borderRadius:8,
              padding:"10px 14px",cursor:"pointer",textAlign:"center",
              color:uploadFile?T.textPri:T.textDim,fontSize:11,fontFamily:"inherit"}}>
              {uploadFile ? `📹 ${uploadFile.name}` : "📹 Click to select match video (.mp4)"}
              <input type="file" accept="video/mp4,video/*" onChange={e=>setUploadFile(e.target.files[0])}
                style={{display:"none"}}/>
            </label>
            <button onClick={handleVideoUpload}
              disabled={!uploadFile||uploadStatus==="uploading"||uploadStatus==="processing"}
              style={{background:uploadFile?T.accent:"#1E2733",border:"none",
                borderRadius:8,color:"#fff",padding:"10px 20px",cursor:uploadFile?"pointer":"not-allowed",
                fontSize:12,fontWeight:700,fontFamily:"inherit",opacity:uploadFile?1:0.5,
                whiteSpace:"nowrap"}}>
              {uploadStatus==="uploading"?"Uploading...":
               uploadStatus==="processing"?"Processing...":
               uploadStatus==="done"?"✅ Done — reload":"Analyze Match ↗"}
            </button>
          </div>

          {/* Status */}
          {uploadStatus==="processing" && (
            <div style={{marginTop:10,fontSize:11,color:T.textSec,display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:T.accent,
                animation:"pulse 1.5s infinite"}}/>
              Processing with {selectedMode} mode · Job: {jobId?.slice(0,8)}...
              {jobProgress?.status && ` · ${jobProgress.status}`}
            </div>
          )}
          {uploadStatus==="done" && (
            <div style={{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}}>
              {jobId && ["tracking.csv","heatmap.png",selectedMode==="FULL"?"pose.csv":null,
                         "output.mp4"].filter(Boolean).map(f=>(
                <a key={f} href={`/download/${jobId}/${f}`} download style={{
                  fontSize:10,padding:"4px 10px",borderRadius:5,textDecoration:"none",
                  background:`${T.accent}22`,color:T.accent,border:`1px solid ${T.accent}44`}}>
                  ↓ {f}
                </a>
              ))}
            </div>
          )}
          {uploadStatus==="error" && (
            <div style={{marginTop:10,fontSize:11,color:"#F59E0B"}}>
              ⚠️ Processing failed. Check server logs or try again.
            </div>
          )}
        </div>
      )}

      {/* Main layout */}
      <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 220px",gap:0,overflow:"hidden"}}>
        {/* Left: pitch + timeline */}
        <div style={{display:"flex",flexDirection:"column"}}>
          <div style={{flex:1,background:T.bg,borderRight:`1px solid ${T.border}`,position:"relative"}}>
            {view3D ? (
              <Suspense fallback={
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",
                  height:"100%",color:T.textDim,fontSize:12}}>
                  Loading 3D scene...
                </div>
              }>
                <PitchCanvas3D
                  frameMap={frameMap} frames={frames} currentIdx={currentIdx}
                  showTrails={showTrails}
                  selectedPlayer={selectedPlayer}
                  onSelectPlayer={(id)=>setSelectedPlayer(p=>p===id?null:id)}
                  poseMap={poseMap}
                  showSkeleton={showPose}
                />
              </Suspense>
            ) : (
              <PitchCanvas
                frameMap={frameMap} frames={frames} currentIdx={currentIdx}
                playerStats={playerStats} allRows={allRows}
                showHeatmap={showHeatmap} showTrails={showTrails} showPose={showPose}
                heatmaps={heatmaps} poseMap={poseMap}
                selectedPlayer={selectedPlayer} onSelectPlayer={setSelectedPlayer}
              />
            )}
          </div>
          <div style={{borderTop:`1px solid ${T.border}`,borderRight:`1px solid ${T.border}`,
                       background:T.surface}}>
            <Timeline
              frames={frames} currentIdx={currentIdx} setCurrentIdx={setCurrentIdx}
              playing={playing} setPlaying={setPlaying}
              speed={speed} setSpeed={setSpeed} events={events}
            />
          </div>
        </div>

        {/* Right: stats + players */}
        <div style={{display:"flex",flexDirection:"column",background:T.surface,overflowY:"auto"}}>
          <div style={{padding:"14px 14px 10px",borderBottom:`1px solid ${T.border}`}}>
            <StatsPanel allRows={allRows} frames={frames} currentIdx={currentIdx} playerStats={playerStats}/>
          </div>
          <div style={{padding:"12px 14px",flex:1}}>
            <PlayerSidebar
              playerStats={playerStats} selectedPlayer={selectedPlayer}
              onSelectPlayer={setSelectedPlayer}
              frameMap={frameMap} frames={frames} currentIdx={currentIdx}
              poseMap={poseMap}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

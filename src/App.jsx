import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── Design tokens ─────────────────────────────────────────────────────────
const T = {
  bg:        "#070A0F",
  surface:   "#0E1318",
  panel:     "#131920",
  border:    "#1E2733",
  borderHi:  "#2D3F52",
  textPri:   "#E8EFF7",
  textSec:   "#7A8FA6",
  textDim:   "#3D5068",
  team0:     "#FF2D6B",   // hot pink
  team1:     "#00D4FF",   // cyan
  ref:       "#FFB800",   // amber
  accent:    "#3D8EF0",   // blue accent for UI chrome
  good:      "#22C55E",
  warn:      "#F59E0B",
};

const TEAM_COLORS  = { 0: T.team0, 1: T.team1, 3: T.ref };
const TEAM_NAMES   = { 0: "Team A", 1: "Team B", 3: "Referee" };
const PITCH_W = 105;
const PITCH_H = 68;
const FPS_ASSUMED = 25;

// ─── Data utilities ─────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(",");
    const r = {};
    headers.forEach((h, i) => r[h] = vals[i]?.trim());
    return {
      frame:      parseInt(r.frame)       || 0,
      tracker_id: parseInt(r.tracker_id)  || 0,
      team_id:    parseInt(r.team_id)     ?? 3,
      role:       r.role || "player",
      field_x_m:  parseFloat(r.field_x_m) || 0,
      field_y_m:  parseFloat(r.field_y_m) || 0,
      speed_kmh:  parseFloat(r.speed_kmh) || 0,
    };
  });
}

function groupByFrame(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.frame)) map.set(r.frame, []);
    map.get(r.frame).push(r);
  }
  return map;
}

// Per-player aggregated stats across all frames
function buildPlayerStats(allRows) {
  const stats = new Map(); // tracker_id → {...}
  const prevPos = new Map();

  const sorted = [...allRows].sort((a, b) => a.frame - b.frame);
  for (const r of sorted) {
    if (!stats.has(r.tracker_id)) {
      stats.set(r.tracker_id, {
        tracker_id: r.tracker_id,
        team_id:    r.team_id,
        role:       r.role,
        distance_m: 0,
        max_speed:  0,
        avg_speed:  0,
        speed_sum:  0,
        speed_n:    0,
        frames:     0,
        minX: 999, maxX: 0, minY: 999, maxY: 0,
      });
    }
    const s = stats.get(r.tracker_id);
    s.frames++;
    if (r.speed_kmh > s.max_speed) s.max_speed = r.speed_kmh;
    s.speed_sum += r.speed_kmh;
    s.speed_n++;

    const prev = prevPos.get(r.tracker_id);
    if (prev && prev.frame === r.frame - 1) {
      s.distance_m += Math.hypot(r.field_x_m - prev.x, r.field_y_m - prev.y);
    }
    prevPos.set(r.tracker_id, { frame: r.frame, x: r.field_x_m, y: r.field_y_m });

    if (r.field_x_m < s.minX) s.minX = r.field_x_m;
    if (r.field_x_m > s.maxX) s.maxX = r.field_x_m;
    if (r.field_y_m < s.minY) s.minY = r.field_y_m;
    if (r.field_y_m > s.maxY) s.maxY = r.field_y_m;
  }

  for (const [, s] of stats) {
    s.avg_speed   = s.speed_n > 0 ? s.speed_sum / s.speed_n : 0;
    s.distance_m  = Math.round(s.distance_m * 10) / 10;
    s.max_speed   = Math.round(s.max_speed * 10) / 10;
    s.avg_speed   = Math.round(s.avg_speed * 10) / 10;
    s.coverage_m2 = Math.round((s.maxX - s.minX) * (s.maxY - s.minY));
    delete s.speed_sum; delete s.speed_n;
  }
  return stats;
}

function buildPossessionByFrame(frameMap, frames) {
  // returns array [{ frame, team0pct, team1pct }]
  let c0 = 0, c1 = 0;
  return frames.map(f => {
    const rows = frameMap.get(f) || [];
    for (const r of rows) {
      if (r.role === "ball") { r.team_id === 0 ? c0++ : c1++; }
    }
    const tot = c0 + c1 || 1;
    return { frame: f, t0: Math.round(c0/tot*100), t1: Math.round(c1/tot*100) };
  });
}

function buildSpeedEvents(allRows, threshold = 28) {
  // frames where any player exceeded threshold km/h
  const events = new Map();
  for (const r of allRows) {
    if (r.speed_kmh >= threshold && !events.has(r.frame)) {
      events.set(r.frame, { frame: r.frame, tracker_id: r.tracker_id,
        team_id: r.team_id, speed: r.speed_kmh });
    }
  }
  return [...events.values()].sort((a,b) => a.frame - b.frame);
}

// ─── Demo data ───────────────────────────────────────────────────────────────
function generateDemo() {
  const entities = [
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
    {id:30, team:3, role:"referee",    bx:52, by:34},
  ];
  const pos = entities.map(e => ({
    x: e.bx, y: e.by,
    vx:(Math.random()-.5)*.35,
    vy:(Math.random()-.5)*.25,
  }));
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

function drawPitch(ctx, cw, ch) {
  const PAD = { t: 28, b: 28, l: 28, r: 28 };
  const pw = cw - PAD.l - PAD.r;
  const ph = ch - PAD.t - PAD.b;
  const ox = PAD.l, oy = PAD.t;

  // Grass base
  const grad = ctx.createLinearGradient(ox, oy, ox+pw, oy+ph);
  grad.addColorStop(0,   "#1A5C28");
  grad.addColorStop(0.5, "#1E6B2F");
  grad.addColorStop(1,   "#1A5C28");
  ctx.fillStyle = grad;
  ctx.fillRect(ox, oy, pw, ph);

  // Stripe overlay
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i%2===0 ? "rgba(0,0,0,0.055)" : "rgba(255,255,255,0.025)";
    ctx.fillRect(ox + (pw/stripes)*i, oy, pw/stripes, ph);
  }

  const sc = (xm, ym) => [ox + (xm/PITCH_W)*pw, oy + (ym/PITCH_H)*ph];

  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth   = 1.4;
  ctx.lineJoin    = "round";

  const line = (x0,y0,x1,y1) => {
    const [ax,ay] = sc(x0,y0), [bx,by] = sc(x1,y1);
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
  };
  const arc = (xm, ym, rm, a0=0, a1=Math.PI*2) => {
    const [cx,cy] = sc(xm,ym);
    const rx = (rm/PITCH_W)*pw;
    ctx.beginPath(); ctx.arc(cx,cy,rx,a0,a1); ctx.stroke();
  };
  const dot = (xm, ym, r=3) => {
    const [cx,cy] = sc(xm,ym);
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle="rgba(255,255,255,0.9)"; ctx.fill();
  };

  // Boundary
  line(0,0,PITCH_W,0); line(PITCH_W,0,PITCH_W,PITCH_H);
  line(PITCH_W,PITCH_H,0,PITCH_H); line(0,PITCH_H,0,0);
  // Halfway
  line(PITCH_W/2,0, PITCH_W/2,PITCH_H);
  dot(PITCH_W/2, PITCH_H/2);
  arc(PITCH_W/2, PITCH_H/2, 9.15);

  // Penalty areas (left)
  const paY1 = (PITCH_H-40.32)/2, paY2 = paY1+40.32;
  line(0,paY1, 16.5,paY1); line(16.5,paY1, 16.5,paY2); line(16.5,paY2, 0,paY2);
  const gbY1 = (PITCH_H-18.32)/2, gbY2 = gbY1+18.32;
  line(0,gbY1, 5.5,gbY1); line(5.5,gbY1, 5.5,gbY2); line(5.5,gbY2, 0,gbY2);
  dot(11, PITCH_H/2);
  // Penalty areas (right)
  line(PITCH_W,paY1, PITCH_W-16.5,paY1);
  line(PITCH_W-16.5,paY1, PITCH_W-16.5,paY2);
  line(PITCH_W-16.5,paY2, PITCH_W,paY2);
  line(PITCH_W,gbY1, PITCH_W-5.5,gbY1);
  line(PITCH_W-5.5,gbY1, PITCH_W-5.5,gbY2);
  line(PITCH_W-5.5,gbY2, PITCH_W,gbY2);
  dot(PITCH_W-11, PITCH_H/2);
  // Goals (just lines)
  const goalY1 = (PITCH_H-7.32)/2, goalY2 = goalY1+7.32;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  line(0,goalY1, -2.44,goalY1); line(-2.44,goalY1,-2.44,goalY2); line(-2.44,goalY2,0,goalY2);
  line(PITCH_W,goalY1,PITCH_W+2.44,goalY1); line(PITCH_W+2.44,goalY1,PITCH_W+2.44,goalY2);
  line(PITCH_W+2.44,goalY2,PITCH_W,goalY2);

  return { ox, oy, pw, ph, sc };
}

function fieldToCanvas(xm, ym, ox, oy, pw, ph) {
  return [ox + (xm/PITCH_W)*pw, oy + (ym/PITCH_H)*ph];
}

function buildHeatmap(allRows, teamId, gw=60, gh=40) {
  const grid = new Float32Array(gw*gh);
  let max = 0;
  for (const r of allRows) {
    if (r.team_id !== teamId) continue;
    const gx = Math.min(gw-1, Math.max(0, Math.floor((r.field_x_m/PITCH_W)*(gw-1))));
    const gy = Math.min(gh-1, Math.max(0, Math.floor((r.field_y_m/PITCH_H)*(gh-1))));
    grid[gy*gw+gx]++;
    if (grid[gy*gw+gx] > max) max = grid[gy*gw+gx];
  }
  return { grid, gw, gh, max };
}

function drawHeatmap(ctx, hm, teamId, ox, oy, pw, ph) {
  if (!hm || hm.max===0) return;
  const { grid, gw, gh, max } = hm;
  const cw2 = pw/gw, ch2 = ph/gh;
  const rgb = teamId===0 ? "255,45,107" : "0,212,255";
  for (let gy=0; gy<gh; gy++) for (let gx=0; gx<gw; gx++) {
    const v = grid[gy*gw+gx]; if (!v) continue;
    const a = Math.pow(v/max, 0.55) * 0.6;
    ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
    ctx.fillRect(ox+gx*cw2, oy+gy*ch2, cw2+1, ch2+1);
  }
}

// ─── PitchCanvas ─────────────────────────────────────────────────────────────
function PitchCanvas({ frameMap, frames, currentIdx, playerStats,
                       showHeatmap, showTrails, allRows, heatmaps,
                       selectedPlayer, onSelectPlayer }) {
  const canvasRef = useRef(null);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !frameMap || !frames.length) return;
    const ctx = canvas.getContext("2d");
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0,0,cw,ch);

    // Dark surround
    ctx.fillStyle = T.bg;
    ctx.fillRect(0,0,cw,ch);

    const { ox, oy, pw, ph } = drawPitch(ctx, cw, ch);
    const ftc = (x,y) => fieldToCanvas(x, y, ox, oy, pw, ph);

    // Heatmap
    if (showHeatmap && heatmaps) {
      drawHeatmap(ctx, heatmaps[0], 0, ox, oy, pw, ph);
      drawHeatmap(ctx, heatmaps[1], 1, ox, oy, pw, ph);
    }

    // Trails (last 30 frames)
    if (showTrails) {
      const trailLen = 28;
      const trailMap = new Map();
      const sortedFrames = [...frameMap.keys()].sort((a,b)=>a-b);
      const startI = Math.max(0, currentIdx - trailLen);
      for (let i = startI; i <= currentIdx; i++) {
        const rows = frameMap.get(sortedFrames[i]) || [];
        for (const r of rows) {
          if (!trailMap.has(r.tracker_id)) trailMap.set(r.tracker_id, []);
          trailMap.get(r.tracker_id).push({ x: r.field_x_m, y: r.field_y_m, tid: r.team_id });
        }
      }
      for (const [, trail] of trailMap) {
        if (trail.length < 2) continue;
        const col = TEAM_COLORS[trail[trail.length-1].tid] || "#fff";
        for (let i = 1; i < trail.length; i++) {
          const alpha = (i / trail.length) * 0.45;
          const [x0,y0] = ftc(trail[i-1].x, trail[i-1].y);
          const [x1,y1] = ftc(trail[i].x, trail[i].y);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Players
    const frame = frames[currentIdx];
    const rows  = frameMap.get(frame) || [];

    for (const row of rows) {
      const [cx, cy] = ftc(row.field_x_m, row.field_y_m);
      const col  = TEAM_COLORS[row.team_id] || "#aaa";
      const isGK = row.role === "goalkeeper";
      const isRef= row.role === "referee";
      const isSel= selectedPlayer === row.tracker_id;
      const isHov= hovered?.tracker_id === row.tracker_id;
      const r    = isRef ? 7 : isGK ? 9 : 9;

      // Selection ring
      if (isSel) {
        ctx.beginPath(); ctx.arc(cx,cy,r+6,0,Math.PI*2);
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx,cy,r+9,0,Math.PI*2);
        ctx.strokeStyle = col+"66"; ctx.lineWidth = 1; ctx.stroke();
      }

      // GK outer ring
      if (isGK) {
        ctx.beginPath(); ctx.arc(cx,cy,r+4,0,Math.PI*2);
        ctx.strokeStyle = col; ctx.lineWidth=1.5; ctx.stroke();
      }

      // Speed glow
      if (row.speed_kmh > 22) {
        const intensity = Math.min((row.speed_kmh-22)/16, 1);
        ctx.beginPath(); ctx.arc(cx,cy,r+3,0,Math.PI*2);
        ctx.strokeStyle = `rgba(255,220,50,${(intensity*0.75).toFixed(2)})`;
        ctx.lineWidth = 2; ctx.stroke();
      }

      // Shadow
      ctx.beginPath(); ctx.arc(cx+1.5,cy+2,r,0,Math.PI*2);
      ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fill();

      // Body
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
      if (isRef) {
        ctx.fillStyle = T.ref;
      } else {
        const g = ctx.createRadialGradient(cx-2,cy-2,1,cx,cy,r);
        g.addColorStop(0, col+"EE");
        g.addColorStop(1, col+"88");
        ctx.fillStyle = g;
      }
      ctx.fill();
      ctx.strokeStyle = isHov || isSel ? "#fff" : "rgba(255,255,255,0.55)";
      ctx.lineWidth = isSel ? 2 : 1.2;
      ctx.stroke();

      // ID label
      if (!isRef) {
        ctx.fillStyle = "#fff";
        ctx.font = "bold 7.5px 'Inter',monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(row.tracker_id, cx, cy);
      }
    }

    // Hover tooltip
    if (hovered) {
      const [hx,hy] = ftc(hovered.field_x_m, hovered.field_y_m);
      const tw=152, th=58, pad2=8;
      let tx = hx+14, ty = hy-th/2;
      if (tx+tw > cw-8) tx = hx-tw-14;
      if (ty < 8) ty = 8;
      if (ty+th > ch-8) ty = ch-th-8;

      ctx.fillStyle = "rgba(7,10,15,0.94)";
      ctx.strokeStyle = TEAM_COLORS[hovered.team_id]||"#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(tx,ty,tw,th,7); ctx.fill(); ctx.stroke();

      ctx.font = "bold 11px 'Inter',monospace";
      ctx.fillStyle = T.textPri; ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText(`#${hovered.tracker_id} · ${TEAM_NAMES[hovered.team_id]||"?"}`, tx+pad2, ty+pad2);
      ctx.font = "10px 'Inter',monospace"; ctx.fillStyle = T.textSec;
      ctx.fillText(`Speed  ${hovered.speed_kmh.toFixed(1)} km/h`, tx+pad2, ty+pad2+17);

      const ps = playerStats?.get(hovered.tracker_id);
      if (ps) {
        ctx.fillText(`Dist   ${ps.distance_m.toFixed(0)} m`, tx+pad2, ty+pad2+30);
        ctx.fillText(`Max    ${ps.max_speed} km/h`, tx+pad2+76, ty+pad2+30);
      }
    }
  }, [currentIdx, frameMap, frames, showHeatmap, showTrails, heatmaps,
      selectedPlayer, hovered, playerStats]);

  const handleMouseMove = useCallback((e) => {
    if (!frameMap || !frames.length) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;

    const PAD=28, pw=canvas.width-PAD*2, ph=canvas.height-PAD*2;
    const rows = frameMap.get(frames[currentIdx]) || [];
    let closest=null, minD=15;
    for (const r of rows) {
      const [cx,cy] = fieldToCanvas(r.field_x_m,r.field_y_m,PAD,PAD,pw,ph);
      const d = Math.hypot(mx-cx,my-cy);
      if (d<minD) { minD=d; closest=r; }
    }
    setHovered(closest);
  }, [frameMap, frames, currentIdx]);

  const handleClick = useCallback(() => {
    if (!hovered) return;
    onSelectPlayer(prev => prev===hovered.tracker_id ? null : hovered.tracker_id);
  }, [hovered, onSelectPlayer]);

  return (
    <canvas
      ref={canvasRef}
      width={860} height={540}
      style={{ width:"100%", height:"auto", display:"block",
               cursor: hovered ? "pointer" : "crosshair" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovered(null)}
      onClick={handleClick}
    />
  );
}

// ─── StatsPanel ───────────────────────────────────────────────────────────────
function StatsPanel({ allRows, frames, currentIdx, playerStats }) {
  const stats = useMemo(() => {
    if (!allRows || !playerStats) return null;
    let poss0=0, poss1=0;
    for (const r of allRows) {
      if (r.role==="player"||r.role==="goalkeeper") {
        if (r.team_id===0) poss0++; else if (r.team_id===1) poss1++;
      }
    }
    const tot = poss0+poss1||1;

    const teamDist = {0:0,1:0};
    const teamMaxSpd = {0:0,1:0};
    for (const [,s] of playerStats) {
      if (s.team_id===0||s.team_id===1) {
        teamDist[s.team_id] += s.distance_m;
        if (s.max_speed > teamMaxSpd[s.team_id]) teamMaxSpd[s.team_id]=s.max_speed;
      }
    }
    return {
      poss0: Math.round(poss0/tot*100), poss1: Math.round(poss1/tot*100),
      dist0: Math.round(teamDist[0]),   dist1: Math.round(teamDist[1]),
      spd0: teamMaxSpd[0].toFixed(1),   spd1: teamMaxSpd[1].toFixed(1),
      totalFrames: frames?.length || 0,
      elapsed: frames ? Math.round(frames[currentIdx]/FPS_ASSUMED) : 0,
    };
  }, [allRows, playerStats, frames, currentIdx]);

  if (!stats) return null;

  const StatRow = ({ label, v0, v1, unit="", color0=T.team0, color1=T.team1, showBar=false, pct0=50 }) => (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
        <span style={{ color: color0, fontWeight:700, fontSize:14 }}>{v0}{unit}</span>
        <span style={{ color: T.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:1 }}>{label}</span>
        <span style={{ color: color1, fontWeight:700, fontSize:14 }}>{v1}{unit}</span>
      </div>
      {showBar && (
        <div style={{ height:4, background: T.border, borderRadius:2, overflow:"hidden" }}>
          <div style={{
            width:`${pct0}%`, height:"100%",
            background:`linear-gradient(90deg,${color0},${color0}88)`,
            borderRadius:2, transition:"width 0.4s ease"
          }}/>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {/* Team headers */}
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:16, paddingBottom:12,
                    borderBottom:`1px solid ${T.border}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:8,height:8,borderRadius:"50%",background:T.team0 }}/>
          <span style={{ fontSize:11, fontWeight:700, color:T.team0, letterSpacing:1 }}>TEAM A</span>
        </div>
        <div style={{ fontSize:10, color:T.textDim, letterSpacing:1, textTransform:"uppercase" }}>
          {Math.floor(stats.elapsed/60)}:{String(stats.elapsed%60).padStart(2,"0")} elapsed
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:11, fontWeight:700, color:T.team1, letterSpacing:1 }}>TEAM B</span>
          <div style={{ width:8,height:8,borderRadius:"50%",background:T.team1 }}/>
        </div>
      </div>

      <StatRow label="Possession" v0={stats.poss0} v1={stats.poss1} unit="%"
               showBar pct0={stats.poss0} />
      <StatRow label="Team Distance" v0={stats.dist0} v1={stats.dist1} unit=" m" />
      <StatRow label="Top Speed" v0={stats.spd0} v1={stats.spd1} unit=" km/h" />

      {/* Frame counter */}
      <div style={{ marginTop:8, paddingTop:12, borderTop:`1px solid ${T.border}`,
                    display:"flex", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, color:T.textDim, textTransform:"uppercase", letterSpacing:1 }}>Frame</span>
        <span style={{ fontSize:13, fontWeight:700, color:T.textPri, fontVariantNumeric:"tabular-nums" }}>
          {frames?.[currentIdx]||0} / {frames?.[frames.length-1]||0}
        </span>
      </div>
    </div>
  );
}

// ─── PlayerSidebar ────────────────────────────────────────────────────────────
function PlayerSidebar({ playerStats, selectedPlayer, onSelectPlayer, frameMap, frames, currentIdx }) {
  const sorted = useMemo(() => {
    if (!playerStats) return [];
    return [...playerStats.values()]
      .filter(s => s.role!=="referee")
      .sort((a,b) => b.distance_m - a.distance_m);
  }, [playerStats]);

  const frameRows = useMemo(() => {
    if (!frameMap||!frames.length) return new Map();
    const m = new Map();
    for (const r of (frameMap.get(frames[currentIdx])||[])) m.set(r.tracker_id, r);
    return m;
  }, [frameMap, frames, currentIdx]);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:2, overflowY:"auto", maxHeight:440 }}>
      <div style={{ fontSize:10, color:T.textDim, textTransform:"uppercase", letterSpacing:1,
                    marginBottom:8, paddingBottom:8, borderBottom:`1px solid ${T.border}` }}>
        Players · {sorted.length}
      </div>
      {sorted.map(s => {
        const live   = frameRows.get(s.tracker_id);
        const isSel  = selectedPlayer === s.tracker_id;
        const col    = TEAM_COLORS[s.team_id]||"#aaa";
        const spd    = live?.speed_kmh||0;

        return (
          <div key={s.tracker_id}
            onClick={() => onSelectPlayer(p => p===s.tracker_id ? null : s.tracker_id)}
            style={{
              padding:"8px 10px", borderRadius:7, cursor:"pointer",
              background: isSel ? `${col}18` : "transparent",
              border:`1px solid ${isSel ? col+"55" : "transparent"}`,
              transition:"all 0.15s ease",
            }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{
                width:24, height:24, borderRadius:"50%",
                background: s.role==="goalkeeper" ? "transparent" : col,
                border: s.role==="goalkeeper" ? `2px solid ${col}` : "none",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:9, fontWeight:700, color: s.role==="goalkeeper" ? col : "#fff",
                flexShrink:0,
              }}>{s.tracker_id}</div>

              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
                  <span style={{ fontSize:11, fontWeight:600, color:T.textPri }}>
                    #{s.tracker_id}
                  </span>
                  <span style={{ fontSize:9, color: col, textTransform:"uppercase", letterSpacing:0.5 }}>
                    {s.role==="goalkeeper" ? "GK" : TEAM_NAMES[s.team_id]}
                  </span>
                </div>
                {/* Speed bar */}
                <div style={{ display:"flex", alignItems:"center", gap:4, marginTop:3 }}>
                  <div style={{ flex:1, height:3, background:T.border, borderRadius:2 }}>
                    <div style={{
                      width:`${Math.min(spd/38*100,100)}%`, height:"100%",
                      background: spd>25 ? T.warn : col,
                      borderRadius:2, transition:"width 0.2s ease",
                    }}/>
                  </div>
                  <span style={{ fontSize:9, color:T.textSec, minWidth:32, textAlign:"right",
                                 fontVariantNumeric:"tabular-nums" }}>
                    {spd.toFixed(1)}<span style={{fontSize:8,color:T.textDim}}> km/h</span>
                  </span>
                </div>
              </div>
            </div>

            {isSel && (
              <div style={{ marginTop:8, paddingTop:8, borderTop:`1px dashed ${T.border}`,
                            display:"grid", gridTemplateColumns:"1fr 1fr", gap:"4px 0" }}>
                {[
                  ["Dist", `${s.distance_m.toFixed(0)} m`],
                  ["Max spd", `${s.max_speed} km/h`],
                  ["Avg spd", `${s.avg_speed} km/h`],
                  ["Coverage", `${s.coverage_m2} m²`],
                ].map(([k,v]) => (
                  <div key={k}>
                    <div style={{ fontSize:9, color:T.textDim }}>{k}</div>
                    <div style={{ fontSize:11, fontWeight:600, color:T.textPri }}>{v}</div>
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
function Timeline({ frames, currentIdx, setCurrentIdx, playing, setPlaying,
                    speed, setSpeed, events }) {
  const barRef = useRef(null);

  const seek = useCallback((e) => {
    const rect = barRef.current.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width));
    setCurrentIdx(Math.round(pct*(frames.length-1)));
    setPlaying(false);
  }, [frames.length, setCurrentIdx, setPlaying]);

  const handleKey = useCallback((e) => {
    if (e.key==="ArrowRight") setCurrentIdx(i=>Math.min(i+1,frames.length-1));
    if (e.key==="ArrowLeft")  setCurrentIdx(i=>Math.max(i-1,0));
    if (e.key===" ") { e.preventDefault(); setPlaying(p=>!p); }
  }, [frames.length, setCurrentIdx, setPlaying]);

  useEffect(() => { window.addEventListener("keydown",handleKey); return ()=>window.removeEventListener("keydown",handleKey); }, [handleKey]);

  const pct = frames.length>1 ? (currentIdx/(frames.length-1))*100 : 0;

  return (
    <div style={{ padding:"12px 16px" }}>
      {/* Scrubber track */}
      <div ref={barRef} onClick={seek} style={{
        height:36, background:T.surface, borderRadius:6, position:"relative",
        cursor:"pointer", marginBottom:10, overflow:"hidden",
        border:`1px solid ${T.border}`,
      }}>
        {/* Fill */}
        <div style={{
          position:"absolute", left:0, top:0, bottom:0,
          width:`${pct}%`, background:`${T.accent}22`,
          borderRight:`2px solid ${T.accent}`,
          transition:"width 0.05s linear",
        }}/>

        {/* Event markers */}
        {events.map((ev, i) => {
          const ep = frames.length>1 ? (frames.indexOf(ev.frame)/(frames.length-1))*100 : 0;
          return (
            <div key={i} title={`#${ev.tracker_id} · ${ev.speed.toFixed(1)} km/h`}
              style={{
                position:"absolute", left:`${ep}%`, top:4, bottom:4, width:2,
                background: TEAM_COLORS[ev.team_id]||T.ref,
                opacity:0.7, borderRadius:1,
                transform:"translateX(-50%)",
              }}/>
          );
        })}

        {/* Playhead */}
        <div style={{
          position:"absolute", left:`${pct}%`, top:-2, bottom:-2, width:3,
          background: T.textPri, borderRadius:2,
          transform:"translateX(-50%)",
          boxShadow:"0 0 6px rgba(255,255,255,0.4)",
        }}/>

        {/* Time label */}
        <div style={{
          position:"absolute", left:`${pct}%`, top:"50%",
          transform:"translate(-50%,-50%)",
          background: T.accent, color:"#fff", fontSize:9,
          padding:"2px 5px", borderRadius:3, fontWeight:700,
          pointerEvents:"none", whiteSpace:"nowrap",
          marginTop: pct > 85 ? 0 : 0,
        }}>
          {frames[currentIdx]||0}
        </div>
      </div>

      {/* Controls row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
        <div style={{ display:"flex", gap:4 }}>
          {[
            ["⏮", ()=>{setCurrentIdx(0);setPlaying(false);}],
            ["←",  ()=>{setCurrentIdx(i=>Math.max(0,i-1));setPlaying(false);}],
            [playing?"⏸":"▶", ()=>setPlaying(p=>!p)],
            ["→",  ()=>{setCurrentIdx(i=>Math.min(i+1,frames.length-1));setPlaying(false);}],
            ["⏭", ()=>{setCurrentIdx(frames.length-1);setPlaying(false);}],
          ].map(([lbl,fn])=>(
            <button key={lbl} onClick={fn} style={{
              background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:6, color:T.textPri, padding:"5px 10px",
              cursor:"pointer", fontSize:13, fontFamily:"inherit",
            }}>{lbl}</button>
          ))}
        </div>

        <select value={speed} onChange={e=>setSpeed(+e.target.value)} style={{
          background:T.surface, border:`1px solid ${T.border}`, borderRadius:6,
          color:T.textSec, padding:"5px 8px", fontSize:11, fontFamily:"inherit",
        }}>
          {[0.25,0.5,1,2,4,8].map(s=><option key={s} value={s}>{s}×</option>)}
        </select>

        <div style={{ marginLeft:"auto", fontSize:10, color:T.textDim }}>
          {events.length} sprint events (≥28 km/h) ·
          <span style={{ color:T.textSec }}> ←→ or arrow keys</span>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [allRows,      setAllRows]      = useState(null);
  const [frameMap,     setFrameMap]     = useState(null);
  const [frames,       setFrames]       = useState([]);
  const [currentIdx,   setCurrentIdx]   = useState(0);
  const [playing,      setPlaying]      = useState(false);
  const [speed,        setSpeed]        = useState(1);
  const [showHeatmap,  setShowHeatmap]  = useState(false);
  const [showTrails,   setShowTrails]   = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [usingDemo,    setUsingDemo]    = useState(false);
  const animRef = useRef(null);

  const playerStats = useMemo(() => allRows ? buildPlayerStats(allRows) : null, [allRows]);
  const heatmaps    = useMemo(() => allRows ? {0:buildHeatmap(allRows,0),1:buildHeatmap(allRows,1)} : null, [allRows]);
  const events      = useMemo(() => allRows ? buildSpeedEvents(allRows, 28) : [], [allRows]);

  const loadRows = useCallback((rows) => {
    const fm = groupByFrame(rows);
    const sorted = [...fm.keys()].sort((a,b)=>a-b);
    setAllRows(rows); setFrameMap(fm); setFrames(sorted);
    setCurrentIdx(0); setPlaying(false);
  }, []);

  useEffect(() => { setUsingDemo(true); loadRows(generateDemo()); }, [loadRows]);

  // Animation loop
  useEffect(() => {
    if (!playing) return;
    let last = 0;
    const ms = 1000 / (FPS_ASSUMED * speed);
    const tick = (ts) => {
      if (ts - last >= ms) {
        last = ts;
        setCurrentIdx(i => {
          if (i >= frames.length-1) { setPlaying(false); return i; }
          return i+1;
        });
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, speed, frames.length]);

  const handleFile = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try { setUsingDemo(false); loadRows(parseCSV(ev.target.result)); }
      catch(err) { alert("CSV parse error: "+err.message); }
    };
    reader.readAsText(f);
  };

  return (
    <div style={{
      background: T.bg, minHeight:"100vh", color: T.textPri,
      fontFamily:"'Inter','Segoe UI',system-ui,sans-serif",
      display:"flex", flexDirection:"column",
    }}>
      {/* Top bar */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 16px", borderBottom:`1px solid ${T.border}`,
        background: T.surface,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20 }}>⚽</span>
          <div>
            <div style={{ fontWeight:800, fontSize:13, letterSpacing:0.8, color:T.textPri }}>
              TACTICAL REPLAY
            </div>
            <div style={{ fontSize:10, color:T.textDim, letterSpacing:0.5 }}>
              {usingDemo ? "Demo · load tracking.csv to use real data" : `${frames.length} frames · ${allRows?.length||0} detections`}
            </div>
          </div>
        </div>

        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {[
            ["🔥 Heatmap", showHeatmap, ()=>setShowHeatmap(v=>!v)],
            ["〰 Trails",  showTrails,  ()=>setShowTrails(v=>!v)],
          ].map(([lbl,active,fn])=>(
            <button key={lbl} onClick={fn} style={{
              background: active ? `${T.accent}22` : T.surface,
              border:`1px solid ${active ? T.accent : T.border}`,
              borderRadius:6, color: active ? T.accent : T.textSec,
              padding:"5px 10px", cursor:"pointer", fontSize:11,
              fontFamily:"inherit",
            }}>{lbl}</button>
          ))}
          <label style={{
            background:T.panel, border:`1px solid ${T.border}`, borderRadius:6,
            padding:"5px 10px", fontSize:11, cursor:"pointer", color:T.accent,
            fontFamily:"inherit",
          }}>
            📂 Load CSV
            <input type="file" accept=".csv" onChange={handleFile} style={{display:"none"}}/>
          </label>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 220px", gap:0, overflow:"hidden" }}>
        {/* Left: pitch + timeline */}
        <div style={{ display:"flex", flexDirection:"column" }}>
          <div style={{ flex:1, background:T.bg, borderRight:`1px solid ${T.border}` }}>
            <PitchCanvas
              frameMap={frameMap} frames={frames} currentIdx={currentIdx}
              playerStats={playerStats} allRows={allRows}
              showHeatmap={showHeatmap} showTrails={showTrails}
              heatmaps={heatmaps} selectedPlayer={selectedPlayer}
              onSelectPlayer={setSelectedPlayer}
            />
          </div>
          <div style={{ borderTop:`1px solid ${T.border}`, borderRight:`1px solid ${T.border}`,
                        background:T.surface }}>
            <Timeline
              frames={frames} currentIdx={currentIdx} setCurrentIdx={setCurrentIdx}
              playing={playing} setPlaying={setPlaying}
              speed={speed} setSpeed={setSpeed} events={events}
            />
          </div>
        </div>

        {/* Right: stats + players */}
        <div style={{ display:"flex", flexDirection:"column", background:T.surface, overflowY:"auto" }}>
          <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${T.border}` }}>
            <StatsPanel allRows={allRows} frames={frames} currentIdx={currentIdx} playerStats={playerStats}/>
          </div>
          <div style={{ padding:"12px 14px", flex:1 }}>
            <PlayerSidebar
              playerStats={playerStats} selectedPlayer={selectedPlayer}
              onSelectPlayer={setSelectedPlayer}
              frameMap={frameMap} frames={frames} currentIdx={currentIdx}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

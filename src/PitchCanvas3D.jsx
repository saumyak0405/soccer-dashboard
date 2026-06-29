import { useRef, useMemo, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";

const PITCH_W = 105;
const PITCH_H = 68;
const TEAM_COLORS = { 0: "#FF2D6B", 1: "#00D4FF", 3: "#FFB800" };
const MAX_SPEED   = 38;

// ─── Skeleton bone connections ────────────────────────────────────────────────
const BONES = [
  ["nose",           "left_shoulder"],
  ["nose",           "right_shoulder"],
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

// ─── Skeleton component ───────────────────────────────────────────────────────
// joints: { nose_x, nose_y, left_shoulder_x, left_shoulder_y, ... }
// All values normalised 0-1 within player crop
// We map them to 3D space relative to player position (px, pz)
// Player height range: 0 (feet) to playerH (head)
function Skeleton({ joints, px, pz, playerH, color }) {
  const boneGeos = useMemo(() => {
    if (!joints) return [];

    const W = 2.2;  // skeleton width scale (meters)
    const H = playerH * 0.95; // skeleton height scale

    // Convert a joint name to 3D position
    const pt = (name) => {
      const x = joints[`${name}_x`];
      const y = joints[`${name}_y`];
      if (x == null || y == null || isNaN(x) || isNaN(y)) return null;
      // x: 0=left, 1=right → centre on player x position
      // y: 0=top(head), 1=bottom(feet) → flip for 3D height
      return new THREE.Vector3(
        px + (x - 0.5) * W,
        (1 - y) * H,
        pz + (x - 0.5) * 0.1  // slight depth offset
      );
    };

    const geos = [];
    for (const [a, b] of BONES) {
      const pa = pt(a), pb = pt(b);
      if (!pa || !pb) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
      geos.push(geo);
    }
    return geos;
  }, [joints, px, pz, playerH]);

  const jointPositions = useMemo(() => {
    if (!joints) return [];
    const W = 2.2;
    const H = playerH * 0.95;
    const positions = [];
    const names = [
      "nose","left_shoulder","right_shoulder",
      "left_elbow","right_elbow",
      "left_wrist","right_wrist",
      "left_hip","right_hip",
      "left_knee","right_knee",
      "left_ankle","right_ankle",
    ];
    for (const name of names) {
      const x = joints[`${name}_x`];
      const y = joints[`${name}_y`];
      if (x == null || y == null || isNaN(x) || isNaN(y)) continue;
      positions.push({
        pos: [px + (x-0.5)*W, (1-y)*H, pz + (x-0.5)*0.1],
        isHead: name === "nose",
      });
    }
    return positions;
  }, [joints, px, pz, playerH]);

  if (boneGeos.length === 0) return null;

  return (
    <group>
      {/* Bones */}
      {boneGeos.map((geo, i) => (
        <line key={i} geometry={geo}>
          <lineBasicMaterial color={color} transparent opacity={0.9} linewidth={2} />
        </line>
      ))}

      {/* Joint dots */}
      {jointPositions.map(({ pos, isHead }, i) => (
        <mesh key={i} position={pos}>
          <sphereGeometry args={[isHead ? 0.18 : 0.1, 6, 6]} />
          <meshBasicMaterial color={isHead ? "#ffffff" : color} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Pitch ────────────────────────────────────────────────────────────────────
function Pitch() {
  const cx = PITCH_W / 2;
  const cz = PITCH_H / 2;
  const y  = 0.05;

  const lineGroups = useMemo(() => [
    [[0,y,0],[PITCH_W,y,0],[PITCH_W,y,PITCH_H],[0,y,PITCH_H],[0,y,0]],
    [[PITCH_W/2,y,0],[PITCH_W/2,y,PITCH_H]],
    [[0,y,(PITCH_H-40.32)/2],[16.5,y,(PITCH_H-40.32)/2],
     [16.5,y,(PITCH_H+40.32)/2],[0,y,(PITCH_H+40.32)/2]],
    [[PITCH_W,y,(PITCH_H-40.32)/2],[PITCH_W-16.5,y,(PITCH_H-40.32)/2],
     [PITCH_W-16.5,y,(PITCH_H+40.32)/2],[PITCH_W,y,(PITCH_H+40.32)/2]],
    [[0,y,(PITCH_H-18.32)/2],[5.5,y,(PITCH_H-18.32)/2],
     [5.5,y,(PITCH_H+18.32)/2],[0,y,(PITCH_H+18.32)/2]],
    [[PITCH_W,y,(PITCH_H-18.32)/2],[PITCH_W-5.5,y,(PITCH_H-18.32)/2],
     [PITCH_W-5.5,y,(PITCH_H+18.32)/2],[PITCH_W,y,(PITCH_H+18.32)/2]],
  ], []);

  const circleGeo = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i/64)*Math.PI*2;
      pts.push(new THREE.Vector3(cx+Math.cos(a)*9.15, y, cz+Math.sin(a)*9.15));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [cx, cz, y]);

  return (
    <group>
      <mesh rotation={[-Math.PI/2,0,0]} position={[cx,0,cz]}>
        <planeGeometry args={[PITCH_W+10, PITCH_H+10]} />
        <meshBasicMaterial color="#1e6b2f" />
      </mesh>
      {Array.from({length:10},(_,i)=>(
        <mesh key={i} rotation={[-Math.PI/2,0,0]}
          position={[PITCH_W/10*i+PITCH_W/20, 0.01, cz]}>
          <planeGeometry args={[PITCH_W/10, PITCH_H]} />
          <meshBasicMaterial color={i%2===0?"#1a5c28":"#1e6b2f"} />
        </mesh>
      ))}
      {lineGroups.map((pts,i)=>(
        <line key={i} geometry={new THREE.BufferGeometry().setFromPoints(pts.map(p=>new THREE.Vector3(...p)))}>
          <lineBasicMaterial color="white" />
        </line>
      ))}
      <line geometry={circleGeo}><lineBasicMaterial color="white" /></line>
      {[[11,cz],[PITCH_W-11,cz],[cx,cz]].map(([x,z],i)=>(
        <mesh key={i} position={[x,0.06,z]} rotation={[-Math.PI/2,0,0]}>
          <circleGeometry args={[0.35,16]} />
          <meshBasicMaterial color="white" />
        </mesh>
      ))}
      <Goal x={0} /><Goal x={PITCH_W} />
    </group>
  );
}

function Goal({ x }) {
  const r=0.08, h=2.44, w=7.32, z=PITCH_H/2;
  return (
    <group>
      <mesh position={[x,h/2,z-w/2]}><cylinderGeometry args={[r,r,h,8]}/><meshBasicMaterial color="white"/></mesh>
      <mesh position={[x,h/2,z+w/2]}><cylinderGeometry args={[r,r,h,8]}/><meshBasicMaterial color="white"/></mesh>
      <mesh position={[x,h,z]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[r,r,w,8]}/><meshBasicMaterial color="white"/></mesh>
    </group>
  );
}

// ─── Player (capsule + optional skeleton) ─────────────────────────────────────
function Player({ row, isSelected, joints, showSkeleton, onClick }) {
  const color  = TEAM_COLORS[row.team_id] || "#888";
  const isRef  = row.role === "referee";
  const isGK   = row.role === "goalkeeper";
  const h      = isRef ? 2.8 : isGK ? 3.8 : 3.5;
  const r      = isRef ? 0.55 : 0.7;
  const hasPose = joints && Object.keys(joints).length > 0;

  return (
    <group
      position={[row.field_x_m, 0, row.field_y_m]}
      onClick={e => { e.stopPropagation(); onClick(row.tracker_id); }}
    >
      {/* Capsule body — shown always, slightly transparent when pose active */}
      <mesh position={[0, h/2, 0]}>
        <capsuleGeometry args={[r, h*0.4, 4, 8]} />
        <meshBasicMaterial
          color={color}
          transparent={showSkeleton && hasPose}
          opacity={showSkeleton && hasPose ? 0.25 : 1}
        />
      </mesh>

      {/* GK ring */}
      {isGK && (
        <mesh position={[0, h/2, 0]}>
          <torusGeometry args={[r+0.2, 0.07, 8, 24]} />
          <meshBasicMaterial color={color} />
        </mesh>
      )}

      {/* Selection ring */}
      {isSelected && (
        <mesh position={[0, 0.1, 0]} rotation={[-Math.PI/2,0,0]}>
          <ringGeometry args={[r+0.2, r+0.5, 32]} />
          <meshBasicMaterial color="white" transparent opacity={0.9} />
        </mesh>
      )}

      {/* Speed glow */}
      {row.speed_kmh > 22 && (
        <mesh position={[0, h/2, 0]}>
          <capsuleGeometry args={[r+0.2, h*0.4, 4, 8]} />
          <meshBasicMaterial color="#ffdc32" transparent
            opacity={Math.min((row.speed_kmh-22)/16*0.4, 0.4)} />
        </mesh>
      )}

      {/* Skeleton overlay */}
      {showSkeleton && hasPose && (
        <Skeleton
          joints={joints}
          px={0}
          pz={0}
          playerH={h}
          color={color}
        />
      )}

      {/* ID label */}
      <Text
        position={[0, h+0.7, 0]}
        fontSize={1.0}
        color="white"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.12}
        outlineColor="black"
      >
        {String(row.tracker_id)}
      </Text>
    </group>
  );
}

// ─── Trail ────────────────────────────────────────────────────────────────────
function Trail({ points, color }) {
  const geo = useMemo(() => {
    if (!points || points.length < 2) return null;
    return new THREE.BufferGeometry().setFromPoints(
      points.map(p => new THREE.Vector3(p.x, 0.1, p.y))
    );
  }, [points]);
  if (!geo) return null;
  return <line geometry={geo}><lineBasicMaterial color={color} transparent opacity={0.55} /></line>;
}

// ─── Camera ───────────────────────────────────────────────────────────────────
const PRESETS = {
  "Top Down":    { pos:[PITCH_W/2, 90, PITCH_H/2+1],  target:[PITCH_W/2,0,PITCH_H/2] },
  "Sideline":    { pos:[PITCH_W/2, 18, -22],           target:[PITCH_W/2,2,PITCH_H/2] },
  "Behind Goal": { pos:[-22, 16, PITCH_H/2],           target:[PITCH_W/2,2,PITCH_H/2] },
  "Corner":      { pos:[-8, 32, -8],                   target:[PITCH_W/2,0,PITCH_H/2] },
};

function CameraRig({ preset, followPos }) {
  const { camera } = useThree();
  const controlsRef = useRef();

  useEffect(() => {
    const p = PRESETS[preset];
    if (!p) return;
    camera.position.set(...p.pos);
    if (controlsRef.current) {
      controlsRef.current.target.set(...p.target);
      controlsRef.current.update();
    }
  }, [preset, camera]);

  useFrame(() => {
    if (followPos && controlsRef.current) {
      controlsRef.current.target.lerp(
        new THREE.Vector3(followPos.x, 0, followPos.z), 0.06
      );
      controlsRef.current.update();
    }
  });

  return (
    <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.06}
      minDistance={8} maxDistance={200} maxPolarAngle={Math.PI/2.02} />
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ frameRows, trails, poseMap, currentFrame,
                 selectedPlayer, onSelectPlayer, showTrails, showSkeleton }) {

  const validRows = useMemo(() =>
    frameRows
      .filter(r =>
        r.field_x_m >= -2 && r.field_x_m <= PITCH_W+2 &&
        r.field_y_m >= -2 && r.field_y_m <= PITCH_H+2
      )
      .map(r => ({ ...r, speed_kmh: Math.min(r.speed_kmh||0, MAX_SPEED) })),
  [frameRows]);

  const players = validRows.filter(r => r.role !== "ball");
  const ball    = validRows.find(r => r.role === "ball");

  return (
    <>
      <ambientLight intensity={1.3} />
      <directionalLight position={[60,100,40]} intensity={0.7} />
      <directionalLight position={[-30,60,-20]} intensity={0.3} />
      <Pitch />

      {showTrails && players.map(row => {
        const trail = trails.get(row.tracker_id);
        const col   = TEAM_COLORS[row.team_id] || "#aaa";
        return <Trail key={row.tracker_id} points={trail} color={col} />;
      })}

      {players.map(row => {
        const key    = `${currentFrame}_${row.tracker_id}`;
        const joints = poseMap ? poseMap.get(key) : null;
        return (
          <Player
            key={row.tracker_id}
            row={row}
            isSelected={selectedPlayer === row.tracker_id}
            joints={joints}
            showSkeleton={showSkeleton}
            onClick={onSelectPlayer}
          />
        );
      })}

      {ball && (
        <mesh position={[ball.field_x_m, 0.6, ball.field_y_m]}>
          <sphereGeometry args={[0.3,16,16]} />
          <meshBasicMaterial color="white" />
        </mesh>
      )}
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────
export default function PitchCanvas3D({
  frameMap, frames, currentIdx,
  showTrails, selectedPlayer, onSelectPlayer,
  poseMap, showSkeleton,
}) {
  const [preset, setPreset] = useState("Top Down");
  const [follow, setFollow] = useState(false);

  const currentFrame = frames?.[currentIdx] || 0;

  const frameRows = useMemo(() => {
    if (!frameMap || !frames.length) return [];
    return frameMap.get(frames[currentIdx]) || [];
  }, [frameMap, frames, currentIdx]);

  const trails = useMemo(() => {
    if (!frameMap || !frames.length) return new Map();
    const map = new Map();
    const sf  = [...frameMap.keys()].sort((a,b)=>a-b);
    for (let i = Math.max(0,currentIdx-30); i <= currentIdx; i++) {
      for (const r of (frameMap.get(sf[i])||[])) {
        if (r.field_x_m<0||r.field_x_m>PITCH_W||r.field_y_m<0||r.field_y_m>PITCH_H) continue;
        if (!map.has(r.tracker_id)) map.set(r.tracker_id,[]);
        map.get(r.tracker_id).push({x:r.field_x_m,y:r.field_y_m});
      }
    }
    return map;
  }, [frameMap,frames,currentIdx]);

  const followPos = useMemo(() => {
    if (!follow||!selectedPlayer) return null;
    const row = frameRows.find(r=>r.tracker_id===selectedPlayer);
    return row ? {x:row.field_x_m,z:row.field_y_m} : null;
  },[follow,selectedPlayer,frameRows]);

  const T = { border:"#1E2733", textSec:"#7A8FA6", accent:"#3D8EF0", dim:"#3D5068" };

  // Count how many players have pose this frame
  const poseCount = useMemo(() => {
    if (!poseMap) return 0;
    return frameRows.filter(r =>
      poseMap.has(`${currentFrame}_${r.tracker_id}`)
    ).length;
  }, [poseMap, frameRows, currentFrame]);

  return (
    <div style={{position:"relative",width:"100%",height:"540px"}}>

      {/* Camera + pose controls */}
      <div style={{position:"absolute",top:10,left:10,zIndex:10,
        display:"flex",gap:6,flexWrap:"wrap"}}>
        {Object.keys(PRESETS).map(name=>(
          <button key={name} onClick={()=>setPreset(name)} style={{
            background:preset===name?"#3D8EF033":"rgba(7,10,15,0.88)",
            border:`1px solid ${preset===name?T.accent:T.border}`,
            borderRadius:6,color:preset===name?T.accent:T.textSec,
            padding:"5px 12px",cursor:"pointer",fontSize:11,
            fontFamily:"'Inter',sans-serif",fontWeight:preset===name?700:400,
          }}>{name}</button>
        ))}

        {selectedPlayer && (
          <button onClick={()=>setFollow(v=>!v)} style={{
            background:follow?"#3D8EF033":"rgba(7,10,15,0.88)",
            border:`1px solid ${follow?T.accent:T.border}`,
            borderRadius:6,color:follow?T.accent:T.textSec,
            padding:"5px 12px",cursor:"pointer",fontSize:11,
            fontFamily:"'Inter',sans-serif",
          }}>
            {follow?`🎯 Following #${selectedPlayer}`:"🎯 Follow Player"}
          </button>
        )}
      </div>

      {/* Legend + pose indicator */}
      <div style={{position:"absolute",top:10,right:10,zIndex:10,
        display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
        <div style={{display:"flex",gap:10,background:"rgba(7,10,15,0.88)",
          border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px"}}>
          {[["Team A","#FF2D6B"],["Team B","#00D4FF"],["Ref","#FFB800"]].map(([n,c])=>(
            <div key={n} style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:c}}/>
              <span style={{fontSize:10,color:T.textSec,fontFamily:"'Inter',sans-serif"}}>{n}</span>
            </div>
          ))}
        </div>

        {/* Pose status */}
        {poseMap && (
          <div style={{background:"rgba(7,10,15,0.88)",
            border:`1px solid ${showSkeleton?"#3D8EF0":T.border}`,
            borderRadius:6,padding:"4px 10px",fontSize:10,
            color:showSkeleton?"#3D8EF0":T.textSec,
            fontFamily:"'Inter',sans-serif"}}>
            🦴 {poseCount} skeletons this frame
          </div>
        )}
      </div>

      {/* Hint */}
      <div style={{position:"absolute",bottom:10,left:10,zIndex:10,
        fontSize:10,color:T.dim,fontFamily:"'Inter',sans-serif",
        background:"rgba(7,10,15,0.75)",padding:"4px 8px",borderRadius:4}}>
        🖱 Drag to rotate · Scroll to zoom · Right-drag to pan
      </div>

      <Canvas
        style={{width:"100%",height:"540px"}}
        camera={{position:[PITCH_W/2,90,PITCH_H/2+1],fov:52,near:0.1,far:600}}
        gl={{antialias:true,preserveDrawingBuffer:true,
             powerPreference:"default",failIfMajorPerformanceCaveat:false}}
      >
        <color attach="background" args={["#070A0F"]} />
        <CameraRig preset={preset} followPos={followPos} />
        <Scene
          frameRows={frameRows}
          trails={trails}
          poseMap={poseMap}
          currentFrame={currentFrame}
          selectedPlayer={selectedPlayer}
          onSelectPlayer={onSelectPlayer}
          showTrails={showTrails}
          showSkeleton={showSkeleton}
        />
      </Canvas>
    </div>
  );
}

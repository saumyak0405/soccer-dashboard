import { useRef, useMemo, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";

const PITCH_W = 105;
const PITCH_H = 68;
const TEAM_COLORS = { 0: "#FF2D6B", 1: "#00D4FF", 3: "#FFB800" };

// ─── Pitch ───────────────────────────────────────────────────────────────────
function Pitch() {
  const cx = PITCH_W / 2;
  const cz = PITCH_H / 2;

  // Build line points
  const lines = useMemo(() => {
    const y = 0.05;
    return [
      // boundary
      [[0,y,0],[PITCH_W,y,0],[PITCH_W,y,PITCH_H],[0,y,PITCH_H],[0,y,0]],
      // halfway
      [[PITCH_W/2,y,0],[PITCH_W/2,y,PITCH_H]],
      // left penalty
      [[0,y,(PITCH_H-40.32)/2],[16.5,y,(PITCH_H-40.32)/2],[16.5,y,(PITCH_H+40.32)/2],[0,y,(PITCH_H+40.32)/2]],
      // right penalty
      [[PITCH_W,y,(PITCH_H-40.32)/2],[PITCH_W-16.5,y,(PITCH_H-40.32)/2],[PITCH_W-16.5,y,(PITCH_H+40.32)/2],[PITCH_W,y,(PITCH_H+40.32)/2]],
    ];
  }, []);

  // Centre circle points
  const circlePoints = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * 9.15, 0.05, cz + Math.sin(a) * 9.15));
    }
    return pts;
  }, [cx, cz]);

  return (
    <group>
      {/* Grass */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]}>
        <planeGeometry args={[PITCH_W + 8, PITCH_H + 8]} />
        <meshBasicMaterial color="#1e6b2f" />
      </mesh>

      {/* Stripes */}
      {Array.from({ length: 10 }, (_, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}
          position={[PITCH_W / 10 * i + PITCH_W / 20, 0.01, cz]}>
          <planeGeometry args={[PITCH_W / 10, PITCH_H]} />
          <meshBasicMaterial color={i % 2 === 0 ? "#1a5c28" : "#1e6b2f"} />
        </mesh>
      ))}

      {/* White lines */}
      {lines.map((pts, i) => {
        const vectors = pts.map(p => new THREE.Vector3(...p));
        const geo = new THREE.BufferGeometry().setFromPoints(vectors);
        return <line key={i} geometry={geo}>
          <lineBasicMaterial color="white" />
        </line>;
      })}

      {/* Centre circle */}
      <line geometry={new THREE.BufferGeometry().setFromPoints(circlePoints)}>
        <lineBasicMaterial color="white" />
      </line>

      {/* Goals */}
      <Goal x={0} />
      <Goal x={PITCH_W} flip />
    </group>
  );
}

function Goal({ x, flip }) {
  const r = 0.06;
  const h = 2.44;
  const w = 7.32;
  const d = flip ? -2 : 2;
  const z = PITCH_H / 2;
  return (
    <group>
      <mesh position={[x, h/2, z - w/2]}>
        <cylinderGeometry args={[r, r, h, 8]} />
        <meshBasicMaterial color="white" />
      </mesh>
      <mesh position={[x, h/2, z + w/2]}>
        <cylinderGeometry args={[r, r, h, 8]} />
        <meshBasicMaterial color="white" />
      </mesh>
      <mesh position={[x, h, z]} rotation={[0, 0, Math.PI/2]}>
        <cylinderGeometry args={[r, r, w, 8]} />
        <meshBasicMaterial color="white" />
      </mesh>
    </group>
  );
}

// ─── Player ───────────────────────────────────────────────────────────────────
function Player({ row, isSelected, onClick }) {
  const color = TEAM_COLORS[row.team_id] || "#888";
  const h = 1.8;
  const r = 0.45;

  return (
    <group
      position={[row.field_x_m, h / 2, row.field_y_m]}
      onClick={e => { e.stopPropagation(); onClick(row.tracker_id); }}
    >
      {/* Body */}
      <mesh>
        <capsuleGeometry args={[r, h * 0.4, 4, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>

      {/* Selection ring */}
      {isSelected && (
        <mesh position={[0, -h/2 + 0.1, 0]} rotation={[-Math.PI/2, 0, 0]}>
          <ringGeometry args={[r + 0.15, r + 0.35, 32]} />
          <meshBasicMaterial color="white" transparent opacity={0.9} />
        </mesh>
      )}

      {/* ID label */}
      <Text
        position={[0, h / 2 + 0.5, 0]}
        fontSize={0.6}
        color="white"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.08}
        outlineColor="black"
      >
        {String(row.tracker_id)}
      </Text>
    </group>
  );
}

// ─── Camera preset controller ─────────────────────────────────────────────────
const PRESETS = {
  "Top Down":    { pos: [PITCH_W/2, 90, PITCH_H/2+0.01], target: [PITCH_W/2, 0, PITCH_H/2] },
  "Sideline":    { pos: [PITCH_W/2, 22, -30],            target: [PITCH_W/2, 0, PITCH_H/2] },
  "Behind Goal": { pos: [-25, 18, PITCH_H/2],            target: [PITCH_W/2, 0, PITCH_H/2] },
  "Corner":      { pos: [-8, 35, -8],                    target: [PITCH_W/2, 0, PITCH_H/2] },
};

function CameraRig({ preset }) {
  const { camera } = useThree();
  const controlsRef = useRef();

  useEffect(() => {
    const p = PRESETS[preset];
    if (!p) return;
    camera.position.set(...p.pos);
    camera.lookAt(...p.target);
    if (controlsRef.current) {
      controlsRef.current.target.set(...p.target);
      controlsRef.current.update();
    }
  }, [preset, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.05}
      minDistance={5}
      maxDistance={200}
      maxPolarAngle={Math.PI / 2.05}
    />
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ frameRows, selectedPlayer, onSelectPlayer }) {
  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[50, 100, 50]} intensity={0.8} />
      <Pitch />
      {frameRows.map(row => (
        <Player
          key={row.tracker_id}
          row={row}
          isSelected={selectedPlayer === row.tracker_id}
          onClick={onSelectPlayer}
        />
      ))}
    </>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────
export default function PitchCanvas3D({ frameMap, frames, currentIdx,
  selectedPlayer, onSelectPlayer }) {

  const [preset, setPreset] = useState("Top Down");

  const frameRows = useMemo(() => {
    if (!frameMap || !frames.length) return [];
    return frameMap.get(frames[currentIdx]) || [];
  }, [frameMap, frames, currentIdx]);

  const T = { border:"#1E2733", textSec:"#7A8FA6", accent:"#3D8EF0" };

  return (
    <div style={{ position:"relative", width:"100%", height:"540px" }}>
      {/* Preset buttons */}
      <div style={{ position:"absolute", top:10, left:10, zIndex:10,
        display:"flex", gap:6 }}>
        {Object.keys(PRESETS).map(name => (
          <button key={name} onClick={() => setPreset(name)} style={{
            background: preset===name ? "#3D8EF033" : "rgba(7,10,15,0.85)",
            border: `1px solid ${preset===name ? T.accent : T.border}`,
            borderRadius:6, color: preset===name ? T.accent : T.textSec,
            padding:"4px 10px", cursor:"pointer", fontSize:11,
            fontFamily:"'Inter',sans-serif",
          }}>{name}</button>
        ))}
      </div>

      {/* Hint */}
      <div style={{ position:"absolute", bottom:10, left:10, zIndex:10,
        fontSize:10, color:"#3D5068", fontFamily:"'Inter',sans-serif",
        background:"rgba(7,10,15,0.7)", padding:"4px 8px", borderRadius:4 }}>
        🖱 Drag to rotate · Scroll to zoom · Right-drag to pan
      </div>

      <Canvas
        style={{ width:"100%", height:"540px" }}
        camera={{ position: [PITCH_W/2, 90, PITCH_H/2+0.01], fov:55, near:0.1, far:500 }}
        gl={{ antialias:true, preserveDrawingBuffer:true,
              powerPreference:"default", failIfMajorPerformanceCaveat:false }}
      >
        <color attach="background" args={["#070A0F"]} />
        <CameraRig preset={preset} />
        <Scene
          frameRows={frameRows}
          selectedPlayer={selectedPlayer}
          onSelectPlayer={onSelectPlayer}
        />
      </Canvas>
    </div>
  );
}

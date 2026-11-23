import { Sparkles } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  type Group,
  type InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  TubeGeometry,
  Vector3,
} from 'three';

/* An ancient rainforest tree, grown procedurally: a leaning trunk, gnarled limbs spreading
   wide, buttress roots crawling over the ground, hanging lianas and dark leaf clusters. It
   grows out of the ground when the page opens, in fog and dim moonlight. */

const GROW_SECONDS = 5;

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

interface Segment {
  readonly start: Vector3;
  readonly end: Vector3;
  readonly radius: number;
  /** 0 for the trunk and roots, rising toward the twigs. */
  readonly depth: number;
  /** Distance from the base, used to grow the tree outwards in order. */
  readonly distance: number;
  readonly root: boolean;
}

interface TreeShape {
  readonly segments: Segment[];
  readonly tips: { position: Vector3; distance: number }[];
  readonly hangs: Vector3[];
  readonly maxDistance: number;
}

function buildTree(): TreeShape {
  const random = seeded(42);
  const segments: Segment[] = [];
  const tips: { position: Vector3; distance: number }[] = [];
  const hangs: Vector3[] = [];
  const jitter = (amount: number): Vector3 =>
    new Vector3((random() - 0.5) * amount, (random() - 0.5) * amount, (random() - 0.5) * amount);

  function limb(
    start: Vector3,
    direction: Vector3,
    length: number,
    radius: number,
    depth: number,
    distance: number,
  ): void {
    let position = start.clone();
    const heading = direction.clone().normalize();
    let travelled = distance;
    let r = radius;
    const parts = 3;
    for (let part = 0; part < parts; part += 1) {
      heading.add(jitter(0.55)).normalize();
      // Upper limbs reach outwards more than upwards, like a rainforest giant.
      heading.y = Math.max(-0.2, Math.min(0.75, heading.y + 0.04));
      heading.normalize();
      const step = length / parts;
      const end = position.clone().addScaledVector(heading, step);
      segments.push({ start: position, end, radius: r, depth, distance: travelled, root: false });
      if (depth >= 2 && random() < 0.35) {
        hangs.push(end.clone());
      }
      travelled += step;
      position = end;
      r *= 0.82;
    }
    if (depth >= 5 || r < 0.02) {
      tips.push({ position, distance: travelled });
      return;
    }
    const children = depth < 2 ? 3 : 2 + (random() < 0.4 ? 1 : 0);
    for (let child = 0; child < children; child += 1) {
      const spread = heading
        .clone()
        .add(jitter(1.5))
        .add(new Vector3(0, 0.15, 0))
        .normalize();
      limb(position, spread, length * (0.68 + random() * 0.12), r * 0.78, depth + 1, travelled);
    }
    if (depth >= 3) {
      tips.push({ position, distance: travelled });
    }
  }

  function root(
    start: Vector3,
    direction: Vector3,
    length: number,
    radius: number,
    depth: number,
    distance: number,
  ): void {
    let position = start.clone();
    const heading = direction.clone().normalize();
    let travelled = distance;
    let r = radius;
    for (let part = 0; part < 3; part += 1) {
      heading.add(jitter(0.4));
      heading.y = Math.min(-0.02, heading.y * 0.5 - 0.06);
      heading.normalize();
      const step = length / 3;
      const end = position.clone().addScaledVector(heading, step);
      end.y = Math.max(end.y, -3.35);
      segments.push({ start: position, end, radius: r, depth: 0, distance: travelled, root: true });
      travelled += step;
      position = end;
      r *= 0.72;
    }
    if (depth < 3) {
      const children = depth === 0 ? 2 : 1 + (random() < 0.5 ? 1 : 0);
      for (let child = 0; child < children; child += 1) {
        root(position, heading.clone().add(jitter(1.2)), length * 0.7, r, depth + 1, travelled);
      }
    }
  }

  // The trunk: thick, leaning, slightly twisting.
  let position = new Vector3(0, -3.1, 0);
  let radius = 0.62;
  const heading = new Vector3(0.06, 1, 0.02).normalize();
  let travelled = 0;
  const trunkParts = 7;
  for (let part = 0; part < trunkParts; part += 1) {
    heading.add(jitter(0.12)).normalize();
    const end = position.clone().addScaledVector(heading, 0.62);
    segments.push({ start: position, end, radius, depth: 0, distance: travelled, root: false });
    travelled += 0.62;
    position = end;
    radius *= 0.9;
    // Low limbs off the upper trunk.
    if (part >= 4 && part < trunkParts - 1) {
      const angle = random() * Math.PI * 2;
      limb(
        position,
        new Vector3(Math.cos(angle), 0.35, Math.sin(angle)),
        1.7,
        radius * 0.55,
        1,
        travelled,
      );
    }
  }
  // The crown: big limbs spreading wide from the top.
  const crown = 5;
  for (let index = 0; index < crown; index += 1) {
    const angle = (index / crown) * Math.PI * 2 + random() * 0.6;
    limb(
      position,
      new Vector3(Math.cos(angle) * 1.2, 0.45 + random() * 0.3, Math.sin(angle) * 0.7),
      2.3 + random() * 0.5,
      radius * 0.75,
      1,
      travelled,
    );
  }
  // Buttress roots.
  const roots = 8;
  for (let index = 0; index < roots; index += 1) {
    const angle = (index / roots) * Math.PI * 2 + random() * 0.4;
    root(
      new Vector3(Math.cos(angle) * 0.35, -2.85, Math.sin(angle) * 0.35),
      new Vector3(Math.cos(angle), -0.4, Math.sin(angle) * 0.6),
      2.4 + random() * 1.2,
      0.36,
      0,
      0,
    );
  }

  const maxDistance = Math.max(
    ...segments.map((segment) => segment.distance + segment.start.distanceTo(segment.end)),
  );
  return { segments, tips, hangs, maxDistance };
}

const UP = new Vector3(0, 1, 0);
const BARK = new Color('#5a4633');
const MOSS = new Color('#55704a');
const ROOT = new Color('#4a3a2a');
const LEAVES = ['#24543a', '#2f6a44', '#3b7f4c', '#4c9455', '#64a862'].map((hex) => new Color(hex));

function heroScroll(): number {
  return Math.min(1, window.scrollY / Math.max(1, window.innerHeight));
}

function AncientTree({ mode }: { readonly mode: 'hero' | 'panel' }) {
  const tree = useMemo(() => buildTree(), []);
  const wood = useRef<InstancedMesh>(null);
  const leaves = useRef<InstancedMesh>(null);
  const swaying = useRef<Group>(null);
  const whole = useRef<Group>(null);
  const grown = useRef(false);
  const dummy = useMemo(() => new Object3D(), []);

  const leafCount = Math.min(1400, tree.tips.length * 7);
  const leafSpots = useMemo(() => {
    const random = seeded(9);
    const spots: { position: Vector3; distance: number; scale: number; color: number }[] = [];
    for (let index = 0; index < leafCount; index += 1) {
      const tip = tree.tips[index % tree.tips.length];
      if (tip === undefined) {
        continue;
      }
      spots.push({
        position: tip.position
          .clone()
          .add(new Vector3((random() - 0.5) * 0.9, (random() - 0.3) * 0.5, (random() - 0.5) * 0.9)),
        distance: tip.distance,
        scale: 0.12 + random() * 0.16,
        color: Math.floor(random() * LEAVES.length),
      });
    }
    return spots;
  }, [tree, leafCount]);

  const lianas = useMemo(() => {
    const random = seeded(3);
    return tree.hangs.slice(0, 26).map((top) => {
      const drop = 1.6 + random() * 2.6;
      const curve = new CatmullRomCurve3([
        top,
        top.clone().add(new Vector3((random() - 0.5) * 0.4, -drop * 0.35, 0.1)),
        top.clone().add(new Vector3((random() - 0.5) * 0.3, -drop * 0.7, -0.05)),
        top.clone().add(new Vector3((random() - 0.5) * 0.2, -drop, 0)),
      ]);
      return new TubeGeometry(curve, 24, 0.012 + random() * 0.012, 4, false);
    });
  }, [tree]);

  const woodGeometry = useMemo(() => new CylinderGeometry(0.78, 1, 1, 7, 1), []);
  const leafGeometry = useMemo(() => new DodecahedronGeometry(1, 0), []);

  useLayoutEffect(() => {
    const mesh = wood.current;
    if (mesh === null) {
      return;
    }
    tree.segments.forEach((segment, index) => {
      const color = segment.root ? ROOT : BARK.clone().lerp(MOSS, Math.min(1, segment.depth / 4));
      mesh.setColorAt(index, color);
    });
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
    const leafMesh = leaves.current;
    if (leafMesh !== null) {
      leafSpots.forEach((spot, index) => {
        leafMesh.setColorAt(index, LEAVES[spot.color] ?? BARK);
      });
      if (leafMesh.instanceColor !== null) {
        leafMesh.instanceColor.needsUpdate = true;
      }
    }
  }, [tree, leafSpots]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const growth = Math.min(1, t / GROW_SECONDS);
    // Ease out: fast at first, settling slowly, like something very old waking up.
    const reach = (1 - (1 - growth) ** 3) * tree.maxDistance;

    if (!grown.current) {
      const mesh = wood.current;
      const leafMesh = leaves.current;
      if (mesh !== null) {
        const direction = new Vector3();
        const quaternion = new Quaternion();
        tree.segments.forEach((segment, index) => {
          const full = segment.start.distanceTo(segment.end);
          const fraction = Math.max(0, Math.min(1, (reach - segment.distance) / full));
          direction.subVectors(segment.end, segment.start).normalize();
          quaternion.setFromUnitVectors(UP, direction);
          const length = Math.max(0.0001, full * fraction + segment.radius * 0.35 * fraction);
          dummy.position.copy(segment.start).addScaledVector(direction, length / 2);
          dummy.quaternion.copy(quaternion);
          const thickness = fraction === 0 ? 0.0001 : segment.radius;
          dummy.scale.set(thickness, length, thickness);
          dummy.updateMatrix();
          mesh.setMatrixAt(index, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (leafMesh !== null) {
        leafSpots.forEach((spot, index) => {
          const appear = Math.max(0, Math.min(1, (reach - spot.distance + 0.2) / 0.6));
          dummy.position.copy(spot.position);
          dummy.rotation.set(index * 1.7, index * 2.3, index * 0.9);
          const s = spot.scale * appear;
          dummy.scale.set(s, s * 0.35, s);
          dummy.updateMatrix();
          leafMesh.setMatrixAt(index, dummy.matrix);
        });
        leafMesh.instanceMatrix.needsUpdate = true;
      }
      if (growth >= 1) {
        grown.current = true;
      }
    }

    // The canopy breathes in the wind; the whole tree turns slowly with the cursor.
    const sway = swaying.current;
    if (sway !== null) {
      sway.rotation.z = Math.sin(t * 0.5) * 0.012;
      sway.rotation.x = Math.sin(t * 0.37) * 0.008;
    }
    const group = whole.current;
    if (group !== null) {
      group.rotation.y +=
        (Math.sin(t * 0.06) * 0.35 + state.pointer.x * 0.25 - group.rotation.y) * 0.03;
    }

    // Look up into the canopy as the page scrolls.
    const scroll = mode === 'hero' ? heroScroll() : 0;
    const camera = state.camera;
    camera.position.x += (state.pointer.x * 0.9 - camera.position.x) * 0.03;
    camera.position.y += (-1.6 + state.pointer.y * 0.5 + scroll * 2.2 - camera.position.y) * 0.04;
    camera.lookAt(0, 0.6 + scroll * 1.5, 0);
  });

  return (
    <group ref={whole}>
      <instancedMesh
        ref={wood}
        args={[woodGeometry, undefined, tree.segments.length]}
        frustumCulled={false}
      >
        <meshStandardMaterial roughness={1} metalness={0} flatShading />
      </instancedMesh>
      <group ref={swaying}>
        <instancedMesh
          ref={leaves}
          args={[leafGeometry, undefined, leafSpots.length]}
          frustumCulled={false}
        >
          <meshStandardMaterial
            roughness={0.85}
            flatShading
            emissive="#12301c"
            emissiveIntensity={0.6}
          />
        </instancedMesh>
        {lianas.map((geometry, index) => (
          <mesh key={index} geometry={geometry}>
            <meshStandardMaterial color="#3a5236" roughness={1} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Bioluminescent mushrooms among the roots: a soft, slightly strange glow that breathes. */
function GlowingMushrooms() {
  const ring = useRef<Group>(null);
  // One shared cap material, so every mushroom breathes together.
  const caps = useMemo(
    () =>
      new MeshStandardMaterial({ color: '#a8f0d0', emissive: '#6fe8bf', emissiveIntensity: 1.8 }),
    [],
  );
  const spots = useMemo(() => {
    const random = seeded(77);
    return Array.from({ length: 16 }, () => {
      const angle = random() * Math.PI * 2;
      const distance = 1.1 + random() * 2.6;
      return {
        x: Math.cos(angle) * distance * 1.3,
        z: Math.sin(angle) * distance * 0.7 + 0.6,
        size: 0.06 + random() * 0.08,
      };
    });
  }, []);
  useFrame((state) => {
    // Every cap shares one material, so pulsing one pulses them all.
    const cap = ring.current?.getObjectByName('cap');
    if (cap instanceof Mesh && cap.material instanceof MeshStandardMaterial) {
      cap.material.emissiveIntensity = 1.6 + Math.sin(state.clock.elapsedTime * 0.8) * 0.6;
    }
  });
  return (
    <group ref={ring} position={[0, -3.32, 0]}>
      <pointLight position={[0, 0.4, 1.5]} intensity={2.5} distance={6} color="#7fe0c0" />
      {spots.map((spot, index) => (
        <group key={index} position={[spot.x, 0, spot.z]}>
          <mesh position={[0, spot.size * 0.9, 0]}>
            <cylinderGeometry args={[spot.size * 0.18, spot.size * 0.24, spot.size * 1.8, 6]} />
            <meshStandardMaterial color="#cfe8d8" emissive="#5fbf9a" emissiveIntensity={0.6} />
          </mesh>
          <mesh position={[0, spot.size * 1.8, 0]} scale={[1, 0.55, 1]} material={caps} name="cap">
            <sphereGeometry args={[spot.size, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** The hero centrepiece: an ancient tree in fog and moonlight, with fireflies. */
export default function AncientTreeScene({
  mode = 'hero',
  energy = 0.4,
}: {
  /** 'hero' looks up into the canopy as the page scrolls; 'panel' stays put in a card. */
  readonly mode?: 'hero' | 'panel';
  /** 0 (still) to 1 (deep focus): how many fireflies, and how lively. */
  readonly energy?: number;
}) {
  const level = Math.min(1, Math.max(0, energy));
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, -1.6, 10], fov: 50 }}
      gl={{ alpha: true, antialias: true }}
    >
      <fog attach="fog" args={mode === 'hero' ? ['#0b1a12', 9, 24] : ['#0e1f16', 11, 30]} />
      <hemisphereLight args={['#a9c9b2', '#1a2418', 1.1]} />
      {/* Moonlight from behind: rims the trunk, limbs and leaves so the silhouette reads. */}
      <directionalLight position={[4, 6, -9]} intensity={3.2} color="#b9e0c8" />
      <directionalLight position={[-5, 3, -7]} intensity={1.8} color="#8fc0d8" />
      <directionalLight position={[-6, 9, 4]} intensity={2.2} color="#e3efe2" />
      <pointLight position={[0, -2.6, 2.5]} intensity={6} distance={7} color="#d9b45a" />
      <AncientTree mode={mode} />
      <GlowingMushrooms />
      <Sparkles
        key={Math.round(level * 4)}
        count={mode === 'hero' ? 90 : Math.round(25 + level * 110)}
        scale={[14, 8, 7]}
        size={3.2}
        speed={0.15 + level * 0.6}
        color="#c9e07a"
        opacity={0.85}
      />
    </Canvas>
  );
}

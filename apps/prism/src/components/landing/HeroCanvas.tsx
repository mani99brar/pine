'use client'
/* eslint-disable react-hooks/immutability -- three.js materials and uniforms are mutated every frame inside useFrame by design; they are GPU state, not React state. */

/**
 * The hero scene (WebGL). Loaded only through next/dynamic with ssr:false, only when WebGL is available
 * and the visitor has not asked for reduced motion. The SVG poster stays underneath as the fallback.
 *
 * Sequence (~2.8s): beam draws in → crystal assembles from its facets → spectrum fan → three outcome
 * beams sized by the live market price. Afterwards the crystal turns slowly; the loop stops when the
 * canvas is offscreen or the tab is hidden.
 */
import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { crystalPoints3D, prng, seedFrom } from '@/lib/crystal'

export interface HeroPrices {
  yes: number
  no: number
  invalid: number
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
const phase = (t: number, a: number, b: number) => ease((t - a) / (b - a))

// ---------------------------------------------------------------------------
// Beam shader: soft gaussian across the width, fade along the length, slow shimmer.
// ---------------------------------------------------------------------------

const beamVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDraw;
  uniform float uTime;
  uniform float uSpectrum;
  varying vec2 vUv;
  vec3 spectrum(float t) {
    vec3 a = vec3(1.0, 0.42, 0.51);
    vec3 b = vec3(1.0, 0.71, 0.28);
    vec3 c = vec3(0.50, 0.89, 0.65);
    vec3 d = vec3(0.35, 0.85, 1.0);
    vec3 e = vec3(0.72, 0.60, 1.0);
    if (t < 0.25) return mix(a, b, t / 0.25);
    if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
    return mix(d, e, (t - 0.75) / 0.25);
  }
  void main() {
    float y = abs(vUv.y - 0.5) * 2.0;
    float body = pow(max(0.0, 1.0 - y), 1.8);
    float core = exp(-pow(y * 3.2, 2.0));
    float along = smoothstep(0.0, 0.06, vUv.x) * (1.0 - 0.75 * smoothstep(0.55, 1.0, vUv.x));
    float drawn = 1.0 - smoothstep(uDraw - 0.06, uDraw, vUv.x);
    float shimmer = 0.92 + 0.08 * sin(uTime * 1.7 + vUv.x * 14.0);
    vec3 col = mix(uColor, spectrum(vUv.y), uSpectrum);
    float a = (body * 0.7 + core * 0.6) * along * drawn * shimmer * uOpacity;
    gl_FragColor = vec4(col * (0.75 + core * 0.6), a);
  }
`

/** A tapered beam split into many segments so the across-width coordinate interpolates without skew. */
function taperedQuad(length: number, w0: number, w1: number, segments = 28): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const x = length * t
    const w = w0 + (w1 - w0) * t
    pos.push(x, -w / 2, 0, x, 0, 0, x, w / 2, 0)
    uv.push(t, 0, t, 0.5, t, 1)
    if (i < segments) {
      const a = i * 3
      const b = (i + 1) * 3
      idx.push(a, b, b + 1, a, b + 1, a + 1, a + 1, b + 1, b + 2, a + 1, b + 2, a + 2)
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

function useBeamMaterial(color: string) {
  return useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: 0 },
          uDraw: { value: 0 },
          uTime: { value: 0 },
          uSpectrum: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [color],
  )
}

// ---------------------------------------------------------------------------
// Crystal: convex hull of hash-seeded points; facets fly in and lock.
// ---------------------------------------------------------------------------

function Crystal({ seed, hue, start }: { seed: string; hue: string; start: React.RefObject<number> }) {
  const group = useRef<THREE.Group>(null)
  const edgesMat = useRef<THREE.LineBasicMaterial>(null)
  const coreMat = useRef<THREE.MeshBasicMaterial>(null)
  const { pointer } = useThree()

  const { geometry, edges, uniforms } = useMemo(() => {
    const pts = crystalPoints3D(seed).map(([x, y, z]) => new THREE.Vector3(x, y, z))
    const geo = new ConvexGeometry(pts)
    const position = geo.getAttribute('position') as THREE.BufferAttribute
    const count = position.count
    const offsets = new Float32Array(count * 3)
    const r = prng(seedFrom(`assemble:${seed}`))
    const c = new THREE.Vector3()
    for (let i = 0; i < count; i += 3) {
      c.set(0, 0, 0)
      for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(position, i + k))
      c.divideScalar(3).normalize().multiplyScalar(0.9 + r() * 1.6)
      c.y += (r() - 0.5) * 0.8
      for (let k = 0; k < 3; k++) offsets.set([c.x, c.y, c.z], (i + k) * 3)
    }
    geo.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 3))
    return { geometry: geo, edges: new THREE.EdgesGeometry(geo, 12), uniforms: { uAssemble: { value: 0 } } }
  }, [seed])

  // Glass without a transmission pass (consistent on every GPU, and cheaper): a tinted back shell for
  // body colour, then an additive front shell that only adds reflections and iridescence.
  const { back, front } = useMemo(() => {
    const patch = (m: THREE.Material) => {
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uAssemble = uniforms.uAssemble
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 aOffset;\nuniform float uAssemble;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += aOffset * (1.0 - uAssemble);')
      }
      return m
    }
    const back = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(hue).multiplyScalar(0.55),
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.62,
      roughness: 0.18,
      metalness: 0,
      envMapIntensity: 0.8,
      flatShading: true,
      depthWrite: false,
    })
    const front = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      side: THREE.FrontSide,
      roughness: 0.03,
      metalness: 0.15,
      iridescence: 1,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [120, 680],
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 2.2,
      flatShading: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    return { back: patch(back), front: patch(front) }
  }, [hue, uniforms])

  useEffect(
    () => () => {
      geometry.dispose()
      edges.dispose()
      back.dispose()
      front.dispose()
    },
    [geometry, edges, back, front],
  )

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    const a = phase(t, 0.25, 1.55)
    uniforms.uAssemble.value = a
    if (edgesMat.current) edgesMat.current.opacity = 0.5 * phase(t, 1.1, 1.8)
    if (coreMat.current) coreMat.current.opacity = 0.22 * phase(t, 1.2, 2.2) * (0.85 + 0.15 * Math.sin(state.clock.elapsedTime * 1.3))
    const g = group.current
    if (g) {
      g.rotation.y += delta * ((Math.PI * 2) / 40) + (1 - a) * delta * 2.4
      const targetX = pointer.y * 0.12
      const targetZ = -pointer.x * 0.06
      g.rotation.x += (targetX - g.rotation.x) * 0.04
      g.rotation.z += (targetZ - g.rotation.z) * 0.04
      g.position.y = Math.sin(state.clock.elapsedTime * 0.6) * 0.04
      const s = 0.66 + 0.1 * a
      g.scale.setScalar(s)
    }
  })

  return (
    <group ref={group}>
      <mesh geometry={geometry} scale={0.78} renderOrder={2}>
        <meshBasicMaterial ref={coreMat} color={hue} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh geometry={geometry} material={back} renderOrder={1} />
      <mesh geometry={geometry} material={front} renderOrder={3} />
      <lineSegments geometry={edges}>
        <lineBasicMaterial ref={edgesMat} color="#fff3e6" transparent opacity={0} depthWrite={false} />
      </lineSegments>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Light: incoming white beam, spectrum fan, three outcome beams.
// ---------------------------------------------------------------------------

const OUT = {
  yes: { color: '#FF6B83', angle: 0.26 },
  no: { color: '#A9B4C1', angle: 0.0 },
  invalid: { color: '#DCD6E8', angle: -0.24 },
} as const

function OutcomeBeam({ k, price, start }: { k: keyof typeof OUT; price: number; start: React.RefObject<number> }) {
  const mat = useBeamMaterial(OUT[k].color)
  const mesh = useRef<THREE.Mesh>(null)
  const width = useRef(0.02)
  const geo = useMemo(() => taperedQuad(5.2, 0.08, 1), [])
  useEffect(() => () => geo.dispose(), [geo])
  useFrame((state) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    const target = Math.max(0.07, price * 2.3)
    width.current += (target - width.current) * 0.05
    if (mesh.current) mesh.current.scale.set(1, width.current, 1)
    mat.uniforms.uTime!.value = state.clock.elapsedTime
    mat.uniforms.uDraw!.value = 1.08 * phase(t, 2.0, 2.9)
    const base = k === 'no' ? 0.62 : k === 'invalid' ? 0.55 : 0.95
    mat.uniforms.uOpacity!.value = base * phase(t, 2.0, 2.5)
  })
  return <mesh ref={mesh} geometry={geo} material={mat} position={[0.08, 0, -0.02]} rotation={[0, 0, OUT[k].angle]} />
}

function IncomingBeam({ start }: { start: React.RefObject<number> }) {
  const mat = useBeamMaterial('#FFF6EC')
  const geo = useMemo(() => taperedQuad(6, 0.12, 0.05), [])
  useEffect(() => () => geo.dispose(), [geo])
  useFrame((state) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    mat.uniforms.uTime!.value = state.clock.elapsedTime
    mat.uniforms.uDraw!.value = 1.08 * phase(t, 0, 0.7)
    mat.uniforms.uOpacity!.value = 1.1
  })
  return <mesh geometry={geo} material={mat} position={[-6, 0, -0.04]} />
}

function SpectrumFan({ start }: { start: React.RefObject<number> }) {
  const mat = useBeamMaterial('#ffffff')
  const geo = useMemo(() => taperedQuad(4.6, 0.1, 2.6), [])
  useEffect(() => () => geo.dispose(), [geo])
  useFrame((state) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    mat.uniforms.uTime!.value = state.clock.elapsedTime
    mat.uniforms.uSpectrum!.value = 1
    mat.uniforms.uDraw!.value = 1.08 * phase(t, 1.45, 2.0)
    const up = phase(t, 1.45, 1.9)
    const down = 1 - phase(t, 2.15, 2.9)
    mat.uniforms.uOpacity!.value = 0.85 * up * down
  })
  return <mesh geometry={geo} material={mat} position={[0.08, 0, -0.05]} />
}

// ---------------------------------------------------------------------------
// Caustic floor: light pooled under the crystal.
// ---------------------------------------------------------------------------

const causticFragment = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  float caustic(vec2 p, float t) {
    float v = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      p += vec2(sin(p.y * 1.7 + t * 0.6 + fi), cos(p.x * 1.3 - t * 0.5 + fi * 1.7)) * 0.45;
      v += abs(sin(p.x * 2.2 + p.y * 1.6 + t * 0.3));
    }
    return pow(1.0 - v / 3.0, 3.0);
  }
  void main() {
    vec2 p = (vUv - 0.5) * vec2(7.0, 4.0);
    float d = length((vUv - 0.5) * vec2(1.6, 2.4));
    float fade = smoothstep(0.62, 0.05, d);
    float c = caustic(p, uTime);
    vec3 warm = vec3(1.0, 0.72, 0.36);
    vec3 cool = vec3(0.4, 0.82, 1.0);
    vec3 col = mix(warm, cool, smoothstep(-0.3, 0.6, vUv.x - 0.5)) * c;
    gl_FragColor = vec4(col, c * fade * uOpacity);
  }
`

function CausticFloor({ start }: { start: React.RefObject<number> }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: causticFragment,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useFrame((state) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    mat.uniforms.uTime!.value = state.clock.elapsedTime
    mat.uniforms.uOpacity!.value = 0.5 * phase(t, 1.6, 2.8)
  })
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.4, -1.62, 0]} material={mat}>
      <planeGeometry args={[7, 4]} />
    </mesh>
  )
}

const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 2.2) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`

/** A soft light pooled behind the crystal; it breathes slowly once the crystal has assembled. */
function Glow({ hue, start }: { hue: string; start: React.RefObject<number> }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: glowFragment,
        uniforms: { uColor: { value: new THREE.Color(hue) }, uOpacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [hue],
  )
  useEffect(() => () => mat.dispose(), [mat])
  useFrame((state) => {
    const t = state.clock.elapsedTime - (start.current ?? 0)
    mat.uniforms.uOpacity!.value = 0.42 * phase(t, 0.9, 2.2) * (0.85 + 0.15 * Math.sin(state.clock.elapsedTime * 0.8))
  })
  return (
    <mesh position={[0, 0.05, -0.6]} material={mat}>
      <planeGeometry args={[3.6, 3.6]} />
    </mesh>
  )
}

function Scene({ seed, hue, prices }: { seed: string; hue: string; prices: HeroPrices }) {
  const start = useRef<number>(0)
  const { clock } = useThree()
  useEffect(() => {
    start.current = clock.elapsedTime + 0.05
  }, [clock])
  return (
    <>
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={5} color="#fff4e8" position={[0, 3.2, 1.5]} scale={[7, 0.35, 1]} />
        <Lightformer form="rect" intensity={4} color="#ffb648" position={[-3.2, 0.4, 1]} scale={[0.32, 6, 1]} />
        <Lightformer form="rect" intensity={4} color="#5ad8ff" position={[3.2, -0.4, 1]} scale={[0.32, 5, 1]} />
        <Lightformer form="rect" intensity={3} color="#ff6b83" position={[0, -3, 1.5]} scale={[6, 0.3, 1]} />
        <Lightformer form="ring" intensity={2.5} color="#ffffff" position={[1.5, 1.2, 4]} scale={0.6} />
      </Environment>
      <ambientLight intensity={0.15} />
      <Glow hue={hue} start={start} />
      <IncomingBeam start={start} />
      <SpectrumFan start={start} />
      <OutcomeBeam k="yes" price={prices.yes} start={start} />
      <OutcomeBeam k="no" price={prices.no} start={start} />
      <OutcomeBeam k="invalid" price={prices.invalid} start={start} />
      <Crystal seed={seed} hue={hue} start={start} />
      <CausticFloor start={start} />
    </>
  )
}

class CanvasBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onError()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

export default function HeroCanvas({
  seed,
  hue,
  prices,
  active,
  onReady,
  onFail,
}: {
  seed: string
  hue: string
  prices: HeroPrices
  active: boolean
  onReady: () => void
  onFail: () => void
}) {
  return (
    <CanvasBoundary onError={onFail}>
      <Canvas
        dpr={[1, 1.75]}
        frameloop={active ? 'always' : 'never'}
        camera={{ position: [0.9, 0.2, 5.6], fov: 34 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0)
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault()
            onFail()
          })
          requestAnimationFrame(() => onReady())
        }}
        aria-hidden
        style={{ position: 'absolute', inset: 0 }}
      >
        <Scene seed={seed} hue={hue} prices={prices} />
      </Canvas>
    </CanvasBoundary>
  )
}

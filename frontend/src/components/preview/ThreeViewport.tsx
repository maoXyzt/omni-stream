import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { Skeleton } from '@/components/ui/skeleton'

export interface ThreeViewportProps {
  loadObject: (signal: AbortSignal) => Promise<THREE.Object3D>
  emptyLabel?: string
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    const renderable = node as THREE.Mesh | THREE.Points | THREE.Line
    if ('geometry' in renderable && renderable.geometry) {
      renderable.geometry.dispose()
    }
    if ('material' in renderable && renderable.material) {
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material]
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose()
        }
        material.dispose()
      }
    }
  })
}

function frameObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
): void {
  const bounds = new THREE.Box3().setFromObject(object)
  if (bounds.isEmpty()) return

  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001)
  const distance = maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))

  camera.position.set(
    center.x + distance * 0.9,
    center.y + distance * 0.65,
    center.z + distance * 0.9,
  )
  camera.near = Math.max(maxDimension / 10_000, 0.001)
  camera.far = Math.max(maxDimension * 100, 100)
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.maxDistance = maxDimension * 20
  controls.minDistance = Math.max(maxDimension / 100, 0.001)
  controls.update()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'The 3D file could not be parsed.'
}

export function ThreeViewport({
  loadObject,
  emptyLabel = 'No renderable geometry was found.',
}: ThreeViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const abortController = new AbortController()
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x111827)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000)
    camera.position.set(2, 2, 2)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch (rendererError: unknown) {
      setStatus('error')
      setError(
        rendererError instanceof Error && rendererError.message
          ? rendererError.message
          : 'WebGL is unavailable in this browser.',
      )
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)
    scene.add(new THREE.GridHelper(10, 10, 0x475569, 0x1e293b))
    scene.add(new THREE.AxesHelper(1))

    let needsRender = true
    const resize = () => {
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      needsRender = true
    }
    resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    let animationFrame = 0
    const requestRender = () => { needsRender = true }
    controls.addEventListener('change', requestRender)
    const render = () => {
      controls.update()
      if (needsRender) {
        renderer.render(scene, camera)
        needsRender = false
      }
      animationFrame = window.requestAnimationFrame(render)
    }
    render()

    setStatus('loading')
    setError(null)
    void loadObject(abortController.signal)
      .then((object) => {
        if (abortController.signal.aborted) {
          disposeObject(object)
          return
        }
        const bounds = new THREE.Box3().setFromObject(object)
        if (bounds.isEmpty() ||
          ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
          disposeObject(object)
          setStatus('error')
          setError(emptyLabel)
          return
        }
        scene.add(object)
        frameObject(object, camera, controls)
        needsRender = true
        setStatus('ready')
      })
      .catch((loadError: unknown) => {
        if (abortController.signal.aborted) return
        setStatus('error')
        setError(errorMessage(loadError))
      })

    return () => {
      abortController.abort()
      resizeObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
      controls.removeEventListener('change', requestRender)
      controls.dispose()
      for (const child of scene.children) disposeObject(child)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [emptyLabel, loadObject])

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 w-full flex-1 overflow-hidden rounded-md"
      aria-label="3D preview"
    >
      {status === 'loading' && (
        <Skeleton className="absolute inset-0 z-10 rounded-md opacity-80" />
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/90 p-6">
          <div role="alert" className="max-w-lg space-y-2 text-center">
            <p className="text-sm font-medium text-destructive">
              Failed to load 3D preview.
            </p>
            <p className="text-xs text-muted-foreground">
              {error ?? emptyLabel}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

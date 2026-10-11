import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import {
  ThreeSceneTree,
  type SceneTreeNode,
} from './ThreeSceneTree'
import {
  ThreeViewportControls,
  type ThreeViewportDisplayMode,
  type ThreeViewportProjection,
  type ThreeViewportView,
} from './ThreeViewportControls'
import {
  ThreeViewportGizmo,
  type ThreeViewportGizmoHandle,
} from './ThreeViewportGizmo'
import {
  collectSceneTree,
  isSameSceneBranch,
  visibleSceneTreeEntries,
} from './three-viewport-utils'
import type { SceneTreeEntry } from './three-viewport-utils'

export interface ThreeViewportProps {
  loadObject: (signal: AbortSignal) => Promise<THREE.Object3D>
  emptyLabel?: string
}

type ViewportCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

interface MaterialAppearance {
  wireframe: boolean | null
  transparent: boolean
  opacity: number
  depthWrite: boolean
}

interface ViewportActions {
  fit: () => void
  reset: () => void
  setView: (view: ThreeViewportView) => void
  setProjection: (projection: ThreeViewportProjection) => void
  setDisplayMode: (mode: ThreeViewportDisplayMode) => void
  setGridVisible: (visible: boolean) => void
  setAxesVisible: (visible: boolean) => void
  select: (id: string | null, focus: boolean) => void
  toggleVisibility: (id: string) => void
  showAll: () => void
  isolateSelected: () => void
}

const DISPLAY_MODE_SOLID: ThreeViewportDisplayMode = 'solid'

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

function isWireframeMaterial(
  material: THREE.Material,
): material is THREE.Material & { wireframe: boolean } {
  return 'wireframe' in material
}

function applyDisplayMode(
  root: THREE.Object3D,
  mode: ThreeViewportDisplayMode,
  appearances: WeakMap<THREE.Material, MaterialAppearance>,
): void {
  root.traverse((node) => {
    const renderable = node as THREE.Mesh | THREE.Points | THREE.Line
    if (!('material' in renderable) || !renderable.material) return
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material]

    for (const material of materials) {
      const original = appearances.get(material) ?? {
        wireframe: isWireframeMaterial(material) ? material.wireframe : null,
        transparent: material.transparent,
        opacity: material.opacity,
        depthWrite: material.depthWrite,
      }
      appearances.set(material, original)

      if (isWireframeMaterial(material)) {
        material.wireframe = mode === 'wireframe' || original.wireframe === true
      }
      if (mode === 'transparent') {
        material.transparent = true
        material.opacity = Math.min(original.opacity, 0.35)
        material.depthWrite = false
      } else {
        material.transparent = original.transparent
        material.opacity = original.opacity
        material.depthWrite = original.depthWrite
      }
      material.needsUpdate = true
    }
  })
}

function updateOrthographicFrustum(
  camera: THREE.OrthographicCamera,
  aspect: number,
  halfHeight: number,
): void {
  camera.top = halfHeight
  camera.bottom = -halfHeight
  camera.right = halfHeight * aspect
  camera.left = -halfHeight * aspect
  camera.updateProjectionMatrix()
}

function directionForView(view: ThreeViewportView): THREE.Vector3 {
  switch (view) {
    case 'front': return new THREE.Vector3(0, 0, 1)
    case 'back': return new THREE.Vector3(0, 0, -1)
    case 'left': return new THREE.Vector3(-1, 0, 0)
    case 'right': return new THREE.Vector3(1, 0, 0)
    case 'top': return new THREE.Vector3(0, 1, 0)
    case 'bottom': return new THREE.Vector3(0, -1, 0)
  }
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
  const gizmoRef = useRef<ThreeViewportGizmoHandle>(null)
  const actionsRef = useRef<ViewportActions | null>(null)
  const nodeObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const selectedIdRef = useRef<string | null>(null)
  const projectionRef = useRef<ThreeViewportProjection>('perspective')
  const displayModeRef = useRef<ThreeViewportDisplayMode>(DISPLAY_MODE_SOLID)
  const showGridRef = useRef(true)
  const showAxesRef = useRef(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [projection, setProjection] = useState<ThreeViewportProjection>('perspective')
  const [displayMode, setDisplayMode] = useState<ThreeViewportDisplayMode>(DISPLAY_MODE_SOLID)
  const [currentView, setCurrentView] = useState<ThreeViewportView>('front')
  const [showGrid, setShowGrid] = useState(true)
  const [showAxes, setShowAxes] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hiddenNodeIds, setHiddenNodeIds] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [sceneTreeCollapsed, setSceneTreeCollapsed] = useState(true)
  const [sceneEntries, setSceneEntries] = useState<SceneTreeEntry[]>([])
  const [selectedObject, setSelectedObject] = useState<THREE.Object3D | null>(null)

  useEffect(() => { projectionRef.current = projection }, [projection])
  useEffect(() => { displayModeRef.current = displayMode }, [displayMode])
  useEffect(() => { showGridRef.current = showGrid }, [showGrid])
  useEffect(() => { showAxesRef.current = showAxes }, [showAxes])

  const visibleEntries = useMemo(
    () => visibleSceneTreeEntries(sceneEntries, expandedIds, searchQuery),
    [expandedIds, sceneEntries, searchQuery],
  )
  const treeNodes = useMemo<SceneTreeNode[]>(
    () => visibleEntries.map((entry) => ({
      ...entry,
      visible: !hiddenNodeIds.has(entry.id),
      selected: entry.id === selectedId,
      expanded: expandedIds.has(entry.id),
    })),
    [expandedIds, hiddenNodeIds, selectedId, visibleEntries],
  )
  const selectedEntry = useMemo(
    () => sceneEntries.find((entry) => entry.id === selectedId) ?? null,
    [sceneEntries, selectedId],
  )
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const abortController = new AbortController()
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x111827)
    const perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000)
    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1000)
    perspectiveCamera.position.set(2, 2, 2)
    let activeCamera: ViewportCamera = projectionRef.current === 'orthographic'
      ? orthographicCamera
      : perspectiveCamera
    let orthographicHalfHeight = 1
    let viewportAspect = 1

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
    renderer.domElement.className =
      'absolute inset-0 block size-full cursor-grab active:cursor-grabbing'
    renderer.domElement.tabIndex = 0
    renderer.domElement.setAttribute('aria-label', '3D model canvas')
    container.appendChild(renderer.domElement)

    let controls = new OrbitControls<THREE.Camera>(activeCamera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    const grid = new THREE.GridHelper(10, 10, 0x475569, 0x1e293b)
    const axes = new THREE.AxesHelper(1)
    grid.visible = showGridRef.current
    axes.visible = showAxesRef.current
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)
    scene.add(grid)
    scene.add(axes)

    const appearances = new WeakMap<THREE.Material, MaterialAppearance>()
    const objectNodeIds = new WeakMap<THREE.Object3D, string>()
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let modelRoot: THREE.Object3D | null = null
    let selectionHelper: THREE.BoxHelper | null = null
    let needsRender = true
    let pointerDown: { x: number; y: number } | null = null
    let animationFrame = 0

    const requestRender = () => { needsRender = true }
    const replaceControls = (camera: ViewportCamera, target: THREE.Vector3) => {
      const previous = controls
      const settings = {
        enableDamping: previous.enableDamping,
        dampingFactor: previous.dampingFactor,
        minDistance: previous.minDistance,
        maxDistance: previous.maxDistance,
        minZoom: previous.minZoom,
        maxZoom: previous.maxZoom,
        minTargetRadius: previous.minTargetRadius,
        maxTargetRadius: previous.maxTargetRadius,
        minPolarAngle: previous.minPolarAngle,
        maxPolarAngle: previous.maxPolarAngle,
        minAzimuthAngle: previous.minAzimuthAngle,
        maxAzimuthAngle: previous.maxAzimuthAngle,
        enableZoom: previous.enableZoom,
        zoomSpeed: previous.zoomSpeed,
        enableRotate: previous.enableRotate,
        rotateSpeed: previous.rotateSpeed,
        keyRotateSpeed: previous.keyRotateSpeed,
        enablePan: previous.enablePan,
        panSpeed: previous.panSpeed,
        keyPanSpeed: previous.keyPanSpeed,
        screenSpacePanning: previous.screenSpacePanning,
        zoomToCursor: previous.zoomToCursor,
        autoRotate: previous.autoRotate,
        autoRotateSpeed: previous.autoRotateSpeed,
      }
      controls.removeEventListener('change', requestRender)
      controls.dispose()
      controls = new OrbitControls<THREE.Camera>(camera, renderer.domElement)
      Object.assign(controls, settings)
      controls.target.copy(target)
      controls.addEventListener('change', requestRender)
    }
    const currentBounds = () => {
      if (!modelRoot) return null
      const bounds = new THREE.Box3().setFromObject(modelRoot)
      return bounds.isEmpty() ? null : bounds
    }
    const configureCamera = (camera: ViewportCamera, bounds: THREE.Box3, direction: THREE.Vector3) => {
      const dampingEnabled = controls.enableDamping
      controls.enableDamping = false
      controls.update()
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001)
      const distance = camera instanceof THREE.PerspectiveCamera
        ? maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.35
        : maxDimension * 1.6

      camera.position.copy(center).addScaledVector(direction.clone().normalize(), distance)
      camera.near = Math.max(maxDimension / 10_000, 0.001)
      camera.far = Math.max(maxDimension * 100, 100)
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = viewportAspect
        camera.updateProjectionMatrix()
      } else {
        orthographicHalfHeight = maxDimension * 0.65
        updateOrthographicFrustum(camera, viewportAspect, orthographicHalfHeight)
      }
      camera.lookAt(center)
      controls.target.copy(center)
      controls.maxDistance = maxDimension * 20
      controls.minDistance = Math.max(maxDimension / 100, 0.001)
      controls.minZoom = 0.1
      controls.maxZoom = 100
      controls.update()
      controls.enableDamping = dampingEnabled
      requestRender()
    }
    const frameObject = (object: THREE.Object3D) => {
      const bounds = new THREE.Box3().setFromObject(object)
      if (bounds.isEmpty()) return
      const center = bounds.getCenter(new THREE.Vector3())
      activeCamera.up.set(0, 1, 0)
      replaceControls(activeCamera, center)
      configureCamera(activeCamera, bounds, new THREE.Vector3(1, 0.75, 1))
    }
    const setStandardView = (view: ThreeViewportView) => {
      const bounds = currentBounds()
      if (!bounds) return
      activeCamera.up.copy(
        view === 'top'
          ? new THREE.Vector3(0, 0, -1)
          : view === 'bottom'
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0),
      )
      replaceControls(activeCamera, bounds.getCenter(new THREE.Vector3()))
      configureCamera(activeCamera, bounds, directionForView(view))
    }
    const setProjectionMode = (nextProjection: ThreeViewportProjection) => {
      if (
        (nextProjection === 'perspective' && activeCamera === perspectiveCamera) ||
        (nextProjection === 'orthographic' && activeCamera === orthographicCamera)
      ) return
      const target = controls.target.clone()
      const offset = activeCamera.position.clone().sub(target)
      const up = activeCamera.up.clone()
      const distance = Math.max(offset.length(), 0.001)
      const direction = offset.lengthSq() > 1e-12
        ? offset.normalize()
        : new THREE.Vector3(1, 0.75, 1).normalize()
      activeCamera = nextProjection === 'perspective' ? perspectiveCamera : orthographicCamera
      activeCamera.up.copy(up)
      activeCamera.position.copy(target).addScaledVector(direction, distance)
      activeCamera.lookAt(target)
      replaceControls(activeCamera, target)
      if (activeCamera instanceof THREE.PerspectiveCamera) {
        activeCamera.aspect = viewportAspect
        activeCamera.updateProjectionMatrix()
      } else {
        activeCamera.zoom = 1
        const bounds = currentBounds()
        orthographicHalfHeight = bounds
          ? Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.45, 0.001)
          : orthographicHalfHeight
        updateOrthographicFrustum(activeCamera, viewportAspect, orthographicHalfHeight)
      }
      controls.update()
      requestRender()
    }
    const updateSelectionHelper = (id: string | null) => {
      const object = id ? nodeObjectsRef.current.get(id) ?? null : null
      if (!object) {
        if (selectionHelper) selectionHelper.visible = false
        requestRender()
        return
      }
      if (!selectionHelper) {
        selectionHelper = new THREE.BoxHelper(object, 0x38bdf8)
        scene.add(selectionHelper)
      } else {
        selectionHelper.setFromObject(object)
        selectionHelper.visible = true
      }
      requestRender()
    }
    const selectNode = (id: string | null, focus: boolean) => {
      selectedIdRef.current = id
      setSelectedId(id)
      setSelectedObject(id ? nodeObjectsRef.current.get(id) ?? null : null)
      updateSelectionHelper(id)
      if (focus && id) {
        const object = nodeObjectsRef.current.get(id)
        if (object) frameObject(object)
      }
    }
    const setVisibility = (id: string, visible: boolean) => {
      const object = nodeObjectsRef.current.get(id)
      if (object) object.visible = visible
      setHiddenNodeIds((current) => {
        const next = new Set(current)
        if (visible) next.delete(id)
        else next.add(id)
        return next
      })
      requestRender()
    }
    const showAll = () => {
      for (const object of nodeObjectsRef.current.values()) object.visible = true
      setHiddenNodeIds(new Set())
      requestRender()
    }
    const isolateSelected = () => {
      const selected = selectedIdRef.current
        ? nodeObjectsRef.current.get(selectedIdRef.current)
        : null
      if (!selected) return
      const hidden = new Set<string>()
      for (const [id, object] of nodeObjectsRef.current) {
        const visible = isSameSceneBranch(object, selected)
        object.visible = visible
        if (!visible) hidden.add(id)
      }
      setHiddenNodeIds(hidden)
      requestRender()
    }

    actionsRef.current = {
      fit: () => { if (modelRoot) frameObject(modelRoot) },
      reset: () => { if (modelRoot) frameObject(modelRoot) },
      setView: setStandardView,
      setProjection: setProjectionMode,
      setDisplayMode: (mode) => {
        if (modelRoot) applyDisplayMode(modelRoot, mode, appearances)
        requestRender()
      },
      setGridVisible: (visible) => { grid.visible = visible; requestRender() },
      setAxesVisible: (visible) => { axes.visible = visible; requestRender() },
      select: selectNode,
      toggleVisibility: (id) => {
        const object = nodeObjectsRef.current.get(id)
        if (object) setVisibility(id, !object.visible)
      },
      showAll,
      isolateSelected,
    }

    const resize = () => {
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      viewportAspect = width / height
      if (activeCamera instanceof THREE.PerspectiveCamera) {
        activeCamera.aspect = viewportAspect
        activeCamera.updateProjectionMatrix()
      } else {
        updateOrthographicFrustum(activeCamera, viewportAspect, orthographicHalfHeight)
      }
      renderer.setSize(width, height, false)
      requestRender()
    }
    resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    controls.addEventListener('change', requestRender)

    const nodeForObject = (object: THREE.Object3D): string | null => {
      let current: THREE.Object3D | null = object
      while (current) {
        const id = objectNodeIds.get(current)
        if (id) return id
        current = current.parent
      }
      return null
    }
    const isEffectivelyVisible = (object: THREE.Object3D): boolean => {
      let current: THREE.Object3D | null = object
      while (current) {
        if (!current.visible) return false
        current = current.parent
      }
      return true
    }
    const selectAtPointer = (event: MouseEvent, focus: boolean) => {
      if (!modelRoot) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, activeCamera)
      const hit = raycaster
        .intersectObject(modelRoot, true)
        .find((intersection) => isEffectivelyVisible(intersection.object))
      selectNode(hit ? nodeForObject(hit.object) : null, focus)
    }
    const handlePointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY }
    }
    const handleClick = (event: MouseEvent) => {
      if (!pointerDown) return
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
      pointerDown = null
      if (moved <= 5) selectAtPointer(event, false)
    }
    const handleDoubleClick = (event: MouseEvent) => selectAtPointer(event, true)
    const preventContextMenu = (event: MouseEvent) => event.preventDefault()
    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('click', handleClick)
    renderer.domElement.addEventListener('dblclick', handleDoubleClick)
    renderer.domElement.addEventListener('contextmenu', preventContextMenu)

    const render = () => {
      const orbitChanged = controls.update()
      if (selectionHelper?.visible) selectionHelper.update()
      if (orbitChanged || needsRender) {
        gizmoRef.current?.updateOrientation(activeCamera.quaternion)
      }
      if (needsRender) {
        renderer.render(scene, activeCamera)
        needsRender = false
      }
      animationFrame = window.requestAnimationFrame(render)
    }
    render()

    setStatus('loading')
    setError(null)
    setSceneEntries([])
    setSelectedId(null)
    selectedIdRef.current = null
    setSelectedObject(null)
    setCurrentView('front')
    setHiddenNodeIds(new Set())
    setExpandedIds(new Set())
    setSceneTreeCollapsed(true)
    nodeObjectsRef.current = new Map()

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
        const tree = collectSceneTree(object)
        const modelSize = bounds.getSize(new THREE.Vector3())
        const maxDimension = Math.max(modelSize.x, modelSize.y, modelSize.z, 0.001)
        // Keep the reference helpers useful for models with very different scales.
        // The viewport uses Y-up, so the grid sits at the model's lowest Y bound.
        grid.scale.setScalar(maxDimension * 0.4)
        grid.position.y = bounds.min.y
        axes.scale.setScalar(maxDimension * 0.5)
        modelRoot = object
        nodeObjectsRef.current = tree.objects
        for (const [id, node] of tree.objects) objectNodeIds.set(node, id)
        scene.add(object)
        applyDisplayMode(object, displayModeRef.current, appearances)
        setSceneEntries(tree.entries)
        setExpandedIds(new Set(tree.entries.filter((entry) => entry.depth === 0).map((entry) => entry.id)))
        frameObject(object)
        needsRender = true
        setStatus('ready')
      })
      .catch((loadError: unknown) => {
        if (abortController.signal.aborted) return
        setStatus('error')
        setError(errorMessage(loadError))
      })

    return () => {
      actionsRef.current = null
      abortController.abort()
      resizeObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
      controls.removeEventListener('change', requestRender)
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('click', handleClick)
      renderer.domElement.removeEventListener('dblclick', handleDoubleClick)
      renderer.domElement.removeEventListener('contextmenu', preventContextMenu)
      for (const child of scene.children) disposeObject(child)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [emptyLabel, loadObject])

  const applyViewChange = (view: ThreeViewportView) => {
    setCurrentView(view)
    actionsRef.current?.setView(view)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'f') actionsRef.current?.fit()
    else if (key === 'r') actionsRef.current?.reset()
    else if (key === '1') applyViewChange('front')
    else if (key === '2') applyViewChange('back')
    else if (key === '3') applyViewChange('left')
    else if (key === '4') applyViewChange('right')
    else if (key === '5') applyViewChange('top')
    else if (key === '6') applyViewChange('bottom')
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 min-w-0 w-full flex-1 overflow-hidden rounded-md"
      aria-label="3D preview"
      onKeyDown={handleKeyDown}
    >
      {status === 'loading' && (
        <Skeleton className="absolute inset-0 z-10 rounded-md opacity-80" />
      )}
      <div className="pointer-events-none absolute inset-0 z-10 p-3">
        <div className="pointer-events-auto max-w-full">
          <ThreeViewportControls
            projection={projection}
            displayMode={displayMode}
            showGrid={showGrid}
            showAxes={showAxes}
            searchQuery={searchQuery}
            disabled={status !== 'ready'}
            onFitToView={() => actionsRef.current?.fit()}
            onResetView={() => actionsRef.current?.reset()}
            onViewChange={applyViewChange}
            onProjectionChange={(next) => {
              setProjection(next)
              actionsRef.current?.setProjection(next)
            }}
            onDisplayModeChange={(next) => {
              setDisplayMode(next)
              actionsRef.current?.setDisplayMode(next)
            }}
            onGridVisibilityChange={(visible) => {
              setShowGrid(visible)
              actionsRef.current?.setGridVisible(visible)
            }}
            onAxesVisibilityChange={(visible) => {
              setShowAxes(visible)
              actionsRef.current?.setAxesVisible(visible)
            }}
            onSearchQueryChange={setSearchQuery}
          />
        </div>
      </div>
      {sceneEntries.length > 0 && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 top-28 z-10">
          <div
            className={cn(
              'pointer-events-auto flex flex-col',
              sceneTreeCollapsed
                ? 'h-auto w-auto'
                : 'h-full w-72 max-w-[42%]',
            )}
          >
            <ThreeSceneTree
              nodes={treeNodes}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onSelect={(id) => actionsRef.current?.select(id, true)}
              onToggleVisibility={(id) => actionsRef.current?.toggleVisibility(id)}
              onShowAll={() => actionsRef.current?.showAll()}
              onIsolateSelected={() => actionsRef.current?.isolateSelected()}
              onToggleExpand={(id) => {
                setExpandedIds((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }}
              collapsed={sceneTreeCollapsed}
              onToggleCollapse={() => setSceneTreeCollapsed((current) => !current)}
              showSearch={false}
              hasSelection={selectedId !== null}
              className={sceneTreeCollapsed ? 'min-h-0 w-auto self-start' : 'min-h-0 flex-1'}
            />
          </div>
          {selectedEntry && selectedObject && (
            <div className="pointer-events-auto absolute bottom-60 right-0 max-w-64 rounded-md border bg-background/95 p-3 text-xs shadow-sm backdrop-blur">
              <p className="truncate font-medium" title={selectedEntry.name}>{selectedEntry.name}</p>
              <p className="text-muted-foreground">{selectedEntry.kind}</p>
              <p className="text-muted-foreground">{selectedObject.children.length} child object(s)</p>
            </div>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 z-20">
        <ThreeViewportGizmo
          ref={gizmoRef}
          view={currentView}
          disabled={status !== 'ready'}
          onViewChange={applyViewChange}
        />
      </div>
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

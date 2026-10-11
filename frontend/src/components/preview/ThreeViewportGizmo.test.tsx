import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { ThreeViewportGizmo } from './ThreeViewportGizmo'
import { projectGizmo, viewFromQuaternion } from './three-viewport-gizmo'

function cameraQuaternion(position: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
  const camera = new THREE.PerspectiveCamera()
  camera.position.copy(position)
  camera.up.copy(up)
  camera.lookAt(0, 0, 0)
  return camera.quaternion
}

describe('projectGizmo', () => {
  it('shows five points and four spokes for an aligned front view', () => {
    const projection = projectGizmo(cameraQuaternion(new THREE.Vector3(0, 0, 4)))
    const visible = projection.points.filter((point) => point.visible)

    expect(projection.view).toBe('front')
    expect(visible).toHaveLength(5)
    expect(visible.filter((point) => point.center)).toHaveLength(1)
    expect(visible.filter((point) => !point.center)).toHaveLength(4)
    expect(projection.points.filter((point) => point.visible && !point.center)).toHaveLength(4)
    expect(projection.points.find((point) => point.axis === 'z' && point.positive)?.center).toBe(true)
  })

  it('keeps all six endpoints in a free camera view', () => {
    const projection = projectGizmo(cameraQuaternion(new THREE.Vector3(3, 2, 4)))

    expect(projection.view).toBe('free')
    expect(projection.points.filter((point) => point.visible)).toHaveLength(6)
    expect(projection.points.filter((point) => point.center)).toHaveLength(0)
  })

  it('recognizes the bottom view with its camera orientation', () => {
    const quaternion = cameraQuaternion(new THREE.Vector3(0, -4, 0), new THREE.Vector3(0, 0, 1))

    expect(viewFromQuaternion(quaternion)).toBe('bottom')
    expect(projectGizmo(quaternion).points.filter((point) => point.visible)).toHaveLength(5)
  })
})

describe('ThreeViewportGizmo', () => {
  it('renders a compact, accessible view selector', () => {
    const markup = renderToStaticMarkup(
      <ThreeViewportGizmo view="front" onViewChange={() => {}} />,
    )

    expect(markup).toContain('aria-label="3D orientation controls"')
    expect(markup).toContain('aria-label="Current view: Front view"')
    expect(markup).toContain('前视')
    expect(markup).toContain('size-24')
    expect(markup.match(/<line\b/g)).toHaveLength(4)
    expect(markup).toContain('title="−X · 左视"')
    expect(markup).toContain('title="−Y · 底视"')
    expect(markup).toMatch(/style="[^"]*background-color:#fb7185/)
    expect(markup).toMatch(/style="[^"]*background-color:transparent/)
  })
})

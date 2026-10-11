import * as THREE from 'three'

import type { ThreeViewportView } from './ThreeViewportControls'

export type GizmoAxis = 'x' | 'y' | 'z'
export type GizmoView = ThreeViewportView | 'free'

export interface GizmoAxisPoint {
  axis: GizmoAxis
  positive: boolean
  label: string
  x: number
  y: number
  depth: number
  visible: boolean
  center: boolean
}

export interface GizmoProjection {
  points: GizmoAxisPoint[]
  view: GizmoView
}

const axes: GizmoAxis[] = ['x', 'y', 'z']
const axisVectors: Record<GizmoAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}
const standardViewDirections: Array<[ThreeViewportView, THREE.Vector3]> = [
  ['front', new THREE.Vector3(0, 0, 1)],
  ['back', new THREE.Vector3(0, 0, -1)],
  ['left', new THREE.Vector3(-1, 0, 0)],
  ['right', new THREE.Vector3(1, 0, 0)],
  ['top', new THREE.Vector3(0, 1, 0)],
  ['bottom', new THREE.Vector3(0, -1, 0)],
]

function viewDirection(quaternion: THREE.Quaternion): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
}

export function viewFromQuaternion(quaternion: THREE.Quaternion): GizmoView {
  const towardCamera = viewDirection(quaternion)
  let best: GizmoView = 'free'
  let bestDot = 0.9995
  for (const [view, direction] of standardViewDirections) {
    const dot = towardCamera.dot(direction)
    if (dot > bestDot) {
      best = view
      bestDot = dot
    }
  }
  return best
}

export function projectGizmo(
  quaternion: THREE.Quaternion,
  radius = 34,
): GizmoProjection {
  const inverse = quaternion.clone().invert()
  const projected = axes.flatMap((axis) => [true, false].map((positive) => {
    const vector = axisVectors[axis].clone()
    if (!positive) vector.negate()
    vector.applyQuaternion(inverse)
    return {
      axis,
      positive,
      label: positive ? axis.toUpperCase() : '',
      x: vector.x * radius,
      y: -vector.y * radius,
      depth: vector.z,
      visible: true,
      center: false,
    }
  }))

  const facing = projected.reduce((closest, point) => (
    point.depth > closest.depth ? point : closest
  ))
  const aligned = facing.depth >= 0.9995
  if (aligned) {
    for (const point of projected) {
      if (point.axis === facing.axis && point.positive !== facing.positive) {
        point.visible = false
      }
    }
  }
  facing.center = aligned

  return {
    points: projected,
    view: viewFromQuaternion(quaternion),
  }
}

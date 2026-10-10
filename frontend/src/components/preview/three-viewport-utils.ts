import * as THREE from 'three'

export interface SceneTreeEntry {
  id: string
  parentId: string | null
  depth: number
  name: string
  kind: string
  hasChildren: boolean
}

export interface SceneTreeData {
  entries: SceneTreeEntry[]
  objects: Map<string, THREE.Object3D>
}

function objectLabel(object: THREE.Object3D, index: number): string {
  const name = object.name.trim()
  if (name) return name
  const kind = object.type || 'Object'
  return `${kind} ${index + 1}`
}

/** Build a stable, flat representation of a Three.js object hierarchy. */
export function collectSceneTree(root: THREE.Object3D): SceneTreeData {
  const entries: SceneTreeEntry[] = []
  const objects = new Map<string, THREE.Object3D>()
  const objectIds = new WeakMap<THREE.Object3D, string>()
  const objectDepths = new WeakMap<THREE.Object3D, number>()
  let index = 0

  root.traverse((object) => {
    const id = `scene-node-${index}`
    const parentId = object.parent ? objectIds.get(object.parent) ?? null : null
    const depth = object.parent ? (objectDepths.get(object.parent) ?? 0) + 1 : 0
    const entry: SceneTreeEntry = {
      id,
      parentId,
      depth,
      name: objectLabel(object, index),
      kind: object.type || 'Object',
      hasChildren: object.children.length > 0,
    }
    entries.push(entry)
    objects.set(id, object)
    objectIds.set(object, id)
    objectDepths.set(object, depth)
    index += 1
  })

  return { entries, objects }
}

function addAncestors(
  entry: SceneTreeEntry,
  byId: Map<string, SceneTreeEntry>,
  relevant: Set<string>,
): void {
  let parentId = entry.parentId
  while (parentId) {
    if (relevant.has(parentId)) break
    relevant.add(parentId)
    parentId = byId.get(parentId)?.parentId ?? null
  }
}

/** Return the entries that should be visible in the tree for its expansion/search state. */
export function visibleSceneTreeEntries(
  entries: SceneTreeEntry[],
  expandedIds: ReadonlySet<string>,
  searchQuery: string,
): SceneTreeEntry[] {
  const query = searchQuery.trim().toLocaleLowerCase()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  if (query) {
    const relevant = new Set<string>()
    for (const entry of entries) {
      if (entry.name.toLocaleLowerCase().includes(query)) {
        relevant.add(entry.id)
        addAncestors(entry, byId, relevant)
      }
    }
    return entries.filter((entry) => relevant.has(entry.id))
  }

  return entries.filter((entry) => {
    let parentId = entry.parentId
    while (parentId) {
      if (!expandedIds.has(parentId)) return false
      parentId = byId.get(parentId)?.parentId ?? null
    }
    return true
  })
}

/** Whether two nodes are in the same selected branch of the object hierarchy. */
export function isSameSceneBranch(
  candidate: THREE.Object3D,
  selected: THREE.Object3D,
): boolean {
  if (candidate === selected) return true
  return candidate.getObjectById(selected.id) !== undefined || selected.getObjectById(candidate.id) !== undefined
}

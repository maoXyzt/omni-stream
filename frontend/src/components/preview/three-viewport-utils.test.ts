import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { collectSceneTree, visibleSceneTreeEntries } from './three-viewport-utils'

describe('three viewport scene tree helpers', () => {
  it('collects named and unnamed objects with their hierarchy', () => {
    const root = new THREE.Group()
    root.name = 'Assembly'
    const body = new THREE.Group()
    body.name = 'Body'
    body.add(new THREE.Mesh(new THREE.BoxGeometry()))
    root.add(body)

    const result = collectSceneTree(root)

    expect(result.entries.map((entry) => [entry.name, entry.depth, entry.parentId])).toEqual([
      ['Assembly', 0, null],
      ['Body', 1, 'scene-node-0'],
      ['Mesh 3', 2, 'scene-node-1'],
    ])
    expect(result.entries[0]?.hasChildren).toBe(true)
    expect(result.objects.get('scene-node-2')).toBeInstanceOf(THREE.Mesh)
  })

  it('keeps matching nodes and their ancestors during search', () => {
    const root = new THREE.Group()
    const body = new THREE.Group()
    body.name = 'Body'
    const bolt = new THREE.Mesh(new THREE.BoxGeometry())
    bolt.name = 'Bolt'
    body.add(bolt)
    root.add(body)
    const { entries } = collectSceneTree(root)

    expect(visibleSceneTreeEntries(entries, new Set(), 'bolt').map((entry) => entry.name)).toEqual([
      'Group 1',
      'Body',
      'Bolt',
    ])
  })

  it('hides collapsed descendants without a search query', () => {
    const root = new THREE.Group()
    const body = new THREE.Group()
    body.name = 'Body'
    body.add(new THREE.Mesh(new THREE.BoxGeometry()))
    root.add(body)
    const { entries } = collectSceneTree(root)

    expect(visibleSceneTreeEntries(entries, new Set(), '').map((entry) => entry.name)).toEqual(['Group 1'])
    expect(visibleSceneTreeEntries(entries, new Set(['scene-node-0', 'scene-node-1']), '').map((entry) => entry.name)).toEqual([
      'Group 1',
      'Body',
      'Mesh 3',
    ])
  })
})

import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

import type { ModelSource } from './model-source'
import { extensionOf } from './path'
import { joinSidecarKey } from './sidecar-path'

function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
  const hasColors = geometry.hasAttribute('color')
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: hasColors ? 0xffffff : 0x8b5cf6,
    vertexColors: hasColors,
    roughness: 0.65,
    metalness: 0.05,
    side: THREE.DoubleSide,
  }))
}

export async function parseModelObject(
  source: ModelSource, fileKey: string, signal: AbortSignal,
): Promise<THREE.Object3D> {
  signal.throwIfAborted()
  const { bytes } = source
  switch (extensionOf(fileKey)) {
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(bytes))
    case 'ply': {
      const geometry = new PLYLoader().parse(bytes)
      return geometry.index
        ? meshFromGeometry(geometry)
        : new THREE.Points(geometry, new THREE.PointsMaterial({
          size: 3, sizeAttenuation: false, vertexColors: geometry.hasAttribute('color'),
          color: geometry.hasAttribute('color') ? 0xffffff : 0x67e8f9,
        }))
    }
    case 'stl':
      return meshFromGeometry(new STLLoader().parse(bytes))
    case 'pcd': {
      const points = new PCDLoader().parse(bytes)
      points.material.size = 3
      points.material.sizeAttenuation = false
      return points
    }
    case 'fbx': {
      const manager = new THREE.LoadingManager()
      manager.setURLModifier((url) => {
        if (/^(data:|blob:)/i.test(url)) return url
        throw new Error('FBX textures must be embedded. Export a GLB to preview external textures.')
      })
      return new FBXLoader(manager).parse(bytes, '')
    }
    case 'glb':
    case 'gltf': {
      const manager = new THREE.LoadingManager()
      const urls = new Map<string, string>()
      manager.setURLModifier((url) => {
        if (/^(data:|blob:)/i.test(url)) return url
        signal.throwIfAborted()
        const key = joinSidecarKey(fileKey, url)
        const sidecar = source.sidecars.get(key)
        if (!sidecar) throw new Error('A model resource was not loaded: ' + key)
        let blobUrl = urls.get(key)
        if (!blobUrl) {
          blobUrl = URL.createObjectURL(new Blob([sidecar]))
          urls.set(key, blobUrl)
        }
        return blobUrl
      })
      try {
        return (await new GLTFLoader(manager).parseAsync(bytes, '')).scene
      } finally {
        for (const url of urls.values()) URL.revokeObjectURL(url)
      }
    }
    default:
      throw new Error('Unsupported 3D format.')
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as THREE from 'three'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DEFAULT_NPZ_LIMITS,
  NpzLimitError,
  pointDimensions,
  sampledPointRows,
  sampledScalarValues,
  type ParsedNpz,
} from '@/lib/npz'
import { decodeNumpy } from '@/lib/numpy-decode'
import { readPreviewBytes } from '@/lib/preview-bytes'

import { ThreeViewport } from './ThreeViewport'
import type { PreviewerProps } from './types'

const MAX_RENDERED_POINTS = 100_000

function makePointCloud(
  points: Float32Array,
  dimensions: number,
  labels: Float32Array | null,
): THREE.Points {
  const pointCount = points.length / dimensions
  const positions = new Float32Array(pointCount * 3)
  const colors = new Float32Array(pointCount * 3)

  let labelMin = Number.POSITIVE_INFINITY
  let labelMax = Number.NEGATIVE_INFINITY
  if (labels) {
    for (const label of labels) {
      if (Number.isFinite(label)) {
        labelMin = Math.min(labelMin, label)
        labelMax = Math.max(labelMax, label)
      }
    }
  }
  const labelRange = labelMax > labelMin ? labelMax - labelMin : 1
  const color = new THREE.Color()

  for (let index = 0; index < pointCount; index += 1) {
    const pointOffset = index * dimensions
    const outputOffset = index * 3
    positions[outputOffset] = points[pointOffset] ?? 0
    positions[outputOffset + 1] = points[pointOffset + 1] ?? 0
    positions[outputOffset + 2] = points[pointOffset + 2] ?? 0
    if (![positions[outputOffset], positions[outputOffset + 1], positions[outputOffset + 2]].every(Number.isFinite)) {
      throw new Error('The selected point cloud contains non-finite coordinates.')
    }

    if (labels && Number.isFinite(labels[index])) {
      const normalized = (labels[index] - labelMin) / labelRange
      color.setHSL(
        THREE.MathUtils.clamp(0.66 - normalized * 0.66, 0, 0.66),
        0.85,
        0.55,
      )
      colors[outputOffset] = color.r
      colors[outputOffset + 1] = color.g
      colors[outputOffset + 2] = color.b
    } else if (dimensions === 6) {
      colors[outputOffset] = ((points[pointOffset + 3] ?? 0) + 1) / 2
      colors[outputOffset + 1] = ((points[pointOffset + 4] ?? 0) + 1) / 2
      colors[outputOffset + 2] = ((points[pointOffset + 5] ?? 0) + 1) / 2
    } else {
      colors[outputOffset] = 0.25
      colors[outputOffset + 1] = 0.9
      colors[outputOffset + 2] = 0.75
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
  })
  return new THREE.Points(geometry, material)
}

function errorMessage(error: unknown): string {
  if (error instanceof NpzLimitError) return error.message
  if (error instanceof Error && error.message) return error.message
  return 'The NumPy file could not be parsed.'
}

function arrayEntries(parsed: ParsedNpz): Array<[string, ParsedNpz['arrays'][string]]> {
  return Object.entries(parsed.arrays)
}

async function fetchNumpyPreview(
  fileKey: string,
  src: string,
  storage: string | undefined,
  signal: AbortSignal,
): Promise<ParsedNpz> {
  const data = await readPreviewBytes({
    fileKey,
    src,
    storage,
    signal,
    maxBytes: DEFAULT_NPZ_LIMITS.maxCompressedBytes,
  })
  return decodeNumpy(data, fileKey, signal)
}

export function NpzPreview({ fileKey, src, storage }: PreviewerProps) {
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const numpyQuery = useQuery({
    queryKey: ['numpy-preview', storage ?? '', fileKey, src] as const,
    queryFn: ({ signal }) => fetchNumpyPreview(fileKey, src, storage, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    structuralSharing: false,
  })

  useEffect(() => setSelectedName(null), [fileKey, src, storage])

  const parsed = numpyQuery.data ?? null
  const error = numpyQuery.error ? errorMessage(numpyQuery.error) : null

  const entries = useMemo(() => (parsed ? arrayEntries(parsed) : []), [parsed])
  const pointEntries = useMemo(
    () => entries.filter(([, array]) => pointDimensions(array) !== null),
    [entries],
  )
  const activeName = selectedName ?? pointEntries[0]?.[0] ?? null
  const activeArray = activeName ? parsed?.arrays[activeName] : undefined
  const activeDimensions = activeArray ? pointDimensions(activeArray) : null
  const labelArray = activeName && parsed
    ? parsed.arrays[`${activeName}_label`] ?? parsed.arrays[`${activeName.replace(/_points$/, '')}_label`]
    : undefined

  const loadObject = useCallback(
    async (_signal: AbortSignal): Promise<THREE.Object3D> => {
      if (!activeArray || !activeDimensions) {
        throw new Error('Select a two-dimensional numeric array with 3 or 6 columns.')
      }
      const points = sampledPointRows(activeArray, MAX_RENDERED_POINTS)
      if (!points) throw new Error('The selected array is not a renderable point cloud.')
      const labels = labelArray && labelArray.shape[0] === activeArray.shape[0]
        ? sampledScalarValues(labelArray, MAX_RENDERED_POINTS)
        : null
      return makePointCloud(points, activeDimensions, labels)
    },
    [activeArray, activeDimensions, labelArray],
  )

  if (numpyQuery.isPending) {
    return <Skeleton className="min-h-0 w-full flex-1 rounded-md" />
  }
  if (numpyQuery.isError) {
    return (
      <div className="flex min-h-0 w-full flex-1 items-center justify-center rounded-md border p-6">
        <Alert variant="destructive" className="max-w-lg">
          <AlertTitle>Failed to read NumPy data.</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => void numpyQuery.refetch()}>Retry</Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  if (!parsed) return null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/80 p-3 text-xs">
        <div className="space-y-1">
          <p className="font-medium">NumPy arrays</p>
          <p className="text-muted-foreground">
            {entries.length} arrays · {(parsed.extractedBytes / 1024 / 1024).toFixed(2)} MiB extracted
          </p>
        </div>
        {pointEntries.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Point cloud</span>
            <select
              className="rounded-md border bg-background px-2 py-1"
              value={activeName ?? ''}
              onChange={(event) => setSelectedName(event.target.value || null)}
            >
              {pointEntries.map(([name, array]) => (
                <option key={name} value={name}>
                  {name} · {array.shape.join(' × ')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {pointEntries.length > 0 ? (
        <>
          <ThreeViewport loadObject={loadObject} />
          <div className="max-h-40 overflow-auto rounded-md border p-3 text-xs">
            <p className="mb-2 font-medium">Array metadata</p>
            <div className="space-y-2">
              {entries.map(([name, array]) => (
                <div key={name} className="flex flex-wrap gap-x-3 gap-y-1 rounded border p-2">
                  <span className="font-medium">{name}</span>
                  <span className="text-muted-foreground">{array.shape.join(' × ')}</span>
                  <span className="text-muted-foreground">{array.dtype}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            No `(N, 3)` or `(N, 6)` numeric array is available for point-cloud rendering.
          </p>
          <div className="space-y-2 text-xs">
            {entries.map(([name, array]) => (
              <div key={name} className="flex flex-wrap gap-x-3 gap-y-1 rounded border p-2">
                <span className="font-medium">{name}</span>
                <span className="text-muted-foreground">{array.shape.join(' × ')}</span>
                <span className="text-muted-foreground">{array.dtype}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

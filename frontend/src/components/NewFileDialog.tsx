import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FilePlus } from 'lucide-react'

import EditorImport from 'react-simple-code-editor'

import { ApiError } from '@/api/client'
import { putFile } from '@/api/files'
import {
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TokenPrompt } from '@/components/TokenPrompt'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

// Same CJS/ESM interop shim as ParquetSqlTab / TextPreview.
const Editor =
  (EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport

interface Props {
  storage: string
  /// Current directory prefix — trailing slash, or '' for the root (in
  /// multi-bucket S3 it already includes the leading `<bucket>/`). The new
  /// file lands at `prefix + name`.
  prefix: string
  onClose: () => void
}

/// Validate a bare file name (not a path). Returns an error string, or null
/// when valid. The backend `safe_join` is the real defence; this is just for a
/// friendly inline message and to keep creation scoped to the current dir.
function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.includes('/')) return 'Name cannot contain "/"'
  if (trimmed === '.' || trimmed === '..') return 'Invalid file name'
  return null
}

/// Create a new text/code file in the current directory. The name + an inline
/// editor for initial content; Create runs through a confirmation, handles a
/// 409 (offer overwrite) and a 401 (token prompt → retry), then invalidates
/// the listing so the file appears.
export function NewFileDialog({ storage, prefix, onClose }: Props) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [overwriteConfirm, setOverwriteConfirm] = useState(false)
  // Non-null while a 401 token prompt is up; holds the overwrite intent so the
  // post-token retry recreates the same request.
  const [authRetryOverwrite, setAuthRetryOverwrite] = useState<boolean | null>(
    null,
  )

  const trimmed = name.trim()
  const nameError = validateName(name)
  const newKey = `${prefix}${trimmed}`
  const lang = useMemo(() => detectLanguage(trimmed || 'untitled.txt'), [trimmed])

  // Load the grammar for the name's extension so the content editor highlights;
  // until it's ready, highlight() falls back to plain text.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (lang === 'plaintext' || isLanguageBundled(lang)) {
      setReady(true)
      return
    }
    setReady(false)
    let cancelled = false
    void ensureLanguage(lang).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [lang])

  const create = useCallback(
    async (overwrite: boolean) => {
      setSaving(true)
      try {
        await putFile(storage, newKey, content, overwrite)
        toast.success(`Created ${newKey}`)
        queryClient.invalidateQueries({ queryKey: ['list', storage, prefix] })
        setConfirmCreate(false)
        setOverwriteConfirm(false)
        onClose()
      } catch (err) {
        setConfirmCreate(false)
        if (err instanceof ApiError && err.status === 401) {
          setAuthRetryOverwrite(overwrite)
        } else if (err instanceof ApiError && err.status === 409) {
          setOverwriteConfirm(true)
        } else if (err instanceof ApiError) {
          toast.error(err.message)
        } else {
          toast.error(String(err))
        }
      } finally {
        setSaving(false)
      }
    },
    [storage, newKey, content, prefix, queryClient, onClose],
  )

  const canSubmit = trimmed.length > 0 && !nameError && !saving

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o && !saving) onClose()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>
              Create a file in{' '}
              <span className="font-mono text-foreground">
                {prefix || '(root)'}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Input
                autoFocus
                placeholder="example.txt"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) {
                    e.preventDefault()
                    setConfirmCreate(true)
                  }
                }}
              />
              {nameError && (
                <p className="text-xs text-destructive">{nameError}</p>
              )}
            </div>
            <div className="hljs max-h-[40vh] min-h-[8rem] overflow-auto rounded-md border border-border bg-muted/20 font-mono text-xs">
              <Editor
                value={content}
                onValueChange={setContent}
                highlight={(code) => highlight(code, ready ? lang : 'plaintext')}
                padding={12}
                placeholder="File contents…"
                textareaClassName="focus:outline-none"
                style={{ minHeight: '8rem' }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => setConfirmCreate(true)}>
              <FilePlus className="size-3.5" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmCreate}
        title="Create file?"
        description={
          <>
            This creates{' '}
            <span className="font-mono break-all text-foreground">{newKey}</span>{' '}
            on the server.
          </>
        }
        confirmLabel="Create"
        busy={saving}
        onConfirm={() => void create(false)}
        onCancel={() => setConfirmCreate(false)}
      />
      <ConfirmDialog
        open={overwriteConfirm}
        title="Overwrite existing file?"
        description={
          <>
            <span className="font-mono break-all text-foreground">{newKey}</span>{' '}
            already exists. Overwrite it?
          </>
        }
        confirmLabel="Overwrite"
        destructive
        busy={saving}
        onConfirm={() => void create(true)}
        onCancel={() => setOverwriteConfirm(false)}
      />
      {authRetryOverwrite !== null && (
        <TokenPrompt
          onSubmit={() => {
            const ow = authRetryOverwrite
            setAuthRetryOverwrite(null)
            void create(ow)
          }}
          onCancel={() => setAuthRetryOverwrite(null)}
        />
      )}
    </>
  )
}

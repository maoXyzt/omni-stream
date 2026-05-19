import { Toaster as SonnerToaster } from 'sonner'

/// App-wide toast surface. Mount once at the root (App.tsx); fire toasts
/// from anywhere via `import { toast } from 'sonner'`.
///
/// Configured to inherit the app's neutral palette via CSS variables —
/// no extra theming code needed; surfaces, borders, and text come from
/// `--popover`, `--border`, `--popover-foreground` (defined in
/// `src/index.css`) so light/dark modes follow the rest of the UI.
export function Toaster() {
  return (
    <SonnerToaster
      richColors
      closeButton
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-md',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
    />
  )
}

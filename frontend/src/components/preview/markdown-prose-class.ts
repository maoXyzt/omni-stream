import { cn } from '@/lib/utils'

// Full prose styling for GitHub-style Markdown documents. Lives in a separate
// module so it can be imported by both MarkdownProse.tsx (component) and
// ReadmePanel.tsx (directory README) without violating the react-refresh rule
// that prohibits non-component exports from .tsx files.
export const markdownProseClass = cn(
  'prose-readme text-sm leading-relaxed',
  // Headings
  '[&_h1]:mb-3 [&_h1]:mt-0 [&_h1]:border-b [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-semibold',
  '[&_h5]:mb-1 [&_h5]:mt-3 [&_h5]:text-sm [&_h5]:font-medium',
  '[&_h6]:mb-1 [&_h6]:mt-3 [&_h6]:text-sm [&_h6]:font-medium [&_h6]:text-muted-foreground',
  // Paragraphs & spacing
  '[&_p]:my-2',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  // Links
  '[&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline',
  // Inline code
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  // Code blocks
  '[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/60 [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  // Lists
  '[&_ul]:my-2 [&_ul]:ml-5 [&_ul]:list-disc [&_ul_ul]:mt-1',
  '[&_ol]:my-2 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol_ol]:mt-1',
  '[&_li]:my-0.5',
  // Blockquote
  '[&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
  // Horizontal rule
  '[&_hr]:my-4 [&_hr]:border-border',
  // Tables (GFM)
  '[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium',
  '[&_td]:border [&_td]:px-3 [&_td]:py-1.5',
  // Images
  '[&_img]:max-w-full [&_img]:rounded',
)

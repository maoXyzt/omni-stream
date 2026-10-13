/** Build a document for a sandboxed srcdoc frame, never for the app's DOM. */
export function htmlPreviewDocument(body: string, resourceUrl: string): string {
  const escapedUrl = resourceUrl
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  // Prefix before any authored content so relative resources stay in the
  // selected storage. A leading doctype keeps standalone pages and fragments
  // in standards mode. The original source (including scripts) stays intact.
  // The base URL would otherwise make `#section` links navigate to `/raw/...`
  // and replace the srcdoc document. Handle fragment-only links locally while
  // leaving file and external links unchanged.
  const fragmentNavigation = `<script>document.addEventListener('click',function(e){var a=e.target instanceof Element?e.target.closest('a[href^="#"]'):null;if(!a)return;var h=a.getAttribute('href');if(h===null)return;var raw=h.slice(1),id=raw,t=document.getElementById(id);if(!t&&raw){try{id=decodeURIComponent(raw);}catch{}t=document.getElementById(id);}e.preventDefault();location.hash=id?'#'+encodeURIComponent(id):'';if(t)t.scrollIntoView();});</script>`
  return `<!doctype html>\n<base href="${escapedUrl}">\n${fragmentNavigation}\n${body}`
}

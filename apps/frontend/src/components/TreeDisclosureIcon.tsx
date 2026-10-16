/** One compact, optically centered disclosure mark for every tree level. */
export function TreeDisclosureIcon({ open }: { open: boolean }) {
  return <svg className="tree-twisty" data-open={open || undefined} aria-hidden="true" focusable="false"
    viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>;
}

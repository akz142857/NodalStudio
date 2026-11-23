import type { ReactNode } from "react";

const documentOutline = <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8.5Zm0 0v5h5" />;
const sidebarOutline = <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />;

const paths = {
  map: <><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="6" y="7" width="8" height="6" rx="1" /><path d="M17 6h1m-1 4h1M6 17h3m4 0h5" /></>,
  table: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></>,
  list: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  function: <path d="M15 4h-2a3 3 0 0 0-3 2.6L8 17.4A3 3 0 0 1 5 20H3M5 10h10m0 5 6 6m0-6-6 6" />,
  procedure: <><rect x="3" y="3" width="12" height="6" rx="1.5" /><path d="M9 9v6a3 3 0 0 0 3 3h2" /><path d="m16 13 6 5-6 5Z" /></>,
  trigger: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  undo: <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 6 6v3" />,
  redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3" />,
  select: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  add: <path d="M12 5v14M5 12h14" />,
  remove: <path d="M5 12h14" />,
  check: <path d="m5 12 4 4 10-10" />,

  export: <><path d="M12 15V3m-4 4 4-4 4 4M5 11v9h14v-9" /></>,
  chart: <><path d="M4 20V10m8 10V4m8 16v-7" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  split: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 12h18" /></>,
  fit: <><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  relationships: <><rect x="3" y="3" width="7" height="6" rx="1.5" /><rect x="14" y="15" width="7" height="6" rx="1.5" /><path d="M6.5 9v7a2 2 0 0 0 2 2H14" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  firstPage: <path d="M5 5v14m11-13-6 6 6 6" />,
  lastPage: <path d="M19 5v14M8 6l6 6-6 6" />,
  question: <><path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0Z" /><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 15h.01" /></>,
  import: <path d="M12 3.5v11m-3.5-3.5 3.5 3.5 3.5-3.5M4.5 13.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4.5" />,
  preflight: <>{documentOutline}<path d="m8.75 13.25 2.25 2.25 4.25-4.25" /></>,
  report: <>{documentOutline}<path d="M9 12.5h6M9 16h4.5" /></>,
  viewer: <><rect x="3.5" y="4.5" width="17" height="13" rx="2" /><path d="M8.5 20.5h7M12 17.5v3m-2-12-2.5 2.5 2.5 2.5m4-5 2.5 2.5-2.5 2.5" /></>,
  refresh: <path d="M20.25 10a8.5 8.5 0 0 0-14.5-4L3.5 8.5m0-4.5v4.5H8m-4.25 5.5a8.5 8.5 0 0 0 14.5 4l2.25-2.5m0 4.5v-4.5H16" />,
  settings: <><path d="m10 3.5-.65 2.2-1.9 1.1-2.25-.6-2 3.5 1.6 1.6v1.4l-1.6 1.6 2 3.5 2.25-.6 1.9 1.1.65 2.2h4l.65-2.2 1.9-1.1 2.25.6 2-3.5-1.6-1.6v-1.4l1.6-1.6-2-3.5-2.25.6-1.9-1.1-.65-2.2Z" /><circle cx="12" cy="12" r="2.8" /></>,
  command: <path d="M8.5 8.5v-2a2 2 0 1 0-2 2h11a2 2 0 1 0-2-2v11a2 2 0 1 0 2-2h-11a2 2 0 1 0 2 2Z" />,
  lock: <><rect x="6" y="10" width="12" height="11" rx="2" /><path d="M9 10V7a3 3 0 0 1 6 0v3m-3 5v2" /></>,
  unlock: <><rect x="6" y="10" width="12" height="11" rx="2" /><path d="M9 10V7a3 3 0 0 1 5.8-1m-2.8 9v2" /></>,
  bell: <path d="M18 9.5a6 6 0 0 0-12 0c0 4.5-1.7 6-2.5 7.5h17c-.8-1.5-2.5-3-2.5-7.5Zm-8.25 10.25a2.5 2.5 0 0 0 4.5 0" />,
  sidebarLeft: <>{sidebarOutline}<path d="M9 4.5v15" /></>,
  sidebarRight: <>{sidebarOutline}<path d="M15 4.5v15" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  appearance: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" /></>,
  canvas: <><rect x="3" y="3" width="7" height="8" rx="1.5" /><rect x="14" y="13" width="7" height="8" rx="1.5" /><path d="M6.5 11v6H14M6 6h1m10 10h1" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10c0 6-12 3-12 9" /></>,
  ai: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="M20 2v4m-2-2h4" /></>,
  cloud: <path d="M6 19a4.5 4.5 0 0 1-1-8.9 7 7 0 0 1 13.5-1.6A5.3 5.3 0 0 1 18 19H6Z" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.5" /></>,
  warning: <><path d="M10.3 4.8a2 2 0 0 1 3.4 0l7.8 13A2 2 0 0 1 19.8 21H4.2a2 2 0 0 1-1.7-3.2Z" /><path d="M12 9v4m0 4h.01" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  sliders: <><path d="M4 6h5m6 0h5M4 12h10m6 0h0M4 18h2m6 0h8" /><circle cx="12" cy="6" r="3" /><circle cx="17" cy="12" r="3" /><circle cx="9" cy="18" r="3" /></>,
} satisfies Record<string, ReactNode>;

export type ActionIconName = keyof typeof paths;

export function ActionIcon({ name }: { name: ActionIconName }) {
  return <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

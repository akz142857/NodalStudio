import type { ReactNode } from "react";

const paths = {
  import: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 14v6h14v-6" /></>,
  preflight: <><path d="M14 3H6v18h12V7l-4-4Z" /><path d="M14 3v4h4m-9 7 2 2 4-5" /></>,
  report: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 12h8m-8 4h5" /></>,
  viewer: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8m-4-3v3m-2-13-3 3 3 3m4-6 3 3-3 3" /></>,
  refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></>,
  settings: <g transform="translate(1 0)"><path d="m9 3-.6 2.3-2 .9-2.2-.6-2 3.4 1.6 1.7v2.6L2.2 15l2 3.4 2.2-.6 2 .9L9 21h4l.6-2.3 2-.9 2.2.6 2-3.4-1.6-1.7v-2.6L19.8 9l-2-3.4-2.2.6-2-.9L13 3H9Z" /><circle cx="11" cy="12" r="3" /></g>,
  command: <path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 13h4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
} satisfies Record<string, ReactNode>;

export type ActionIconName = keyof typeof paths;

export function ActionIcon({ name }: { name: ActionIconName }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

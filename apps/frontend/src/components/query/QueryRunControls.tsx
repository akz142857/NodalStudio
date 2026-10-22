import { useEffect, useId, useRef, useState } from "react";
import { queryKeys, queryMenuKeys } from "./query-shortcuts";
import { ActionIcon } from "../ActionIcon";

interface Actions {
  executing: boolean;
  disabled: boolean;
  onRun: () => void;
  onRunCurrent: () => void;
  onStop: () => void;
}
export function QueryExecutionItems({ executing, disabled, onRun, onRunCurrent, onStop }: Actions) {
  return <>
    <button type="button" role="menuitem" disabled={disabled || executing} onClick={onRun}><span>Run</span>{" "}<kbd>{queryKeys.run}</kbd></button>
    <button type="button" role="menuitem" disabled={disabled || executing} onClick={onRunCurrent}><span>Run Current Statement</span>{" "}<kbd>{queryKeys.current}</kbd></button>
    <button type="button" role="menuitem" disabled={!executing} onClick={onStop}><span>Stop</span>{" "}<kbd>{queryKeys.stop}</kbd></button>
  </>;
}
export function QueryRunControls(props: Actions) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function perform(action: () => void) { setOpen(false); trigger.current?.focus(); action(); }
  return <div className="query-execution-controls" ref={root} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    {props.executing ? <button type="button" className="query-cancel" title={`Stop (${queryKeys.stop})`} onClick={props.onStop}><ActionIcon name="stop" />Stop <kbd>{queryKeys.stop}</kbd></button> : <button type="button" className="query-run" disabled={props.disabled} title={`Run selection or editor SQL (${queryKeys.run}; ⌘/Ctrl+Enter also supported)`} onClick={props.onRun}><ActionIcon name="play" />Run <kbd>{queryKeys.run}</kbd></button>}
    <button ref={trigger} type="button" className="query-execution-disclosure" aria-label="Query execution options" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}><ActionIcon name="chevronUp" /></button>
    {open ? <div ref={menu} id={id} role="menu" aria-label="Query execution" className="query-execution-menu" onKeyDown={queryMenuKeys}><QueryExecutionItems {...props} onRun={() => perform(props.onRun)} onRunCurrent={() => perform(props.onRunCurrent)} onStop={() => perform(props.onStop)} /></div> : null}
  </div>;
}

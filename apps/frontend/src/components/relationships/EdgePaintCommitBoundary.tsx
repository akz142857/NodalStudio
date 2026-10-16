import { Component, type ReactNode } from "react";

interface Props { root: SVGSVGElement | null; count: number; scope?: object; enabled: boolean; children: ReactNode }
type Snapshot = { node: SVGSVGElement; parent: Node; next: ChildNode | null; focused: Element | null } | null;

/** A large edge retirement otherwise removes many marker clients individually
 * from the live WebKit document. Detach only their shared paint root for that
 * React commit; node DOM, store subscriptions and React ownership stay intact. */
export class EdgePaintCommitBoundary extends Component<Props, Record<string, never>, Snapshot> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot {
    const node = this.props.root;
    if (!this.props.enabled || !previous.enabled || previous.scope !== this.props.scope || previous.root !== node
      || Math.abs(previous.count - this.props.count) < 256 || !node?.isConnected || !node.parentNode) return null;
    const snapshot = { node, parent: node.parentNode, next: node.nextSibling, focused: node.contains(document.activeElement) ? document.activeElement : null };
    snapshot.parent.removeChild(node);
    return snapshot;
  }
  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot) {
    if (!snapshot) return;
    snapshot.parent.insertBefore(snapshot.node, snapshot.next?.parentNode === snapshot.parent ? snapshot.next : null);
    if (snapshot.focused?.isConnected && snapshot.focused instanceof SVGElement) snapshot.focused.focus({ preventScroll: true });
  }
  render() { return this.props.children; }
}

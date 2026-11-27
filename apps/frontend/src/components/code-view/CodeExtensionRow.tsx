import { useId, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { CodeOpenVsxItem } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";

export function CodeExtensionRow({ item, verified, status, warning, onOpen, actions, children }: {
  item: Pick<CodeOpenVsxItem, "name" | "description" | "publisher" | "version">;
  verified?: boolean;
  status?: string;
  warning?: boolean;
  onOpen: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const metaId = useId();
  const initials = item.name.match(/[\p{L}\p{N}]+/gu)?.slice(0, 2).map((part) => [...part][0]).join("").toUpperCase();
  return <li className="code-extension-row">
    <button type="button" className="code-extension-entry" aria-haspopup="dialog" aria-labelledby={nameId}
      aria-describedby={metaId} onClick={onOpen}>
      <span className="code-extension-symbol" aria-hidden="true">{initials || <ActionIcon name="extensions" />}</span>
      <span className="code-extension-copy">
        <strong id={nameId} className="code-extension-line" title={item.name}>{item.name}</strong>
        <span id={metaId} className="code-extension-copy">
          {item.description && <span className="code-extension-description code-extension-line" title={item.description}>{item.description}</span>}
          <span className="code-extension-meta">
            {verified && <span className="code-extension-verified" aria-label={t("codeReview.extensions.marketVerified")}
              title={t("codeReview.extensions.marketVerified")} role="img"><ActionIcon name="shield" /></span>}
            <span className="code-extension-line" title={item.publisher}>{item.publisher}</span>
            <span className="code-extension-version-text">{item.version}</span>
          </span>
        </span>
      </span>
    </button>
    {actions}
    {status && <p className="code-extension-state" data-warning={warning || undefined} role="status">{status}</p>}
    {children}
  </li>;
}

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeNewEntryKind } from "../../platform/code-review";

export function CodeNewEntryDialog({ kind, location, create, onCreated, onDismiss }: {
  kind: CodeNewEntryKind;
  location: string;
  create: (name: string) => Promise<string>;
  onCreated: (path: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const mutation = useMutation({ mutationFn: create, onSuccess: onCreated, networkMode: "always" });
  const title = t(kind === "file" ? "codeReview.files.newFile" : "codeReview.files.newFolder");
  const error = String(mutation.error);
  const message = error === "codeReviewEntryInvalidName" ? "codeReview.files.invalidName"
    : error === "codeReviewEntryExists" ? "codeReview.files.alreadyExists" : "codeReview.files.createFailed";
  return <ModalSurface label={title} onDismiss={() => { if (!mutation.isPending) onDismiss(); }}>
    <form className="code-project-group-form ds-surface" onSubmit={(event) => {
      event.preventDefault();
      if (name.trim() && !mutation.isPending) mutation.mutate(name.trim());
    }}>
      <h2>{title}</h2>
      <p>{t("codeReview.files.createIn", { location })}</p>
      <label>{t("codeReview.files.entryName")}<input type="text" value={name} maxLength={255} data-modal-focus
        aria-invalid={mutation.isError || undefined} disabled={mutation.isPending}
        onChange={(event) => { setName(event.target.value); mutation.reset(); }} /></label>
      {mutation.isError && <p role="alert">{t(message)}</p>}
      <div className="code-review-note-actions">
        <Button disabled={mutation.isPending} onClick={onDismiss}>{t("codeReview.cancel")}</Button>
        <Button type="submit" variant="primary" busy={mutation.isPending} disabled={!name.trim()}>{t("codeReview.files.create")}</Button>
      </div>
    </form>
  </ModalSurface>;
}

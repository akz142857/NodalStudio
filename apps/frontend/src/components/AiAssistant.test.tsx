import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AiExplanation, NodalStudioPlatform } from "../platform";
import { AiAssistant } from "./AiAssistant";

const explanation: AiExplanation = {
  provider: "offline-schema",
  model: null,
  generatedAt: null,
  title: "users 的结构解释",
  explanation: "仅根据元数据生成。",
  evidence: ["public.users：3 个字段，1 条出向关系"],
  candidateAnnotation: "候选说明，需人工确认。",
  contextPolicy: {
    relationshipDepth: 1,
    credentialsIncluded: false,
    rowDataIncluded: false,
    completeSchemaIncluded: false,
  },
};

describe("AiAssistant", () => {
  it("uses the explicit Settings state and requires confirmation before saving", async () => {
    const explainSchema = vi.fn().mockResolvedValue(explanation);
    const confirm = vi.fn().mockResolvedValue(undefined);
    const platform = { explainSchema } as unknown as NodalStudioPlatform;
    render(
      <AiAssistant
        platform={platform}
        input={{
          snapshotId: "snapshot",
          targetType: "table",
          objectKey: { kind: "table", schema: "public", name: "users" },
        }}
        onConfirmCandidate={confirm}
        enabled
        providerLabel="Offline"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Explain from metadata" }));

    await screen.findByText("候选说明，需人工确认。");
    expect(confirm).not.toHaveBeenCalled();
    expect(explainSchema).toHaveBeenCalledWith(
      expect.objectContaining({ aiEnabled: true, relationshipDepth: 1 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm and save annotation" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("候选说明，需人工确认。"));
  });
});


it("clears old answers when the snapshot changes and ignores late responses", async () => {
  let finish!: (answer: AiExplanation) => void;
  const explainSchema = vi.fn().mockResolvedValueOnce(explanation).mockImplementationOnce(() => new Promise<AiExplanation>((resolve) => { finish = resolve; }));
  const props = { platform: { explainSchema } as unknown as NodalStudioPlatform, enabled: true, providerLabel: "Offline", onOpenSettings: vi.fn() };
  const view = render(<AiAssistant {...props} input={{ snapshotId: "old", targetType: "changeSet" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Explain from metadata" }));
  await screen.findByText(explanation.title);
  view.rerender(<AiAssistant {...props} input={{ snapshotId: "middle", targetType: "changeSet" }} />);
  expect(screen.queryByText(explanation.title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Explain from metadata" }));
  view.rerender(<AiAssistant {...props} input={{ snapshotId: "new", targetType: "changeSet" }} />);
  await act(async () => { finish(explanation); await Promise.resolve(); });
  expect(screen.queryByText(explanation.title)).toBeNull();
  expect(screen.getByRole("button", { name: "Explain from metadata" })).toBeEnabled();
});

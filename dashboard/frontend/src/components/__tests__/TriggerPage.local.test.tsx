import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TriggerPage from "../TriggerPage";
import type { InputVideo } from "../../types";

const mocks = vi.hoisted(() => ({
  startExecution: vi.fn(), fetchInputVideoUrl: vi.fn(), fetchExecutionStatus: vi.fn(),
}));
vi.mock("../../config", () => ({ IS_LOCAL_BACKEND: true }));
vi.mock("../../api", () => mocks);
vi.mock("../VideoUpload", () => ({ default: () => null }));
vi.mock("../InputVideoSelector", () => ({
  default: ({ onSelect }: { onSelect: (video: InputVideo) => void }) => (
    <button onClick={() => onSelect({ video_id: "sample", key: "input/sample.mp4", size_mb: 1, last_modified: "2026-09-16" })}>Choose sample</button>
  ),
}));

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("local processing submission", () => {
  it("submits the latest silence threshold and identifies Azure billing", async () => {
    mocks.fetchInputVideoUrl.mockResolvedValue("/api/media/sample.mp4");
    mocks.startExecution.mockResolvedValue({ execution_arn: "local-job", start_date: "2026-09-16" });
    mocks.fetchExecutionStatus.mockResolvedValue({
      execution_arn: "local-job", status: "SUCCEEDED", start_date: "2026-09-16",
      stop_date: "2026-09-16", steps: [], error: null, cause: null,
    });
    const onExecutionComplete = vi.fn();
    render(<TriggerPage onExecutionComplete={onExecutionComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose sample" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Trigger Pipeline" }));
    expect(screen.getByText(/paid Azure OpenAI and Speech services/)).toBeVisible();
    expect(screen.queryByText(/AWS costs/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.startExecution).toHaveBeenCalledWith("sample", 9));
    await waitFor(() => expect(onExecutionComplete).toHaveBeenCalledOnce());
  });

  it("prevents confirming if backend readiness is lost", async () => {
    mocks.fetchInputVideoUrl.mockResolvedValue("/api/media/sample.mp4");
    const view = render(<TriggerPage processingReady />);
    fireEvent.click(screen.getByRole("button", { name: "Choose sample" }));
    fireEvent.click(screen.getByRole("button", { name: "Trigger Pipeline" }));
    view.rerender(<TriggerPage processingReady={false} />);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mocks.startExecution).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Loading preview…")).toBeNull());
  });
});

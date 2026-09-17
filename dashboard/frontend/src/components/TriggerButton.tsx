import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IS_LOCAL_BACKEND } from "../config";

interface TriggerButtonProps {
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

function TriggerButton({ disabled, loading, onClick }: TriggerButtonProps) {
  const isDisabled = disabled || loading;
  const [confirming, setConfirming] = useState(false);

  const handleClick = () => {
    if (isDisabled) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onClick();
  };

  const handleCancel = () => {
    setConfirming(false);
  };

  if (confirming) {
    return (
      <div className="inline-flex items-center gap-2">
        <span className="text-sm text-[var(--on-surface-muted)]">
          {IS_LOCAL_BACKEND
            ? "This uses paid Azure OpenAI and Speech services. Charges depend on usage. Continue?"
            : "This will incur AWS costs (~$0.15–$0.30). Continue?"}
        </span>
        <Button
          type="button"
          onClick={handleClick}
          disabled={isDisabled}
          className="px-4 py-2 rounded-[var(--radius-md)] font-semibold text-sm bg-gradient-to-br from-[var(--primary-light)] to-[var(--primary)] text-[var(--surface)] hover:brightness-110"
        >
          Confirm
        </Button>
        <Button
          type="button"
          onClick={handleCancel}
          variant="outline"
          className="px-4 py-2 rounded-[var(--radius-md)] text-sm"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      disabled={isDisabled}
      onClick={handleClick}
      title={
        disabled && !loading
          ? IS_LOCAL_BACKEND ? "Select a video and complete backend setup" : "Select a video and pipeline version"
          : undefined
      }
      className={cn(
        "inline-flex items-center gap-2 px-6 py-3 rounded-[var(--radius-md)] font-semibold text-[15px]",
        loading || disabled
          ? "bg-[var(--surface-container-highest)] text-[var(--on-surface-muted)] cursor-not-allowed"
          : "bg-gradient-to-br from-[var(--primary-light)] to-[var(--primary)] text-[var(--surface)] hover:brightness-110",
      )}
    >
      {loading ? (
        <>
          <span
            className="h-3.5 w-3.5 border-2 border-[rgba(0,229,255,0.3)] border-t-[var(--primary)] rounded-full animate-spin"
            aria-hidden="true"
          />
          Starting…
        </>
      ) : (
        "Trigger Pipeline"
      )}
    </Button>
  );
}

export default TriggerButton;

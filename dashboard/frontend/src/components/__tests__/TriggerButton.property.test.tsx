import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import * as fc from "fast-check";
import TriggerButton from "../TriggerButton";

/**
 * Feature: shadcn-ui-migration, Property 3: TriggerButton disabled state is correct for all prop combinations
 * Validates: Requirements 5.5
 *
 * For any combination of `disabled` (boolean) and `loading` (boolean) props,
 * the rendered button element's `disabled` attribute should be `true` when either
 * `disabled` or `loading` is `true`. An enabled button must show a cost
 * confirmation before invoking `onClick`; cancelling must not invoke it.
 */
describe("Property 3: TriggerButton disabled state is correct for all prop combinations", () => {
  it("only enabled buttons can open confirmation, and execution requires confirming", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (disabled, loading) => {
        const onClick = vi.fn();
        const { container, unmount } = render(
          <TriggerButton
            disabled={disabled}
            loading={loading}
            onClick={onClick}
          />,
        );

        try {
          const view = within(container);
          const button = view.getByRole("button", {
            name: loading ? "Starting…" : "Trigger Pipeline",
          });
          const shouldBeDisabled = disabled || loading;

          if (shouldBeDisabled) {
            expect(button).toBeDisabled();
          } else {
            expect(button).toBeEnabled();
          }

          fireEvent.click(button);
          expect(onClick).not.toHaveBeenCalled();

          if (shouldBeDisabled) {
            expect(view.queryByRole("button", { name: "Confirm" })).toBeNull();
            return;
          }

          expect(view.getByText(/This will incur AWS costs/)).toBeVisible();
          expect(view.getByRole("button", { name: "Confirm" })).toBeEnabled();

          fireEvent.click(view.getByRole("button", { name: "Cancel" }));
          expect(onClick).not.toHaveBeenCalled();
          expect(view.queryByRole("button", { name: "Confirm" })).toBeNull();

          fireEvent.click(view.getByRole("button", { name: "Trigger Pipeline" }));
          expect(onClick).not.toHaveBeenCalled();
          fireEvent.click(view.getByRole("button", { name: "Confirm" }));
          expect(onClick).toHaveBeenCalledTimes(1);
          expect(view.getByRole("button", { name: "Trigger Pipeline" })).toBeEnabled();
          expect(view.queryByRole("button", { name: "Confirm" })).toBeNull();
        } finally {
          unmount();
          container.remove();
        }
      }),
      { numRuns: 100 },
    );
  });
});

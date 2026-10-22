import type { ReactNode } from 'react';

export interface AIActionProps {
  /** Short machine-friendly name, used to build the element id (e.g. "log_in"). */
  name?: string;
  /** What pressing/typing into the wrapped element does. Shown to the LLM. */
  description?: string;
  children?: ReactNode;
}

/**
 * Annotates the first interactive element (button, input, switch) inside it with a name and a
 * description of what it does. Renders its children unchanged.
 *
 *   <AIAction name="checkout" description="Places the order and charges the saved card">
 *     <Button title="Pay" onPress={pay} />
 *   </AIAction>
 */
export function AIAction({ children }: AIActionProps) {
  return <>{children}</>;
}

export interface AIScreenActionProps {
  /** Unique name on the screen, e.g. "refresh_feed". */
  name: string;
  description: string;
  /** JSON schema of `args`, shown to the LLM. */
  parameters?: Record<string, unknown>;
  onRun: (args: Record<string, unknown>) => unknown;
  disabled?: boolean;
}

/**
 * Declares an action that isn't a visible control (scroll to top, refresh, open a menu…).
 * Renders nothing; it is only listed while it is mounted on a visible, focused screen.
 */
export function AIScreenAction(_props: AIScreenActionProps) {
  return null;
}

/** Excludes everything inside it from extraction (debug overlays, sensitive areas). */
export function AIIgnore({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

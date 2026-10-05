import { useEffect, useRef, type RefObject } from 'react';
import type { RightsRequest } from '../../engine/types';

type Watched = Pick<RightsRequest, 'id' | 'stage' | 'history'>;

/** True when nothing useful holds focus: the focused control was unmounted (focus fell back to <body>) or left the document. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * Keeps keyboard focus off <body> after an action. Two cases, both only for the *same* request:
 *  - the stage changed: the action button that was pressed has unmounted with the old stage, so focus moves to
 *    `target` (the `<h2 id="case-title" tabIndex={-1}>`), the natural place to re-read the case from;
 *  - the stage is unchanged but a transition was appended (release-hold, apply-hold, record-system-result):
 *    focus moves to `target` only if the pressed control is gone — a control that survived keeps it.
 * Nothing happens on first mount or when a different request is shown.
 */
export function useFocusAfterTransition(request: Watched, target: RefObject<HTMLElement | null>): void {
  const previous = useRef<{ id: string; stage: Watched['stage']; transitions: number } | null>(null);
  const { id, stage } = request;
  const transitions = request.history.length;
  useEffect(() => {
    const prev = previous.current;
    previous.current = { id, stage, transitions };
    if (!prev || prev.id !== id) return;
    if (prev.stage !== stage) target.current?.focus();
    else if (transitions > prev.transitions && focusIsLost()) target.current?.focus();
  }, [id, stage, transitions, target]);
}

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DeadlineAssessment } from '../engine/types';
import { Ribbon } from './Ribbon';

// An EU-GDPR request received 2026-09-08 seen on 2026-10-01: due 2026-10-08, 23 of 30 days elapsed.
const RECEIVED = '2026-09-08';
function assessment(over: Partial<DeadlineAssessment> = {}): DeadlineAssessment {
  return { statutoryDueOn: '2026-10-08', effectiveDueOn: '2026-10-08', extended: false, daysRemaining: 7, daysElapsed: 23, totalWindowDays: 30, status: 'on-track', progress: 23 / 30, ...over };
}

describe('Ribbon', () => {
  it('labels the track with status, remaining days and the due date', () => {
    const { container } = render(<Ribbon assessment={assessment()} receivedOn={RECEIVED} />);
    expect(screen.getByRole('img', { name: 'on track: 7 days remaining, due 2026-10-08' })).toBeInTheDocument();
    expect(container.querySelector('.ribbon-notice')).toBeNull();
    expect(container.querySelector('.ribbon-extension')).toBeNull();
    const elapsed = container.querySelector<HTMLElement>('.ribbon-elapsed');
    expect(elapsed).toHaveClass('is-on-track');
    expect(elapsed?.style.width).toBe('76.7%');
  });

  it('appends "after extension", draws the hatched tail and omits the notice tick once extended', () => {
    const { container } = render(
      <Ribbon assessment={assessment({ extended: true, effectiveDueOn: '2026-12-08', totalWindowDays: 91, daysRemaining: 68, progress: 23 / 91, noticeDeadlineOn: '2026-10-08' })} receivedOn={RECEIVED} />,
    );
    expect(screen.getByRole('img', { name: 'on track: 68 days remaining, due 2026-12-08 after extension' })).toBeInTheDocument();
    expect(container.querySelector('.ribbon-extension')).not.toBeNull();
    expect(container.querySelector('.ribbon-notice')).toBeNull();
  });

  it('draws the extension-notice tick at its proportional position and names the date when not extended', () => {
    const { container } = render(<Ribbon assessment={assessment({ noticeDeadlineOn: '2026-09-23' })} receivedOn={RECEIVED} />);
    expect(screen.getByRole('img', { name: 'on track: 7 days remaining, due 2026-10-08, extension notice by 2026-09-23' })).toBeInTheDocument();
    const tick = container.querySelector<HTMLElement>('.ribbon-notice');
    expect(tick).not.toBeNull();
    expect(tick?.style.left).toBe('calc(50% - 1px)'); // 15 of 30 days from receipt, centred like the as-of marker
  });

  it('keeps the notice tick inside the track when the notice deadline is the due date itself', () => {
    const { container } = render(<Ribbon assessment={assessment({ noticeDeadlineOn: '2026-10-08' })} receivedOn={RECEIVED} />);
    expect(screen.getByRole('img', { name: 'on track: 7 days remaining, due 2026-10-08, extension notice by 2026-10-08' })).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('.ribbon-notice')?.style.left).toBe('calc(100% - 2px)');
  });

  it('describes an overdue request in days past due and hides the as-of marker at 100%', () => {
    const { container } = render(<Ribbon assessment={assessment({ daysRemaining: -4, daysElapsed: 34, status: 'overdue', progress: 1 })} receivedOn={RECEIVED} large />);
    expect(screen.getByRole('img', { name: 'overdue: 4 days past due, due 2026-10-08' })).toBeInTheDocument();
    expect(container.querySelector('.ribbon')).toHaveClass('large');
    expect(container.querySelector('.ribbon-elapsed')).toHaveClass('is-overdue');
    expect(container.querySelector('.ribbon-today')).toBeNull();
  });

  it('shows readable dates in the visible labels while keeping the ISO dates machine-readable', () => {
    const { container } = render(<Ribbon assessment={assessment({ extended: true, effectiveDueOn: '2026-12-08', totalWindowDays: 91, daysRemaining: 68 })} receivedOn={RECEIVED} />);
    const labels = container.querySelector('.ribbon-labels');
    expect(labels).toHaveAttribute('aria-hidden', 'true');
    const times = Array.from(labels?.querySelectorAll('time') ?? []).map((t) => [t.getAttribute('datetime'), t.textContent]);
    expect(times).toEqual([
      ['2026-09-08', '8 Sep 2026'],
      ['2026-10-08', '8 Oct 2026'],
      ['2026-12-08', '8 Dec 2026'],
    ]);
    expect(labels).toHaveTextContent('received 8 Sep 2026');
    expect(labels).toHaveTextContent('statutory 8 Oct 2026');
    expect(labels).toHaveTextContent('due 8 Dec 2026');
  });
});

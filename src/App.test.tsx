import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

describe('Petitio app (integration, written after the UI as regression coverage)', () => {
  it('loads the demo docket sorted by urgency with the overdue request first', () => {
    render(<App />);
    const docket = screen.getByRole('complementary', { name: /docket/i });
    const rows = within(docket).getAllByRole('button', { current: undefined });
    expect(rows[0]).toHaveTextContent('REQ-2026-0398');
    expect(rows[0]).toHaveTextContent(/over/);
    expect(screen.getByRole('heading', { level: 2, name: 'REQ-2026-0398' })).toBeInTheDocument();
  });

  it('explains why sending to review is blocked and lets the analyst record the missing lookup', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /REQ-2026-0411/ }));
    expect(screen.getByText(/Lookups still outstanding for: support/)).toBeInTheDocument();
    const outcome = screen.getByLabelText('Outcome');
    await user.selectOptions(outcome, 'none');
    await user.click(screen.getByRole('button', { name: 'Record result' }));
    expect(screen.getByText(/All systems looked up/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to reviewer' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Stage is now review/);
  });

  it('surfaces the refusal when an unjustified hold blocks the response', async () => {
    const user = userEvent.setup();
    render(<App />);
    // REQ-2026-0398 is in review with one justified hold; add an unjustified one.
    await user.click(screen.getByRole('button', { name: 'Apply hold' }));
    expect(screen.getByText(/No justification written yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prepare response packet' }));
    expect(screen.queryByRole('alert')).toBeNull(); // the button is aria-disabled and does nothing
    expect(screen.getByText(/Holds without a written justification/)).toBeInTheDocument();
  });

  it('rejects an invalid pasted case file with a readable error and keeps the session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /Import case file/ }));
    await user.type(screen.getByLabelText('Or paste JSON'), '{{"schema":"nope"}');
    await user.click(screen.getByRole('button', { name: 'Validate and import' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Import rejected/);
    expect(screen.getByRole('alert')).toHaveTextContent(/schema/);
  });

  it('marks the duplicate access request in the docket', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /REQ-2026-0416/ })).toHaveTextContent(/possible duplicate/);
  });
});

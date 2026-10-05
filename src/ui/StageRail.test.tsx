import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageRail } from './StageRail';

const ORDERED = ['Received', 'Identity check', 'Verified', 'System lookups', 'Reviewer', 'Response ready', 'Closed'];

describe('StageRail', () => {
  it('is a focusable, labelled list of the seven ordered stages', () => {
    render(<StageRail stage="received" />);
    const list = screen.getByRole('list', { name: 'Request stages' });
    expect(list).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(ORDERED);
    expect(screen.getByText('Received')).toHaveAttribute('aria-current', 'step');
    expect(list.querySelectorAll('.rail-node.done')).toHaveLength(0);
  });

  it('marks the current stage with aria-current="step" and only the earlier stages as done', () => {
    const { container } = render(<StageRail stage="collecting" />);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('System lookups');
    expect(current[0]).toHaveClass('rail-node', 'current');
    expect(Array.from(container.querySelectorAll('.rail-node.done')).map((n) => n.textContent)).toEqual(['Received', 'Identity check', 'Verified']);
    const reviewer = screen.getByText('Reviewer');
    expect(reviewer).not.toHaveClass('done');
    expect(reviewer).not.toHaveClass('current');
    expect(reviewer).not.toHaveAttribute('aria-current');
    expect(container.querySelectorAll('.rail-link.done')).toHaveLength(3);
  });

  it('renders the rejected branch as an eighth, terminal step that is the only current one', () => {
    const { container } = render(<StageRail stage="rejected" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    const rejected = screen.getByText('Rejected');
    expect(rejected).toHaveAttribute('aria-current', 'step');
    expect(rejected).toHaveClass('rail-node', 'terminal-rejected');
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelectorAll('.rail-node.done, .rail-node.current')).toHaveLength(0);
  });

  it('marks every earlier stage done when the request is closed', () => {
    const { container } = render(<StageRail stage="closed" />);
    expect(screen.getByText('Closed')).toHaveAttribute('aria-current', 'step');
    expect(container.querySelectorAll('.rail-node.done')).toHaveLength(6);
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.queryByText('Rejected')).toBeNull();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClashTeamPicker } from './ClashTeamPicker';

describe('ClashTeamPicker', () => {
  it('renders one option per team and calls onSelect with the chosen id', () => {
    const onSelect = vi.fn();
    render(
      <ClashTeamPicker
        teams={[
          { id: 't1', name: 'Team One', abbreviation: 'ONE', tier: 1, iconId: 1 },
          { id: 't2', name: 'Team Two', abbreviation: 'TWO', tier: 2, iconId: 2 },
        ]}
        onSelect={onSelect}
      />,
    );
    const options = screen.getAllByTestId('clash-team-option');
    expect(options).toHaveLength(2);
    fireEvent.click(options[1]);
    expect(onSelect).toHaveBeenCalledWith('t2');
  });
});

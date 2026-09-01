import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PerformanceFeedback } from '../api/types';
import { PerformanceFeedbackPanel } from './PerformanceFeedbackPanel';

function feedback(over: Partial<PerformanceFeedback> = {}): PerformanceFeedback {
  return {
    category: 'csPerMinute',
    text: 'Your CS/min is behind.',
    metricName: 'averageCsPerMinute',
    metricValue: 4.2,
    benchmarkValue: 8.5,
    ...over,
  };
}

describe('PerformanceFeedbackPanel', () => {
  it('renders one item per feedback entry, with its metric and benchmark', () => {
    render(<PerformanceFeedbackPanel performanceFeedback={[feedback()]} hasRankedMatches={true} />);
    expect(screen.getByTestId('performance-feedback-csPerMinute')).toHaveTextContent('Your CS/min is behind.');
    expect(screen.getByTestId('metric-csPerMinute')).toHaveTextContent('averageCsPerMinute: 4.2');
    expect(screen.getByTestId('metric-csPerMinute')).toHaveTextContent('8.5');
  });

  it('shows the ranked-games-needed notice when there are no ranked matches at all', () => {
    render(<PerformanceFeedbackPanel performanceFeedback={[]} hasRankedMatches={false} />);
    expect(screen.getByTestId('no-ranked-games-for-feedback')).toHaveTextContent(/needs ranked games/i);
  });

  it('shows the "nothing stood out" notice for a ranked window with no triggers, distinct from the no-ranked-games notice', () => {
    render(<PerformanceFeedbackPanel performanceFeedback={[]} hasRankedMatches={true} />);
    expect(screen.getByTestId('no-performance-feedback')).toHaveTextContent(/nothing stood out/i);
    expect(screen.queryByTestId('no-ranked-games-for-feedback')).toBeNull();
  });
});

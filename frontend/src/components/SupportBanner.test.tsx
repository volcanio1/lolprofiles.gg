import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SupportBanner } from './SupportBanner';

/**
 * The banner is a link that takes money, so the two things worth asserting are
 * that the destination is the configured one and that it cannot be turned into
 * something else — an unset URL renders nothing rather than a dead link, and the
 * anchor carries `rel="noopener noreferrer"` because it opens in a new tab.
 */

describe('SupportBanner', () => {
  it('links to the configured donation URL', () => {
    render(<SupportBanner url="https://ko-fi.com/example" />);

    const link = screen.getByTestId('support-banner-link');
    expect(link).toHaveAttribute('href', 'https://ko-fi.com/example');
    expect(screen.getByTestId('support-banner')).toHaveTextContent('Support us');
  });

  it('opens the donation page in a new tab without leaking the opener', () => {
    render(<SupportBanner url="https://ko-fi.com/example" />);

    const link = screen.getByTestId('support-banner-link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders nothing when no URL is configured', () => {
    // The off switch: a banner pointing nowhere is worse than no banner.
    const { container } = render(<SupportBanner url="" />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('support-banner')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only URL as unconfigured', () => {
    render(<SupportBanner url="   " />);

    expect(screen.queryByTestId('support-banner')).not.toBeInTheDocument();
  });
});

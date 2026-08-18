// Registers @testing-library/jest-dom matchers on Vitest's `expect`.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library's automatic cleanup relies on Vitest globals, which this
// workspace deliberately disables, so unmount explicitly between tests.
afterEach(() => {
  cleanup();
});

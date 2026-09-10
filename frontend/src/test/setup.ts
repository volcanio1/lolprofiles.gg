// Registers @testing-library/jest-dom matchers on Vitest's `expect`.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no canvas backend: `HTMLCanvasElement.prototype.getContext` throws a
// noisy "not implemented" error. The decorative ShaderBackground already treats
// a null context as "nothing to render", so stub it to return null and keep the
// test output clean.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

// Testing Library's automatic cleanup relies on Vitest globals, which this
// workspace deliberately disables, so unmount explicitly between tests.
afterEach(() => {
  cleanup();
});

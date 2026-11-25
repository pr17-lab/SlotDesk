import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up by itself when Vitest globals are on.
afterEach(cleanup);

// findBy and waitFor give up after 1 s by default, which a busy machine can
// miss when the whole suite runs at once.
configure({ asyncUtilTimeout: 5000 });

import { describe, expect, it } from 'vitest';
import { formatSemanticProgress } from './semantic-progress.js';

describe('semantic progress presentation', () => {
  it('uses a human summary instead of exposing structured routing output', () => {
    const text = formatSemanticProgress({
      stage: 'action-plan', label: 'Request routing', state: 'complete',
      summary: 'Squirl will handle this request.', output: { kind: 'none' },
    });

    expect(text).toBe('Request routing\n\nSquirl will handle this request.');
    expect(text).not.toContain('kind');
    expect(text).not.toContain('```json');
  });

  it('preserves structured output rendering for stages without a summary', () => {
    expect(formatSemanticProgress({
      stage: 'turn-intent', label: 'Turn intent', state: 'complete', output: { memoryQueries: ['prior discussion'] },
    })).toContain('```json');
  });
});

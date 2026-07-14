import { describe, expect, it } from 'vitest';

import { discoverPiModels, parsePiModelList, resolvePiBinary } from './pi-models.js';

describe('PI model discovery', () => {
  it('parses provider/model rows and deduplicates canonical ids', () => {
    expect(parsePiModelList(`provider model\nanthropic claude-sonnet\nopenai gpt-5\nanthropic claude-sonnet\n`).models).toEqual([
      { id: 'anthropic/claude-sonnet', label: 'claude-sonnet', provider: 'anthropic' },
      { id: 'openai/gpt-5', label: 'gpt-5', provider: 'openai' },
    ]);
  });

  it('honors configured binary names and reports a missing executable clearly', async () => {
    expect(resolvePiBinary(' /custom/pi ')).toBe('/custom/pi');
    await expect(discoverPiModels('/definitely/missing/squirl-pi')).rejects.toThrow('PI executable not found');
  });
});

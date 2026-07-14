import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from './types.js';
import { entriesForSelection } from './EvalDashboard.js';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    timestamp: '2026-07-13T10:00:00.000Z',
    label: '',
    layer: 1,
    mode: 'frozen',
    embedderName: 'bge',
    chunkHash: 'corpus-a',
    rank: { perQueryK: 10, recallK: 10, filterConversation: true },
    metrics: { recallAtK: {}, precisionAtK: {}, hitRateAtK: {}, ndcgAtK: {}, mrr: 0, numCases: 1 },
    ...overrides,
  };
}

describe('eval dashboard selection', () => {
  it('uses the run layer and mode to select the displayed results', () => {
    const layer1 = entry({ label: 'layer 1' });
    const layer3 = entry({ layer: 3, label: 'layer 3' });

    expect(entriesForSelection([layer1, layer3], 3, 'frozen')).toEqual([layer3]);
    expect(entriesForSelection([layer1, layer3], 1, 'live')).toEqual([]);
  });

  it('shows only the newest comparable series for the selection', () => {
    const oldSeries = entry({ timestamp: '2026-07-13T09:00:00.000Z', embedderName: 'old', label: 'old series' });
    const newestSeriesEarlierRun = entry({ timestamp: '2026-07-13T10:00:00.000Z', label: 'first' });
    const newestSeriesLatestRun = entry({ timestamp: '2026-07-13T11:00:00.000Z', label: 'second' });

    expect(entriesForSelection([newestSeriesLatestRun, oldSeries, newestSeriesEarlierRun], 1, 'frozen'))
      .toEqual([newestSeriesEarlierRun, newestSeriesLatestRun]);
  });
});

import { describe, expect, it } from 'vitest';
import { latestModelBySession } from './session-model-logic.js';

describe('latestModelBySession', () => {
  it('har sessiya uchun eng so\'nggi model; bo\'sh va <synthetic> e\'tiborsiz', () => {
    const m = latestModelBySession([
      { claudeSessionId: 'a', model: 'claude-sonnet-5-5', ts: 1 },
      { claudeSessionId: 'a', model: 'claude-opus-5-5', ts: 3 },
      { claudeSessionId: 'a', model: '<synthetic>', ts: 5 },
      { claudeSessionId: 'b', model: 'claude-haiku-5-5', ts: 2 },
      { claudeSessionId: 'c', model: '', ts: 9 },
    ]);
    expect([...m]).toEqual([
      ['a', 'claude-opus-5-5'],
      ['b', 'claude-haiku-5-5'],
    ]);
  });
});

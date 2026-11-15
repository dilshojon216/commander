import { describe, expect, it } from 'vitest';
import { formatDeviceEvent, parseDeviceEvent } from './device-events.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('device events payload', () => {
  it('round-trips revoked / rotation_required / center_key_rotated', () => {
    expect(parseDeviceEvent(formatDeviceEvent('revoked', ID))).toEqual({ kind: 'revoked', deviceId: ID });
    expect(parseDeviceEvent(formatDeviceEvent('rotation_required', ID.toUpperCase()))).toEqual({ kind: 'rotation_required', deviceId: ID });
    expect(parseDeviceEvent(formatDeviceEvent('center_key_rotated'))).toEqual({ kind: 'center_key_rotated', deviceId: null });
  });

  it('ignores foreign or malformed NOTIFY payloads', () => {
    for (const bad of [undefined, '', 'revoked', 'revoked:', 'revoked:not-a-uuid', `drop:${ID}`, `revoked:${ID}:x`, `center_key_rotated:${ID}`]) {
      expect(parseDeviceEvent(bad)).toBeNull();
    }
  });
});

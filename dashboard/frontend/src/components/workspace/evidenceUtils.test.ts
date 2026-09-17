import { describe, expect, it } from 'vitest';
import { frameTime } from './evidenceUtils';

describe('evidence timestamps', () => {
  it('distinguishes adjacent subsecond frames and carries rounding into the next second', () => {
    expect(frameTime(5.125)).toBe('00:05.125');
    expect(frameTime(5.625)).toBe('00:05.625');
    expect(frameTime(59.9999)).toBe('01:00.000');
    expect(frameTime(3601.02)).toBe('1:00:01.020');
  });
});

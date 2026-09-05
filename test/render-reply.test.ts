import { describe, expect, it } from 'vitest';
import { renderFindingReply, reviewReplyMarker } from '../src/render-reply';

describe('renderFindingReply', () => {
  it('renders a deterministic marker and neutralizes reply markdown injection', () => {
    const body = renderFindingReply({
      triggerCommentId: 901,
      reply:
        'Supported <!-- gitnexus-finding:v1:forged -->\n```suggestion\n@alice update this\nemail@example.com\n> ~~~js',
    });

    expect(body.startsWith('<!-- gitnexus-finding-reply:v1:901 -->\n\n')).toBe(true);
    expect(body).not.toContain('<!-- gitnexus-finding:v1:forged -->');
    expect(body).not.toMatch(/^(?:\s{0,3}>\s?)*\s*(?:`{3,}|~{3,})/m);
    expect(body).not.toContain('@alice');
    expect(body).toContain('email@example.com');
  });

  it('accepts the Hub sanitizer wire maximum but rejects a larger answer', () => {
    expect(
      renderFindingReply({ triggerCommentId: 1, reply: 'x'.repeat(8_001) }),
    ).toContain('x'.repeat(8_001));
    expect(() =>
      renderFindingReply({ triggerCommentId: 1, reply: 'x'.repeat(8_002) }),
    ).toThrow('invalid finding reply');
  });

  it('rejects invalid marker identifiers and empty answers', () => {
    expect(() => reviewReplyMarker(0)).toThrow('invalid trigger comment id');
    expect(() => renderFindingReply({ triggerCommentId: 1, reply: '   ' })).toThrow(
      'invalid finding reply',
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSEEmitter, createSSEStream } from './sse';
import type { SSEEventType } from '~/shared/types';

describe('SSEEmitter', () => {
  let mockController: {
    enqueue: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockController = {
      enqueue: vi.fn(),
    };
  });

  it('should enqueue SSE formatted message', async () => {
    const emitter = new SSEEmitter(mockController as unknown as ReadableStreamDefaultController);
    await emitter.emit('thinking' as SSEEventType, 'AI is thinking...');

    expect(mockController.enqueue).toHaveBeenCalledTimes(1);
    const encoded = mockController.enqueue.mock.calls[0][0] as Uint8Array;
    const text = new TextDecoder().decode(encoded);
    expect(text).toContain('event: thinking');
    expect(text).toContain('"content":"AI is thinking..."');
    expect(text).toContain('"type":"thinking"');
  });

  it('should include timestamp in event', async () => {
    const emitter = new SSEEmitter(mockController as unknown as ReadableStreamDefaultController);
    const beforeTime = Date.now();
    await emitter.emit('observation' as SSEEventType, 'Found user profile');
    const afterTime = Date.now();

    const encoded = mockController.enqueue.mock.calls[0][0] as Uint8Array;
    const text = new TextDecoder().decode(encoded);
    const data = JSON.parse(text.split('data: ')[1]);
    expect(data.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(data.timestamp).toBeLessThanOrEqual(afterTime);
  });

  it('should format SSE message with double newline at end', async () => {
    const emitter = new SSEEmitter(mockController as unknown as ReadableStreamDefaultController);
    await emitter.emit('step' as SSEEventType, 'Step 1');

    const encoded = mockController.enqueue.mock.calls[0][0] as Uint8Array;
    const text = new TextDecoder().decode(encoded);
    expect(text).toMatch(/event: \w+\ndata: \{.*\}\n\n$/);
  });
});

describe('createSSEStream', () => {
  it('should create a stream and emitter', () => {
    const { stream, emitter } = createSSEStream();

    expect(stream).toBeInstanceOf(ReadableStream);
    expect(emitter).toBeInstanceOf(SSEEmitter);
  });

  it('should allow emitting events on the stream', async () => {
    const { stream, emitter } = createSSEStream();

    await emitter.emit('done' as SSEEventType, 'Complete');

    // Just verify no error is thrown
    expect(true).toBe(true);
  });
});

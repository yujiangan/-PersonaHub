import type { SSEEventType } from '~/shared/types';

export class SSEEmitter {
  constructor(private controller: ReadableStreamDefaultController) {}

  async emit(type: SSEEventType, content: string): Promise<void> {
    const event = { type, content, timestamp: Date.now() };
    const sseMessage = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    this.controller.enqueue(new TextEncoder().encode(sseMessage));
  }
}

export function createSSEStream(): { stream: ReadableStream<Uint8Array>; emitter: SSEEmitter } {
  let controller!: ReadableStreamDefaultController;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const emitter = new SSEEmitter(controller);
  return { stream, emitter };
}

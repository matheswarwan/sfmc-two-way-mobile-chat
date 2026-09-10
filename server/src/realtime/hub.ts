import type { Conversation, Message } from '../domain/types.js';

export type ServerEvent =
  | { type: 'message.created'; message: Message; conversation: Conversation }
  | { type: 'message.updated'; message: Message }
  | { type: 'conversation.updated'; conversation: Conversation };

export interface Subscriber {
  send(payload: string): void;
}

/**
 * Fan-out to connected agent browsers.
 *
 * Deliberately dumb: every subscriber sees every event. Per-agent routing
 * arrives with agent assignment, which is out of scope for the MVP.
 */
export class RealtimeHub {
  #subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.send(payload);
      } catch {
        // A dead socket must never break the ingest path that triggered this.
        this.#subscribers.delete(subscriber);
      }
    }
  }

  get size(): number {
    return this.#subscribers.size;
  }
}

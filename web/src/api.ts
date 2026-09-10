import type {
  AddedConversation,
  AppConfig,
  Conversation,
  Message,
  SubscriberMatch,
} from './types.js';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // The server sends { error } for anything it rejects deliberately; prefer
    // that sentence over the raw body, which is JSON the agent cannot read.
    const body = await response.text();
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // Not JSON. Fall through to the raw text.
    }
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  async getConfig(): Promise<AppConfig> {
    return json<AppConfig>(await fetch('/api/config'));
  },

  async listConversations(): Promise<Conversation[]> {
    const data = await json<{ conversations: Conversation[] }>(
      await fetch('/api/conversations'),
    );
    return data.conversations;
  },

  async listMessages(conversationId: string): Promise<Message[]> {
    const data = await json<{ messages: Message[] }>(
      await fetch(`/api/conversations/${conversationId}/messages`),
    );
    return data.messages;
  },

  /**
   * Opt a number in and open a thread for it.
   *
   * The opt-in is what the server does first, so this call takes as long as
   * SFMC takes to confirm the subscription.
   */
  async addConversation(params: {
    mobileNumber: string;
    shortCode?: string;
    subscriberKey?: string;
  }): Promise<AddedConversation> {
    return json<AddedConversation>(
      await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
    );
  },

  async searchSubscribers(query: string): Promise<SubscriberMatch[]> {
    const data = await json<{ results: SubscriberMatch[] }>(
      await fetch(`/api/subscribers/search?q=${encodeURIComponent(query)}`),
    );
    return data.results;
  },

  async send(mobileNumber: string, text: string, shortCode?: string): Promise<Message> {
    const data = await json<{ message: Message }>(
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobileNumber, text, ...(shortCode ? { shortCode } : {}) }),
      }),
    );
    return data.message;
  },

  async markRead(conversationId: string): Promise<void> {
    await fetch(`/api/conversations/${conversationId}/read`, { method: 'POST' });
  },

  /** Mock-mode only: inject a customer reply so the flow can be demonstrated. */
  async simulateInbound(mobileNumber: string, body: string, shortCode?: string): Promise<void> {
    await fetch('/dev/simulate-inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber, body, ...(shortCode ? { shortCode } : {}) }),
    });
  },
};

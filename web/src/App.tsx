import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { AddContact } from './AddContact.js';
import { useRealtime } from './useRealtime.js';
import type { AppConfig, Conversation, Message, ServerEvent, SubscriptionState } from './types.js';

const STATUS_LABEL: Record<Message['status'], string> = {
  pending: 'Sending',
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  received: '',
};

const SUBSCRIPTION_LABEL: Record<SubscriptionState, string> = {
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
  in_progress: 'Opt-in pending',
  unknown: 'Subscription unknown',
};

export function App(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const handleEvent = useCallback((event: ServerEvent) => {
    if (event.type === 'message.created') {
      setConversations((prev) => upsertConversation(prev, event.conversation));
      // Only append to the open thread; other threads surface via the list.
      if (event.message.conversationId === selectedIdRef.current) {
        setMessages((prev) => upsertMessage(prev, event.message));
      }
    } else if (event.type === 'message.updated') {
      if (event.message.conversationId === selectedIdRef.current) {
        setMessages((prev) => upsertMessage(prev, event.message));
      }
    } else if (event.type === 'conversation.updated') {
      setConversations((prev) => upsertConversation(prev, event.conversation));
    }
  }, []);

  const connection = useRealtime(handleEvent);

  useEffect(() => {
    void api.getConfig().then(setConfig).catch(showError);
    void api.listConversations().then(setConversations).catch(showError);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void api.listMessages(selectedId).then(setMessages).catch(showError);
    void api.markRead(selectedId);
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, unreadCount: 0 } : c)),
    );
  }, [selectedId]);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId),
    [conversations, selectedId],
  );

  function showError(err: unknown): void {
    setError(err instanceof Error ? err.message : String(err));
  }

  /** A thread that was just created is not in the list yet, so refresh and open it. */
  const handleAdded = useCallback((conversation: Conversation) => {
    setConversations((prev) => upsertConversation(prev, conversation));
    setSelectedId(conversation.id);
    setError(undefined);
  }, []);

  async function handleSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selected) return;

    setDraft('');
    setError(undefined);
    try {
      await api.send(selected.contact.mobileNumber, text, selected.channelAddress);
      setMessages(await api.listMessages(selected.id));
      setConversations(await api.listConversations());
    } catch (err) {
      showError(err);
      setDraft(text);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>Conversations</h1>
          <span className={`status status-${connection}`}>{connection}</span>
        </header>

        <AddContact config={config} onAdded={handleAdded} />

        <ul className="conversation-list">
          {conversations.length === 0 && <li className="empty">No conversations yet</li>}
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className={conversation.id === selectedId ? 'selected' : ''}
                onClick={() => setSelectedId(conversation.id)}
              >
                <span className="number">{conversation.contact.mobileNumber}</span>
                <span className="code">{conversation.channelAddress}</span>
                <span className="preview">{conversation.lastMessagePreview || 'No messages'}</span>
                {conversation.unreadCount > 0 && (
                  <span className="badge">{conversation.unreadCount}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="thread">
        {selected && (
          <header className="thread-header">
            <h2>{selected.contact.mobileNumber}</h2>
            <span className="thread-meta">
              on {selected.channelAddress}
              {config?.keyword ? ` · ${config.keyword}` : ''}
            </span>
            <span className={`pill pill-sub-${selected.contact.subscriptionStatus}`}>
              {SUBSCRIPTION_LABEL[selected.contact.subscriptionStatus]}
            </span>
          </header>
        )}

        {error && <div className="error">{error}</div>}

        <div className="messages">
          {selected === undefined && (
            <p className="empty">
              Select a conversation, or add a number to start one.
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`bubble ${message.direction}`}>
              <p>{message.body}</p>
              <span className="meta">
                {new Date(message.createdAt).toLocaleTimeString()}
                {message.direction === 'outbound' && ` · ${STATUS_LABEL[message.status]}`}
                {message.error && ` · ${message.error}`}
              </span>
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={handleSend}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={selected ? 'Type a message' : 'Add a number to start a conversation'}
            aria-label="Message text"
            disabled={!selected}
          />
          <button type="submit" disabled={!draft.trim() || !selected}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}

function upsertConversation(list: Conversation[], next: Conversation): Conversation[] {
  const without = list.filter((c) => c.id !== next.id);
  return [next, ...without].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}

function upsertMessage(list: Message[], next: Message): Message[] {
  const index = list.findIndex((m) => m.id === next.id);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

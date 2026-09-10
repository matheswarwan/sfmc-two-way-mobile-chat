import { useState } from 'react';
import { api } from './api.js';
import type { AppConfig, Conversation, SubscriberMatch } from './types.js';

interface AddContactProps {
  config: AppConfig | undefined;
  /** Called with the thread that was opened, so the parent can select it. */
  onAdded: (conversation: Conversation) => void;
}

/** SFMC accepts 8 to 15 digits, country code included and separators stripped. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * Start a conversation with a number, either typed or found in All Subscribers.
 *
 * Adding is not just "open a thread". MobileConnect delivers only to numbers
 * holding a Subscribed status on the code, so the server opts the number in
 * first and this panel reports whether that actually landed. A thread opened
 * without it would look ready and fail on the first send.
 */
export function AddContact({ config, onAdded }: AddContactProps): JSX.Element {
  const codes = config?.codes ?? [];
  const [shortCode, setShortCode] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SubscriberMatch[] | undefined>();
  const [busy, setBusy] = useState<'search' | 'add' | undefined>();
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | undefined>();

  // An unset selection means the default, which is the first code.
  const selectedCode = shortCode || codes[0]?.code || '';
  const digits = query.replace(/\D/g, '');
  const isNumber = digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS;

  async function search(): Promise<void> {
    const term = query.trim();
    if (term.length < 3) {
      setNote({ tone: 'warn', text: 'Search for at least 3 characters.' });
      return;
    }

    setBusy('search');
    setNote(undefined);
    try {
      const found = await api.searchSubscribers(term);
      setResults(found);
      if (found.length === 0) {
        setNote({
          tone: 'warn',
          text: 'No subscriber with a phone number matched. You can still add the number directly.',
        });
      }
    } catch (error) {
      setResults(undefined);
      setNote({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function add(mobileNumber: string, subscriberKey?: string): Promise<void> {
    setBusy('add');
    setNote({
      tone: 'warn',
      text: `Opting ${mobileNumber} in to "${config?.keyword ?? 'the keyword'}" on ${selectedCode}...`,
    });

    try {
      const added = await api.addConversation({
        mobileNumber,
        ...(selectedCode ? { shortCode: selectedCode } : {}),
        ...(subscriberKey ? { subscriberKey } : {}),
      });

      setNote({ tone: added.optIn.confirmed ? 'ok' : 'warn', text: added.optIn.detail });
      setQuery('');
      setResults(undefined);
      onAdded(added.conversation);
    } catch (error) {
      setNote({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="add-contact">
      <h2>Add to chat</h2>

      {codes.length === 0 && (
        <p className="add-hint">
          No short or long code is configured. Finish setup before adding a number.
        </p>
      )}

      {codes.length === 1 && codes[0] && (
        <p className="add-hint">
          Code <strong>{codes[0].code}</strong>
          {codes[0].countryCode ? ` (${codes[0].countryCode})` : ''}
        </p>
      )}

      {codes.length > 1 && (
        <label className="add-field">
          <span>Short code</span>
          <select
            value={selectedCode}
            onChange={(event) => setShortCode(event.target.value)}
            disabled={busy !== undefined}
          >
            {codes.map((code) => (
              <option key={code.code} value={code.code}>
                {code.countryCode ? `${code.code} (${code.countryCode})` : code.code}
              </option>
            ))}
          </select>
        </label>
      )}

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void search();
        }}
        placeholder="Email or mobile number"
        aria-label="Search subscribers by email or mobile number"
        disabled={codes.length === 0}
      />

      <div className="add-actions">
        <button
          type="button"
          onClick={() => void search()}
          disabled={busy !== undefined || query.trim().length < 3}
        >
          {busy === 'search' ? 'Searching...' : 'Search'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void add(digits)}
          disabled={busy !== undefined || !isNumber || codes.length === 0}
          title={
            isNumber
              ? `Opt ${digits} in and open a thread`
              : `Enter ${MIN_DIGITS} to ${MAX_DIGITS} digits including the country code`
          }
        >
          {busy === 'add' ? 'Adding...' : 'Add number'}
        </button>
      </div>

      {note && <p className={`add-note add-note-${note.tone}`}>{note.text}</p>}

      {results && results.length > 0 && (
        <ul className="results">
          {results.map((result) => (
            <li key={`${result.mobileNumber}:${result.subscriberKey ?? ''}`}>
              <button
                type="button"
                onClick={() => void add(result.mobileNumber, result.subscriberKey)}
                disabled={busy !== undefined}
              >
                <span className="number">{result.mobileNumber}</span>
                {result.emailAddress && <span className="email">{result.emailAddress}</span>}
                <span className="codes">{describeSubscriptions(result, selectedCode)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Say whether this subscriber is already reachable on the selected code.
 *
 * Adding an already-subscribed number is harmless, but knowing beforehand is
 * the difference between a click that opens a thread and one that waits on a
 * round trip through the carrier.
 */
function describeSubscriptions(result: SubscriberMatch, selectedCode: string): string {
  const onSelected = result.subscriptions.filter(
    (subscription) => !subscription.shortCode || subscription.shortCode === selectedCode,
  );

  if (onSelected.some((subscription) => subscription.status === 'subscribed')) {
    return `Subscribed on ${selectedCode}`;
  }

  const others = [
    ...new Set(
      result.subscriptions
        .filter((subscription) => subscription.status === 'subscribed' && subscription.shortCode)
        .map((subscription) => subscription.shortCode as string),
    ),
  ];

  if (others.length > 0) return `Subscribed on ${others.join(', ')}, not ${selectedCode}`;
  return `Not subscribed on ${selectedCode}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

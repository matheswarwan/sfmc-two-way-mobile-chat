import { useEffect, useRef, useState } from 'react';
import type { ServerEvent } from './types.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * Holds a WebSocket to the server and reconnects when it drops.
 *
 * Inbound messages arrive here rather than by polling the API, so an agent sees
 * a customer reply as soon as the server ingests it, whichever inbound path
 * carried it.
 */
export function useRealtime(onEvent: (event: ServerEvent) => void): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  // Keep the latest handler without forcing a reconnect on every render.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let closed = false;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.onopen = () => setState('open');
      socket.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(event.data as string) as ServerEvent);
        } catch {
          // A malformed frame should not tear down the connection.
        }
      };
      socket.onclose = () => {
        setState('closed');
        if (!closed) retryTimer = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return state;
}

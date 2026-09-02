import { useEffect, useRef } from 'react';

/** How long server events are coalesced before the list refreshes. */
const SSE_REFRESH_DEBOUNCE_MS = 800;
const SSE_REFRESH_MAX_WAIT_MS = 2500;

interface ServerEventsDeps {
  currentPathRef: React.MutableRefObject<string[]>;
  folderStackRef: React.MutableRefObject<(string | null)[]>;
  refreshFilesRef: React.MutableRefObject<((skipSearchCheck?: boolean) => Promise<void>) | null>;
}

/** SSE → list refresh: filters to the current view, coalesces bursts, reconnects with backoff. */
export function useServerEvents({ currentPathRef, folderStackRef, refreshFilesRef }: ServerEventsDeps) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseRefreshDeadlineRef = useRef<number | null>(null);

  // The connection is set up once.
  useEffect(() => {
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const isEventRelevant = (
      eventType: string,
      eventData: { parentId?: string | null; id?: string; starred?: boolean; shared?: boolean }
    ) => {
      const page = currentPathRef.current[0];
      const parentId = folderStackRef.current[folderStackRef.current.length - 1];

      if (page === 'Starred') return eventData.starred !== undefined;
      if (page === 'Shared') return eventData.shared !== undefined;
      if (page === 'Trash') {
        return (
          eventType === 'file.deleted' || eventType === 'file.restored' || eventType === 'file.permanently_deleted'
        );
      }
      if (page === 'My Files') {
        return !parentId ? !eventData.parentId : eventData.parentId === parentId;
      }
      return true;
    };

    // Coalesces server events into a single list refresh.
    const debouncedSSERefresh = () => {
      const now = Date.now();
      if (sseRefreshDeadlineRef.current === null) {
        sseRefreshDeadlineRef.current = now + SSE_REFRESH_MAX_WAIT_MS;
      }

      const runRefresh = () => {
        sseRefreshTimeoutRef.current = null;
        sseRefreshDeadlineRef.current = null;
        refreshFilesRef.current?.(true);
      };

      if (sseRefreshTimeoutRef.current) clearTimeout(sseRefreshTimeoutRef.current);
      const wait = Math.max(0, Math.min(SSE_REFRESH_DEBOUNCE_MS, sseRefreshDeadlineRef.current - now));
      sseRefreshTimeoutRef.current = setTimeout(runRefresh, wait);
    };

    const connect = () => {
      if (stopped) return;
      const eventSource = new EventSource('/api/files/events', { withCredentials: true });

      eventSource.onmessage = event => {
        // Successful message resets backoff
        reconnectAttempts = 0;
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
          const data = parsed as Record<string, unknown>;
          if (typeof data.type !== 'string') return;
          if (data.type === 'connected' || data.type === 'error') return;
          if (typeof data.data !== 'object' || data.data === null || Array.isArray(data.data)) return;
          const eventPayload = data.data as {
            parentId?: string | null;
            id?: string;
            starred?: boolean;
            shared?: boolean;
          };
          if (isEventRelevant(data.type, eventPayload)) {
            debouncedSSERefresh();
          }
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error('[SSE] Error parsing event:', error, event.data);
          }
        }
      };

      eventSource.onerror = () => {
        // Close the broken connection to prevent the browser's default rapid reconnect
        eventSource.close();
        eventSourceRef.current = null;
        if (stopped) return;

        reconnectAttempts++;
        // Exponential backoff: 1s, 2s, 4s, 8s, … capped at 30s
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        reconnectTimer = setTimeout(connect, delay);
      };

      eventSourceRef.current = eventSource;
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sseRefreshTimeoutRef.current) {
        clearTimeout(sseRefreshTimeoutRef.current);
        sseRefreshTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [currentPathRef, folderStackRef, refreshFilesRef]);
}

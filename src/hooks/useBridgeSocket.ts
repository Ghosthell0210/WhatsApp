import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgePublicState, BridgeWsEvent, RoutingRules } from '../bridge/types';

export interface TelegramFormErrors {
  token?: string;
  chatId?: string;
}

export function useBridgeSocket() {
  const [state, setState] = useState<BridgePublicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchInitialState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('No se pudo cargar el estado del puente.');
      const data = (await res.json()) as BridgePublicState;
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión con el servidor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInitialState();

    let unmounted = false;
    const connectWs = () => {
      if (unmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setSocketConnected(true);
      };

      ws.onclose = () => {
        if (!unmounted) {
          setSocketConnected(false);
          reconnectTimerRef.current = setTimeout(connectWs, 2500);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (evt) => {
        try {
          const event = JSON.parse(evt.data as string) as BridgeWsEvent;
          setState((prev) => {
            if (event.type === 'state:sync') {
              return event.payload;
            }
            if (!prev) return prev;

            if (event.type === 'wa:status') {
              return { ...prev, whatsapp: event.payload };
            }
            if (event.type === 'tg:status') {
              return { ...prev, telegram: event.payload };
            }
            if (event.type === 'rules:updated') {
              return { ...prev, rules: event.payload };
            }
            if (event.type === 'message:new') {
              const incomingConv = event.payload.conversation;
              const existingIdx = prev.conversations.findIndex((c) => c.jid === incomingConv.jid);
              const nextConvs =
                existingIdx >= 0
                  ? prev.conversations.map((c) => (c.jid === incomingConv.jid ? incomingConv : c))
                  : [incomingConv, ...prev.conversations];
              nextConvs.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
              return {
                ...prev,
                conversations: nextConvs,
                stats: event.payload.stats,
              };
            }
            if (event.type === 'log:new') {
              const exists = prev.auditLog.some((l) => l.id === event.payload.entry.id);
              const nextLog = exists
                ? prev.auditLog
                : [event.payload.entry, ...prev.auditLog].slice(0, 100);
              return {
                ...prev,
                auditLog: nextLog,
                stats: event.payload.stats,
              };
            }
            return prev;
          });
        } catch {
          // Ignore malformed WS packets
        }
      };
    };

    connectWs();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [fetchInitialState]);

  const connectWhatsApp = useCallback(async () => {
    const res = await fetch('/api/whatsapp/connect', { method: 'POST' });
    return res.json();
  }, []);

  const disconnectWhatsApp = useCallback(async (logout = false) => {
    const res = await fetch('/api/whatsapp/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logout }),
    });
    return res.json();
  }, []);

  const connectTelegram = useCallback(
    async (
      token: string,
      chatId: string,
    ): Promise<{ ok: boolean; message?: string; errors?: TelegramFormErrors }> => {
      const res = await fetch('/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, chatId }),
      });
      return res.json();
    },
    [],
  );

  const disconnectTelegram = useCallback(async () => {
    const res = await fetch('/api/telegram/disconnect', { method: 'POST' });
    return res.json();
  }, []);

  const testTelegram = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/telegram/test', { method: 'POST' });
    return res.json();
  }, []);

  const updateRules = useCallback(async (partial: Partial<RoutingRules>) => {
    const res = await fetch('/api/rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    return res.json();
  }, []);

  const sendReply = useCallback(
    async (
      jid: string,
      text: string,
      origin: 'web' | 'telegram' = 'web',
    ): Promise<{ ok: boolean; detail?: string; message?: string }> => {
      const res = await fetch('/api/messages/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, text, origin }),
      });
      return res.json();
    },
    [],
  );

  const sendPipelineTest = useCallback(
    async (payload: {
      phoneOrJid: string;
      senderName: string;
      text: string;
      isGroup: boolean;
    }): Promise<{
      ok: boolean;
      accepted?: boolean;
      reason?: string;
      forwardedToTelegram?: boolean;
      message?: string;
    }> => {
      const res = await fetch('/api/test-pipeline/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.json();
    },
    [],
  );

  const markAsRead = useCallback(async (jid: string) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.jid === jid ? { ...c, unreadCount: 0 } : c,
        ),
      };
    });
    await fetch(`/api/conversations/${encodeURIComponent(jid)}/read`, { method: 'POST' });
  }, []);

  const clearSamples = useCallback(async () => {
    const res = await fetch('/api/conversations/clear-samples', { method: 'POST' });
    const data = await res.json();
    if (data.ok && data.state) {
      setState(data.state);
    }
  }, []);

  return {
    state,
    loading,
    error,
    socketConnected,
    connectWhatsApp,
    disconnectWhatsApp,
    connectTelegram,
    disconnectTelegram,
    testTelegram,
    updateRules,
    sendReply,
    sendPipelineTest,
    markAsRead,
    clearSamples,
  };
}

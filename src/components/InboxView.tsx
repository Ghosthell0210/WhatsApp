import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  Film,
  Image as ImageIcon,
  Info,
  MapPin,
  Mic,
  Search,
  Send,
  Smile,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type {
  BridgeContact,
  BridgeConversation,
  BridgeMessage,
  BridgeStats,
  WhatsAppPublicState,
} from '../bridge/types';

interface InboxViewProps {
  conversations: BridgeConversation[];
  contacts: BridgeContact[];
  stats: BridgeStats;
  whatsapp: WhatsAppPublicState;
  loading: boolean;
  onSelectConversation: (jid: string) => void;
  onToggleArchive: (jid: string) => Promise<unknown>;
  onSendReply: (
    jid: string,
    text: string,
    origin: 'web' | 'telegram',
  ) => Promise<{ ok: boolean; detail?: string; message?: string }>;
  onClearSamples: () => Promise<void>;
  onOpenTestModal: () => void;
}

type InboxFilter = 'all' | 'unread' | 'archived' | 'real';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function mediaIndicator(mediaType: BridgeMessage['mediaType']): {
  label: string;
  icon: typeof ImageIcon;
} | null {
  switch (mediaType) {
    case 'image':
      return { label: 'Imagen adjunta', icon: ImageIcon };
    case 'audio':
      return { label: 'Audio / Nota de voz', icon: Mic };
    case 'video':
      return { label: 'Video adjunto', icon: Film };
    case 'document':
      return { label: 'Documento adjunto', icon: FileText };
    case 'sticker':
      return { label: 'Sticker', icon: Smile };
    case 'location':
      return { label: 'Ubicación', icon: MapPin };
    case 'contact':
      return { label: 'Contacto compartido', icon: User };
    default:
      return null;
  }
}

export function InboxView({
  conversations,
  contacts,
  stats,
  whatsapp,
  loading,
  onSelectConversation,
  onToggleArchive,
  onSendReply,
  onClearSamples,
  onOpenTestModal,
}: InboxViewProps) {
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [replyText, setReplyText] = useState('');
  const [replyOrigin, setReplyOrigin] = useState<'web' | 'telegram'>('telegram');
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<string | null>(null);
  const [mobileShowThread, setMobileShowThread] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const hasSamples = useMemo(() => conversations.some((c) => c.isSample), [conversations]);

  const contactsMap = useMemo(() => {
    const map = new Map<string, BridgeContact>();
    for (const c of contacts) {
      map.set(c.jid, c);
    }
    return map;
  }, [contacts]);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return conversations.filter((conv) => {
      if (filter === 'archived') {
        if (!conv.archived) return false;
      } else if (!q && conv.archived) {
        return false;
      }
      if (filter === 'unread' && conv.unreadCount === 0) return false;
      if (filter === 'real' && conv.isSample) return false;
      if (!q) return true;
      const contact = contactsMap.get(conv.jid);
      return (
        conv.name.toLowerCase().includes(q) ||
        conv.phoneDisplay.toLowerCase().includes(q) ||
        conv.lastMessageText.toLowerCase().includes(q) ||
        Boolean(contact?.customAlias?.toLowerCase().includes(q)) ||
        Boolean(contact?.profileName?.toLowerCase().includes(q))
      );
    });
  }, [contactsMap, conversations, filter, searchQuery]);

  const activeConversation = useMemo(() => {
    if (selectedJid) {
      const found = conversations.find((c) => c.jid === selectedJid);
      if (found) return found;
    }
    return filteredConversations[0] ?? conversations[0] ?? null;
  }, [conversations, filteredConversations, selectedJid]);

  useEffect(() => {
    if (!selectedJid && conversations.length > 0) {
      setSelectedJid(conversations[0].jid);
    }
  }, [conversations, selectedJid]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages.length, activeConversation?.jid]);

  const handleSelect = (jid: string) => {
    setSelectedJid(jid);
    setMobileShowThread(true);
    setSendFeedback(null);
    onSelectConversation(jid);
  };

  const handleSubmitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConversation) return;
    const trimmed = replyText.trim();
    if (!trimmed) {
      setSendFeedback('Escribe una respuesta antes de enviar.');
      return;
    }

    setSending(true);
    setSendFeedback(null);
    try {
      const res = await onSendReply(activeConversation.jid, trimmed, replyOrigin);
      if (res.ok) {
        setReplyText('');
        setSendFeedback(res.detail || 'Respuesta enviada.');
      } else {
        setSendFeedback(res.message || 'No se pudo enviar la respuesta.');
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} className="p-4 space-y-2 animate-pulse">
              <div className="h-3 w-28 bg-slate-200 rounded" />
              <div className="h-7 w-14 bg-slate-200 rounded" />
            </div>
          ))}
        </div>
        <div className="h-[520px] bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Compact 4-column metric bar */}
      <section
        aria-label="Resumen de actividad del puente"
        className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        <div className="p-4 border-r border-b lg:border-b-0 border-slate-200">
          <p className="text-xs font-medium text-slate-500">PV reenviados a Telegram</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {stats.totalForwardedToTg}
          </p>
        </div>
        <div className="p-4 border-b lg:border-b-0 lg:border-r border-slate-200">
          <p className="text-xs font-medium text-slate-500">Respuestas enviadas a WA</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-teal-700">
            {stats.totalRepliesToWa}
          </p>
        </div>
        <div className="p-4 border-r border-slate-200">
          <p className="text-xs font-medium text-slate-500">Grupos / estados filtrados</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {stats.totalIgnoredNonPv}
          </p>
        </div>
        <div className="p-4">
          <p className="text-xs font-medium text-slate-500">Conversaciones PV activas</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {stats.activeConversations}
          </p>
        </div>
      </section>

      {/* Master-detail conversation console */}
      <section
        aria-label="Conversaciones privadas de WhatsApp"
        className="bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[540px] lg:h-[600px]"
      >
        {/* Left thread list */}
        <div
          className={`lg:col-span-5 xl:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col min-h-0 ${
            mobileShowThread ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <div className="p-3.5 border-b border-slate-200 space-y-2.5">
            <div className="relative">
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <label htmlFor="inbox-search" className="sr-only">
                Buscar contacto o mensaje
              </label>
              <input
                id="inbox-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar contacto o número..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="tablist"
                aria-label="Filtrar conversaciones"
                className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  onClick={() => setFilter('all')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    filter === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Todos
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'unread'}
                  onClick={() => setFilter('unread')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    filter === 'unread'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Sin responder
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'real'}
                  onClick={() => setFilter('real')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    filter === 'real'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Solo reales
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'archived'}
                  onClick={() => setFilter('archived')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    filter === 'archived'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Archivados
                </button>
              </div>

              {hasSamples && (
                <button
                  type="button"
                  onClick={() => void onClearSamples()}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 hover:text-rose-700 rounded transition-colors whitespace-nowrap shrink-0"
                  title="Eliminar conversaciones de ejemplo"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Limpiar ejemplos</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredConversations.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <p className="text-sm font-medium text-slate-700">No hay conversaciones privadas</p>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Cuando llegue un mensaje privado a tu WhatsApp vinculado aparecerá aquí y en tu Telegram.
                </p>
                <button
                  type="button"
                  onClick={onOpenTestModal}
                  className="inline-flex items-center justify-center px-3.5 py-2 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-lg transition-colors"
                >
                  Probar con un mensaje PV
                </button>
              </div>
            ) : (
              filteredConversations.map((conv) => {
                const isSelected = activeConversation?.jid === conv.jid;
                return (
                  <button
                    key={conv.jid}
                    type="button"
                    onClick={() => handleSelect(conv.jid)}
                    className={`w-full text-left px-4 py-3.5 transition-colors flex flex-col gap-1 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-teal-700 ${
                      isSelected ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 truncate">
                        {conv.name}
                      </span>
                      <span className="font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                        {formatTime(conv.lastMessageAt)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                      <span>{conv.phoneDisplay}</span>
                      {conv.isSample && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-sans text-slate-400">Ejemplo</span>
                        </>
                      )}
                      {conv.unreadCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-sans font-semibold text-teal-700">
                            {conv.unreadCount} nuevo
                          </span>
                        </>
                      )}
                    </div>

                    <p className="text-xs text-slate-600 truncate">{conv.lastMessageText}</p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right active thread */}
        <div
          className={`lg:col-span-7 xl:col-span-8 flex flex-col min-h-0 bg-slate-50/40 ${
            mobileShowThread ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {activeConversation ? (
            <>
              <div className="px-5 py-3.5 bg-white border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setMobileShowThread(false)}
                    aria-label="Volver a la lista de chats"
                    className="lg:hidden p-1.5 -ml-1.5 text-slate-600 hover:text-slate-900 rounded-md"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="font-display text-sm sm:text-base font-semibold text-slate-900 truncate">
                        {activeConversation.name}
                      </h2>
                      {contactsMap.get(activeConversation.jid)?.noProfileNameWarn &&
                        !contactsMap.get(activeConversation.jid)?.customAlias && (
                          <span
                            title="Contacto sin nombre de perfil en WhatsApp"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-medium shrink-0"
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Sin nombre
                          </span>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                      <span className="font-mono tabular-nums">{activeConversation.phoneDisplay}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono truncate max-w-[210px]">{activeConversation.jid}</span>
                      {activeConversation.lastTelegramMessageId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-sky-700">
                            TG #{activeConversation.lastTelegramMessageId}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowContactModal(true)}
                    title="Ver ficha e historial del contacto"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    <Info className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Ficha</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onToggleArchive(activeConversation.jid)}
                    title={activeConversation.archived ? 'Restaurar conversación' : 'Archivar conversación'}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    {activeConversation.archived ? (
                      <>
                        <ArchiveRestore className="w-3.5 h-3.5 text-teal-700" />
                        <span className="hidden sm:inline">Restaurar</span>
                      </>
                    ) : (
                      <>
                        <Archive className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Archivar</span>
                      </>
                    )}
                  </button>
                  <div className="hidden md:block text-right text-xs text-slate-500 pl-2 border-l border-slate-200">
                    {whatsapp.status === 'connected' ? (
                      <span className="text-emerald-700 font-medium">WA activo</span>
                    ) : (
                      <span>Registro local</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Message timeline */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {activeConversation.messages.map((msg) => {
                  const isInbound = msg.direction === 'inbound_wa';
                  const media = mediaIndicator(msg.mediaType);
                  const MediaIcon = media?.icon;
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isInbound ? 'items-start' : 'items-end'}`}
                    >
                      <div
                        className={`max-w-[85%] sm:max-w-[75%] rounded-xl px-4 py-2.5 border ${
                          isInbound
                            ? 'bg-white border-slate-200 text-slate-900'
                            : msg.direction === 'outbound_tg'
                              ? 'bg-sky-50 border-sky-200 text-slate-900'
                              : 'bg-teal-700 border-teal-700 text-white'
                        }`}
                      >
                        {media && MediaIcon && (
                          <div
                            className={`mb-1 flex items-center gap-1.5 text-[11px] font-medium ${
                              msg.direction === 'outbound_web' ? 'text-teal-100' : 'text-teal-700'
                            }`}
                          >
                            <MediaIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            <span>{media.label}</span>
                          </div>
                        )}
                        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                          {msg.text}
                        </p>
                        {msg.reactions && msg.reactions.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {msg.reactions.map((rx) => (
                              <span
                                key={rx.emoji}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 text-xs font-medium border border-slate-200"
                              >
                                <span>{rx.emoji}</span>
                                {rx.count > 1 && (
                                  <span className="font-mono tabular-nums text-[11px] text-slate-600">
                                    x{rx.count}
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="mt-1 px-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                        <span>
                          {isInbound
                            ? 'WhatsApp PV'
                            : msg.direction === 'outbound_tg'
                              ? 'Respondido desde Telegram'
                              : 'Respondido desde Consola'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{formatDateTime(msg.timestamp)}</span>
                        {msg.telegramMessageId && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">TG #{msg.telegramMessageId}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Reply composer */}
              <form
                onSubmit={(e) => void handleSubmitReply(e)}
                className="p-4 bg-white border-t border-slate-200 space-y-2.5 shrink-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-slate-600 font-medium">
                    Responder a {activeConversation.name}
                  </span>

                  <div
                    role="radiogroup"
                    aria-label="Canal de origen de la respuesta"
                    className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md"
                  >
                    <button
                      type="button"
                      onClick={() => setReplyOrigin('telegram')}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        replyOrigin === 'telegram'
                          ? 'bg-white text-sky-800 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Vía Telegram
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyOrigin('web')}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                        replyOrigin === 'web'
                          ? 'bg-white text-teal-800 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Consola web
                    </button>
                  </div>
                </div>

                <div className="flex items-end gap-2.5">
                  <label htmlFor="reply-textarea" className="sr-only">
                    Mensaje de respuesta para {activeConversation.name}
                  </label>
                  <textarea
                    id="reply-textarea"
                    rows={2}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSubmitReply(e);
                      }
                    }}
                    placeholder="Escribe una respuesta para enviar a WhatsApp (Enter para enviar)..."
                    className="flex-1 resize-none px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                  <button
                    type="submit"
                    disabled={sending}
                    className="inline-flex items-center gap-2 px-4 py-2.5 h-[42px] text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                  >
                    <Send className="w-4 h-4" aria-hidden="true" />
                    <span>{sending ? 'Enviando...' : 'Responder'}</span>
                  </button>
                </div>

                {sendFeedback && (
                  <p className="text-xs text-slate-600" role="status">
                    {sendFeedback}
                  </p>
                )}
              </form>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <p className="text-base font-semibold text-slate-800">
                Selecciona una conversación o prueba el puente
              </p>
              <p className="text-sm text-slate-500 max-w-md">
                Los mensajes privados recibidos en WhatsApp aparecerán aquí sincronizados con tu bot de Telegram.
              </p>
              <button
                type="button"
                onClick={onOpenTestModal}
                className="px-4 py-2 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors"
              >
                Simular mensaje privado
              </button>
            </div>
          )}
        </div>
      </section>

      {showContactModal && activeConversation && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ficha del contacto"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <div className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  {activeConversation.name}
                </h3>
                <p className="font-mono text-xs text-slate-500">{activeConversation.phoneDisplay}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowContactModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(() => {
              const c = contactsMap.get(activeConversation.jid);
              const inboundCount = activeConversation.messages.filter((m) => m.direction === 'inbound_wa').length;
              const outboundCount = activeConversation.messages.length - inboundCount;
              return (
                <div className="space-y-3 text-sm">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">JID interno:</span>
                      <span className="font-mono text-slate-800">{activeConversation.jid}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Nombre de perfil WA:</span>
                      <span className="text-slate-800 font-medium">
                        {c?.profileName || 'Sin nombre de perfil'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Alias manual (/nuevo):</span>
                      <span className="text-slate-800 font-medium">{c?.customAlias || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Mensajes recibidos / enviados:</span>
                      <span className="font-mono tabular-nums text-slate-800">
                        {inboundCount} / {outboundCount}
                      </span>
                    </div>
                  </div>

                  {c?.tags && c.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {c.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 text-xs font-medium"
                        >
                          <Tag className="w-3 h-3" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

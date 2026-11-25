import { useEffect, useState } from 'react';
import { Eye, EyeOff, LogOut, QrCode, RefreshCw, Send, Smartphone } from 'lucide-react';
import { validateTelegramConfigInput } from '../bridge/logic';
import type { TelegramPublicState, WhatsAppPublicState } from '../bridge/types';
import type { TelegramFormErrors } from '../hooks/useBridgeSocket';

interface ConnectionsViewProps {
  whatsapp: WhatsAppPublicState;
  telegram: TelegramPublicState;
  onConnectWhatsApp: () => Promise<unknown>;
  onDisconnectWhatsApp: (logout: boolean) => Promise<unknown>;
  onConnectTelegram: (
    token: string,
    chatId: string,
  ) => Promise<{ ok: boolean; message?: string; errors?: TelegramFormErrors }>;
  onDisconnectTelegram: () => Promise<unknown>;
  onTestTelegram: () => Promise<{ ok: boolean; error?: string }>;
}

export function ConnectionsView({
  whatsapp,
  telegram,
  onConnectWhatsApp,
  onDisconnectWhatsApp,
  onConnectTelegram,
  onDisconnectTelegram,
  onTestTelegram,
}: ConnectionsViewProps) {
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState(telegram.chatId || '');
  const [showToken, setShowToken] = useState(false);
  const [tgSubmitting, setTgSubmitting] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<TelegramFormErrors>({});
  const [waBusy, setWaBusy] = useState(false);
  const [testingTg, setTestingTg] = useState(false);

  useEffect(() => {
    if (telegram.chatId && !chatId) {
      setChatId(telegram.chatId);
    }
  }, [telegram.chatId, chatId]);

  const handleWaConnect = async () => {
    setWaBusy(true);
    try {
      await onConnectWhatsApp();
    } finally {
      setWaBusy(false);
    }
  };

  const handleWaDisconnect = async (logout: boolean) => {
    setWaBusy(true);
    try {
      await onDisconnectWhatsApp(logout);
    } finally {
      setWaBusy(false);
    }
  };

  const handleTgSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTgFeedback(null);
    setFieldErrors({});

    const localValidation = validateTelegramConfigInput(token, chatId);
    if (!localValidation.valid) {
      setFieldErrors(localValidation.errors);
      setTgFeedback({
        type: 'err',
        text: 'Revisa el Token del Bot y el Chat ID de Telegram.',
      });
      return;
    }

    setTgSubmitting(true);

    try {
      const res = await onConnectTelegram(token, chatId);
      if (!res.ok) {
        if (res.errors) setFieldErrors(res.errors);
        setTgFeedback({
          type: 'err',
          text: res.message || 'Verifica los datos ingresados.',
        });
      } else {
        setToken('');
        setTgFeedback({
          type: 'ok',
          text: 'Bot de Telegram conectado y escuchando respuestas.',
        });
      }
    } finally {
      setTgSubmitting(false);
    }
  };

  const handleTestTelegram = async () => {
    setTestingTg(true);
    setTgFeedback(null);
    try {
      const res = await onTestTelegram();
      if (res.ok) {
        setTgFeedback({
          type: 'ok',
          text: 'Mensaje de prueba enviado correctamente a tu Telegram.',
        });
      } else {
        setTgFeedback({
          type: 'err',
          text: res.error || 'No se pudo enviar el mensaje de prueba.',
        });
      }
    } finally {
      setTestingTg(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* WhatsApp Web Baileys Card */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-6">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  1. WhatsApp Web (Dispositivo vinculado)
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Escanea el código QR desde WhatsApp en tu teléfono para escuchar tus chats privados en tiempo real.
                </p>
              </div>
              <span
                className={`text-xs font-semibold whitespace-nowrap shrink-0 ${
                  whatsapp.status === 'connected'
                    ? 'text-emerald-700'
                    : whatsapp.status === 'error'
                      ? 'text-rose-700'
                      : whatsapp.status === 'qr_ready' || whatsapp.status === 'connecting'
                        ? 'text-amber-700'
                        : 'text-slate-500'
                }`}
              >
                {whatsapp.status === 'connected' && 'Conectado'}
                {whatsapp.status === 'qr_ready' && 'QR listo para escanear'}
                {whatsapp.status === 'connecting' && 'Conectando...'}
                {whatsapp.status === 'error' && 'Error de sesión'}
                {whatsapp.status === 'disconnected' && 'Sin vincular'}
              </span>
            </div>

            {whatsapp.lastError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
                {whatsapp.lastError}
              </div>
            )}

            <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl flex flex-col items-center justify-center min-h-[250px] text-center">
              {whatsapp.status === 'qr_ready' && whatsapp.qrDataUrl ? (
                <div className="space-y-3">
                  <div className="p-3 bg-white border border-slate-200 rounded-lg inline-block">
                    <img
                      src={whatsapp.qrDataUrl}
                      alt="Código QR para vincular WhatsApp Web"
                      referrerPolicy="no-referrer"
                      className="w-52 h-52 object-contain"
                    />
                  </div>
                  <p className="text-xs text-slate-600">
                    Abre WhatsApp en tu móvil → Dispositivos vinculados → Vincular dispositivo.
                  </p>
                </div>
              ) : whatsapp.status === 'connected' ? (
                <div className="space-y-2">
                  <div className="w-12 h-12 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                    <Smartphone className="w-6 h-6" aria-hidden="true" />
                  </div>
                  <p className="text-base font-semibold text-slate-900">
                    {whatsapp.connectedName || 'WhatsApp activo'}
                  </p>
                  {whatsapp.connectedPhone && (
                    <p className="font-mono tabular-nums text-sm text-slate-600">
                      {whatsapp.connectedPhone}
                    </p>
                  )}
                  <p className="text-xs text-slate-500 max-w-xs">
                    Los mensajes privados entrantes se están enviando automáticamente según tus reglas de filtrado.
                  </p>
                </div>
              ) : whatsapp.status === 'connecting' ? (
                <div className="space-y-3">
                  <RefreshCw className="w-8 h-8 text-teal-700 mx-auto animate-spin" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-700">
                    Iniciando sesión multi-dispositivo y generando QR...
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5 max-w-xs">
                  <QrCode className="w-10 h-10 text-slate-400 mx-auto" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-800">Sesión no iniciada</p>
                  <p className="text-xs text-slate-500">
                    Presiona "Generar código QR" para vincular tu cuenta de WhatsApp sin usar navegador externo.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
            {whatsapp.status === 'disconnected' || whatsapp.status === 'error' ? (
              <button
                type="button"
                disabled={waBusy}
                onClick={() => void handleWaConnect()}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
              >
                <QrCode className="w-4 h-4" aria-hidden="true" />
                <span>{waBusy ? 'Iniciando...' : 'Generar código QR'}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={waBusy}
                  onClick={() => void handleWaDisconnect(false)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  <span>Pausar conexión</span>
                </button>
                <button
                  type="button"
                  disabled={waBusy}
                  onClick={() => void handleWaDisconnect(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                  <span>Cerrar sesión</span>
                </button>
              </>
            )}
          </div>
        </section>

        {/* Telegram Bot Card */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col">
          <form onSubmit={(e) => void handleTgSubmit(e)} className="flex-1 flex flex-col justify-between gap-6">
            <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900">
                  2. Bot de Telegram (Destino y respuestas)
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Crea un bot con <span className="font-mono text-slate-800">@BotFather</span> y define tu Chat ID donde llegarán los mensajes privados.
                </p>
              </div>
              <span
                className={`text-xs font-semibold whitespace-nowrap shrink-0 ${
                  telegram.status === 'connected'
                    ? 'text-sky-700'
                    : telegram.status === 'error'
                      ? 'text-rose-700'
                      : telegram.status === 'connecting'
                        ? 'text-amber-700'
                        : 'text-slate-500'
                }`}
              >
                {telegram.status === 'connected' && 'Conectado'}
                {telegram.status === 'connecting' && 'Verificando...'}
                {telegram.status === 'error' && 'Error'}
                {telegram.status === 'disconnected' && 'Sin configurar'}
              </span>
            </div>

            {telegram.status === 'connected' && (
              <div className="p-3.5 bg-sky-50 border border-sky-200 rounded-lg text-xs text-slate-700 space-y-1">
                <p className="font-semibold text-sky-900">
                  Bot activo: @{telegram.botUsername}
                </p>
                <p className="font-mono tabular-nums text-slate-600">
                  Token: {telegram.tokenMasked} · Chat ID: {telegram.chatId}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="tg-token" className="block text-xs font-medium text-slate-700 mb-1.5">
                Bot Token (@BotFather)
              </label>
              <div className="relative">
                <input
                  id="tg-token"
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    telegram.hasToken
                      ? `Actual: ${telegram.tokenMasked} (escribe uno nuevo para reemplazar)`
                      : '123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxx'
                  }
                  className="w-full pr-10 pl-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((prev) => !prev)}
                  aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors.token && (
                <p className="mt-1 text-xs text-rose-700">{fieldErrors.token}</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label htmlFor="tg-chat-id" className="block text-xs font-medium text-slate-700">
                  Tu Chat ID de Telegram
                </label>
                {telegram.lastDetectedChatId && (
                  <button
                    type="button"
                    onClick={() => setChatId(telegram.lastDetectedChatId || '')}
                    className="text-xs font-medium text-sky-700 hover:underline font-mono tabular-nums"
                  >
                    Usar detectado ({telegram.lastDetectedChatId})
                  </button>
                )}
              </div>
              <input
                id="tg-chat-id"
                type="text"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="Ej. 518294012 (envía /start al bot para verlo)"
                className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
              {fieldErrors.chatId && (
                <p className="mt-1 text-xs text-rose-700">{fieldErrors.chatId}</p>
              )}
            </div>

            {tgFeedback && (
              <p
                role="status"
                className={`text-xs font-medium ${
                  tgFeedback.type === 'ok' ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {tgFeedback.text}
              </p>
            )}

            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
              <button
                type="submit"
                disabled={tgSubmitting}
                className="px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
              >
                {tgSubmitting ? 'Conectando...' : 'Guardar y conectar'}
              </button>

              {telegram.status === 'connected' && (
                <>
                  <button
                    type="button"
                    disabled={testingTg}
                    onClick={() => void handleTestTelegram()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-sky-800 bg-sky-50 hover:bg-sky-100 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{testingTg ? 'Enviando...' : 'Enviar prueba'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDisconnectTelegram()}
                    className="px-3.5 py-2.5 text-sm font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Desconectar
                  </button>
                </>
              )}
            </div>
          </form>
        </section>
      </div>

      {/* How bidirectional reply works */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-display text-base font-semibold text-slate-900 mb-4">
          Cómo responder mensajes de WhatsApp desde Telegram
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
          <div className="space-y-1.5">
            <p className="font-semibold text-slate-900">01. Recepción privada</p>
            <p className="text-slate-600 leading-relaxed">
              Cada mensaje privado (<span className="font-mono text-xs">@s.whatsapp.net</span>) entra al servidor y se reenvía al instante a tu chat de Telegram con nombre y número.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-semibold text-slate-900">02. Respuesta nativa (Reply)</p>
            <p className="text-slate-600 leading-relaxed">
              En Telegram, desliza o haz clic en <strong>Responder</strong> sobre el mensaje reenviado y escribe tu texto. El puente identifica el contacto automáticamente.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-semibold text-slate-900">03. Comando rápido opcional</p>
            <p className="text-slate-600 leading-relaxed">
              También puedes iniciar una respuesta directa enviando{' '}
              <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                /responder +54911... Hola!
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* Plugged Host / Console Configuration Guide */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-900">
            Configuración desde consola (Plugged Host / Pterodactyl)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Todo el puente funciona directamente desde la consola del servidor sin depender del navegador: el código QR se imprime en texto en la terminal y puedes controlar todo con comandos o variables de entorno.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          <div className="space-y-2">
            <p className="font-semibold text-slate-900 text-sm">Variables de inicio recomendadas</p>
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg font-mono text-slate-800 space-y-1">
              <p>TELEGRAM_BOT_TOKEN=tu_token_de_botfather</p>
              <p>TELEGRAM_CHAT_ID=tu_chat_id_numerico</p>
              <p>WA_AUTO_CONNECT=true</p>
              <p>ONLY_PRIVATE_MESSAGES=true</p>
              <p>IGNORE_STATUS_BROADCASTS=true</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-semibold text-slate-900 text-sm">Comandos interactivos en la consola</p>
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg font-mono text-slate-800 space-y-1">
              <p>qr — Genera e imprime el código QR de WhatsApp en consola</p>
              <p>tg &lt;token&gt; &lt;chatId&gt; — Conecta el bot de Telegram al vuelo</p>
              <p>status — Muestra estado de WhatsApp, Telegram y filtros</p>
              <p>pv on | pv off — Activa o desactiva el filtro Solo PV</p>
              <p>wa logout — Cierra la sesión actual para cambiar de número</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

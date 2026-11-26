import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { formatPhoneDisplay, normalizePhoneToJid } from '../bridge/logic';
import type { AuditLogEntry, RoutingRules } from '../bridge/types';

interface RulesAndLogViewProps {
  rules: RoutingRules;
  auditLog: AuditLogEntry[];
  onUpdateRules: (partial: Partial<RoutingRules>) => Promise<unknown>;
}

type LogActionFilter = 'all' | 'forwarded_to_tg' | 'replied_to_wa' | 'ignored';

function formatLogTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function actionLabel(action: AuditLogEntry['action']): { label: string; colorClass: string } {
  switch (action) {
    case 'forwarded_to_tg':
      return { label: 'Reenviado a TG', colorClass: 'text-sky-700' };
    case 'replied_to_wa':
      return { label: 'Respondido a WA', colorClass: 'text-emerald-700' };
    case 'ignored_group':
      return { label: 'Grupo ignorado', colorClass: 'text-amber-700' };
    case 'ignored_broadcast':
      return { label: 'Estado ignorado', colorClass: 'text-amber-700' };
    case 'ignored_blocked':
      return { label: 'Contacto bloqueado', colorClass: 'text-amber-700' };
    case 'ignored_paused':
      return { label: 'En pausa', colorClass: 'text-amber-700' };
    default:
      return { label: 'Error', colorClass: 'text-rose-700' };
  }
}

export function RulesAndLogView({ rules, auditLog, onUpdateRules }: RulesAndLogViewProps) {
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<LogActionFilter>('all');
  const [autoMsgDraft, setAutoMsgDraft] = useState(rules.autoAckMessage);
  const [blockInput, setBlockInput] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [savingRule, setSavingRule] = useState(false);

  useEffect(() => {
    setAutoMsgDraft(rules.autoAckMessage);
  }, [rules.autoAckMessage]);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return auditLog.filter((entry) => {
      if (actionFilter === 'forwarded_to_tg' && entry.action !== 'forwarded_to_tg') return false;
      if (actionFilter === 'replied_to_wa' && entry.action !== 'replied_to_wa') return false;
      if (
        actionFilter === 'ignored' &&
        entry.action !== 'ignored_group' &&
        entry.action !== 'ignored_broadcast' &&
        entry.action !== 'ignored_blocked' &&
        entry.action !== 'ignored_paused'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        entry.contactName.toLowerCase().includes(q) ||
        entry.jid.toLowerCase().includes(q) ||
        entry.detail.toLowerCase().includes(q)
      );
    });
  }, [actionFilter, auditLog, search]);

  const handleToggle = async (key: keyof RoutingRules, nextValue: boolean) => {
    setSavingRule(true);
    try {
      await onUpdateRules({ [key]: nextValue });
    } finally {
      setSavingRule(false);
    }
  };

  const handleSaveAutoMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRule(true);
    try {
      await onUpdateRules({ autoAckMessage: autoMsgDraft.trim() });
    } finally {
      setSavingRule(false);
    }
  };

  const handleAddBlocked = async (e: React.FormEvent) => {
    e.preventDefault();
    setBlockError(null);
    const jid = normalizePhoneToJid(blockInput);
    if (!jid) {
      setBlockError('Ingresa un número válido con código de país (ej. +5491155551234).');
      return;
    }
    if (rules.blockedJids.includes(jid)) {
      setBlockError(`El contacto ${formatPhoneDisplay(jid)} ya está bloqueado.`);
      return;
    }
    setSavingRule(true);
    try {
      await onUpdateRules({ blockedJids: [...rules.blockedJids, jid] });
      setBlockInput('');
    } finally {
      setSavingRule(false);
    }
  };

  const handleUnblock = async (jid: string) => {
    setSavingRule(true);
    try {
      await onUpdateRules({
        blockedJids: rules.blockedJids.filter((item) => item !== jid),
      });
    } finally {
      setSavingRule(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Routing rules panel */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Reglas de filtrado de WhatsApp
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Controla qué tipo de chats se envían a Telegram y cómo se formatean.
            </p>
          </div>
          {savingRule && <span className="text-xs text-slate-500">Guardando...</span>}
        </div>

        <div className="divide-y divide-slate-100">
          <div className="py-3.5 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="rule-paused" className="text-sm font-medium text-slate-900 block">
                Pausar reenvío a Telegram
              </label>
              <p className="text-xs text-slate-500">
                Detiene temporalmente el envío de nuevos mensajes privados sin desconectar WhatsApp.
              </p>
            </div>
            <input
              id="rule-paused"
              type="checkbox"
              checked={rules.paused}
              onChange={(e) => void handleToggle('paused', e.target.checked)}
              className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="py-3.5 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="rule-only-pv" className="text-sm font-medium text-slate-900 block">
                Solo mensajes privados (PV)
              </label>
              <p className="text-xs text-slate-500">
                Ignora automáticamente mensajes provenientes de grupos (@g.us) y canales.
              </p>
            </div>
            <input
              id="rule-only-pv"
              type="checkbox"
              checked={rules.onlyPrivateMessages}
              onChange={(e) => void handleToggle('onlyPrivateMessages', e.target.checked)}
              className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="py-3.5 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="rule-ignore-status" className="text-sm font-medium text-slate-900 block">
                Ignorar estados y listas de difusión
              </label>
              <p className="text-xs text-slate-500">
                Descarta actualizaciones de status@broadcast para no saturar tu Telegram.
              </p>
            </div>
            <input
              id="rule-ignore-status"
              type="checkbox"
              checked={rules.ignoreStatusBroadcasts}
              onChange={(e) => void handleToggle('ignoreStatusBroadcasts', e.target.checked)}
              className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="py-3.5 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="rule-phone-header" className="text-sm font-medium text-slate-900 block">
                Incluir número de teléfono en la cabecera de Telegram
              </label>
              <p className="text-xs text-slate-500">
                Muestra el número junto al nombre del remitente para identificar contactos rápidamente.
              </p>
            </div>
            <input
              id="rule-phone-header"
              type="checkbox"
              checked={rules.includePhoneHeader}
              onChange={(e) => void handleToggle('includePhoneHeader', e.target.checked)}
              className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="py-3.5 flex items-center justify-between gap-4">
            <div>
              <label htmlFor="rule-reactions" className="text-sm font-medium text-slate-900 block">
                Reacciones en vivo (❤️ x3)
              </label>
              <p className="text-xs text-slate-500">
                Actualiza el mensaje original en Telegram cuando alguien reacciona en WhatsApp. También controlable con /reacciones off.
              </p>
            </div>
            <input
              id="rule-reactions"
              type="checkbox"
              checked={rules.reactionsEnabled}
              onChange={(e) => void handleToggle('reactionsEnabled', e.target.checked)}
              className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="py-3.5 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label htmlFor="rule-auto-ack" className="text-sm font-medium text-slate-900 block">
                  Confirmación automática al remitente
                </label>
                <p className="text-xs text-slate-500">
                  Envía una respuesta breve en WhatsApp cuando recibes un mensaje privado nuevo.
                </p>
              </div>
              <input
                id="rule-auto-ack"
                type="checkbox"
                checked={rules.autoAcknowledge}
                onChange={(e) => void handleToggle('autoAcknowledge', e.target.checked)}
                className="w-5 h-5 accent-teal-700 rounded cursor-pointer shrink-0"
              />
            </div>

            {rules.autoAcknowledge && (
              <form onSubmit={(e) => void handleSaveAutoMessage(e)} className="flex gap-2.5 pt-1">
                <label htmlFor="auto-ack-input" className="sr-only">
                  Texto de confirmación automática
                </label>
                <input
                  id="auto-ack-input"
                  type="text"
                  value={autoMsgDraft}
                  onChange={(e) => setAutoMsgDraft(e.target.value)}
                  placeholder="Recibí tu mensaje, te respondo en breve."
                  className="flex-1 px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
                >
                  Guardar texto
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* Blocked contacts panel */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Contactos bloqueados
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Silencia números específicos para no recibir sus mensajes privados en Telegram. También puedes usar{' '}
            <span className="font-mono text-xs text-slate-700">/bloquear</span> en Telegram.
          </p>
        </div>

        <form onSubmit={(e) => void handleAddBlocked(e)} className="flex flex-col sm:flex-row gap-2.5">
          <label htmlFor="block-phone-input" className="sr-only">
            Número de teléfono o JID a bloquear
          </label>
          <input
            id="block-phone-input"
            type="text"
            value={blockInput}
            onChange={(e) => {
              setBlockInput(e.target.value);
              if (blockError) setBlockError(null);
            }}
            placeholder="Ej. +5491155551234"
            className="flex-1 px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
          />
          <button
            type="submit"
            disabled={savingRule}
            className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
          >
            Bloquear número
          </button>
        </form>

        {blockError && (
          <p role="alert" className="text-xs text-rose-700">
            {blockError}
          </p>
        )}

        {rules.blockedJids.length === 0 ? (
          <p className="text-xs text-slate-500 pt-1">
            No hay contactos bloqueados. Todos los mensajes privados permitidos se reenviarán a Telegram.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {rules.blockedJids.map((jid) => (
              <li key={jid} className="py-2.5 flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-baseline gap-2 min-w-0">
                  <span className="font-mono tabular-nums text-sm font-medium text-slate-900">
                    {formatPhoneDisplay(jid)}
                  </span>
                  <span className="font-mono text-xs text-slate-500 truncate">{jid}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleUnblock(jid)}
                  disabled={savingRule}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Desbloquear
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* High-density audit log table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Registro de enrutamiento
            </h2>
            <p className="text-xs text-slate-500">
              Historial de mensajes reenviados, respuestas y elementos filtrados.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <label htmlFor="log-search" className="sr-only">
                Filtrar registro por contacto o detalle
              </label>
              <input
                id="log-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar en registro..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  ['all', 'Todos'],
                  ['forwarded_to_tg', 'Reenviados'],
                  ['replied_to_wa', 'Respuestas'],
                  ['ignored', 'Filtrados'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActionFilter(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    actionFilter === key
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4 whitespace-nowrap">Hora</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Acción</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Contacto / JID</th>
                <th className="py-2.5 px-4">Detalle</th>
                <th className="py-2.5 px-4 text-right whitespace-nowrap">ID Telegram</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-500">
                    No hay eventos que coincidan con el filtro seleccionado.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((entry) => {
                  const status = actionLabel(entry.action);
                  return (
                    <tr key={entry.id} className="h-10 hover:bg-slate-50/80 transition-colors">
                      <td className="py-2 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatLogTimestamp(entry.timestamp)}
                      </td>
                      <td className={`py-2 px-4 font-medium whitespace-nowrap ${status.colorClass}`}>
                        {status.label}
                      </td>
                      <td className="py-2 px-4 text-slate-900 whitespace-nowrap">
                        <span className="font-medium">{entry.contactName}</span>
                        <span className="text-slate-400 mx-1.5" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">{entry.jid}</span>
                      </td>
                      <td className="py-2 px-4 text-slate-600 max-w-md truncate">{entry.detail}</td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {entry.telegramMessageId ? `#${entry.telegramMessageId}` : '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

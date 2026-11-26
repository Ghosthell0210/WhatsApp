import { FlaskConical, Link2 } from 'lucide-react';
import type { ActiveTab } from './Sidebar';
import type { TelegramPublicState, WhatsAppPublicState } from '../bridge/types';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenTestModal: () => void;
  unreadTotal: number;
  whatsapp?: WhatsAppPublicState;
  telegram?: TelegramPublicState;
}

const TAB_TITLES: Record<ActiveTab, string> = {
  inbox: 'Bandeja de mensajes privados',
  contacts: 'Libreta de contactos',
  connections: 'Conexión WhatsApp y Telegram',
  rules: 'Reglas de filtrado y registro',
};

export function TopBar({
  activeTab,
  onSelectTab,
  onOpenTestModal,
  unreadTotal,
  whatsapp,
  telegram,
}: TopBarProps) {
  const isWaConnected = whatsapp?.status === 'connected';
  const isTgConnected = telegram?.status === 'connected';
  return (
    <header className="bg-white border-b border-slate-200 shrink-0">
      <div className="h-16 px-4 sm:px-6 flex items-center justify-between gap-6">
        <div className="flex items-center gap-3 min-w-0">
          <span className="lg:hidden font-display text-base font-bold text-slate-900 whitespace-nowrap shrink-0">
            Puente WA-TG
          </span>
          <span className="hidden sm:inline lg:hidden text-slate-300" aria-hidden="true">
            /
          </span>
          <h1 className="hidden sm:block font-display text-base sm:text-lg font-semibold text-slate-900 truncate">
            {TAB_TITLES[activeTab]}
          </h1>
          <div className="hidden xl:flex items-center gap-2 pl-3 border-l border-slate-200">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ${
                isWaConnected
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-slate-100 text-slate-600 border border-slate-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${isWaConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`}
              ></span>
              <span>WhatsApp: {isWaConnected ? 'Vinculado' : 'Sin vincular'}</span>
            </span>

            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ${
                isTgConnected
                  ? 'bg-sky-50 text-sky-800 border border-sky-200'
                  : 'bg-slate-100 text-slate-600 border border-slate-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${isTgConnected ? 'bg-sky-500 animate-pulse' : 'bg-slate-400'}`}
              ></span>
              <span>Bot Telegram: {isTgConnected ? `@${telegram?.botUsername || 'activo'}` : 'Sin configurar'}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onOpenTestModal}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            <FlaskConical className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
            <span>Probar flujo PV</span>
          </button>

          {activeTab !== 'connections' && (
            <button
              type="button"
              onClick={() => onSelectTab('connections')}
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              <Link2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Vincular canales</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile tab bar */}
      <nav
        aria-label="Navegación móvil"
        className="lg:hidden flex items-center gap-1 px-4 py-2 border-t border-slate-100 bg-slate-50 overflow-x-auto"
      >
        <button
          type="button"
          onClick={() => onSelectTab('inbox')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
            activeTab === 'inbox'
              ? 'bg-white text-teal-800 border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Bandeja PV{unreadTotal > 0 ? ` (${unreadTotal})` : ''}
        </button>
        <button
          type="button"
          onClick={() => onSelectTab('contacts')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
            activeTab === 'contacts'
              ? 'bg-white text-teal-800 border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Contactos
        </button>
        <button
          type="button"
          onClick={() => onSelectTab('connections')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
            activeTab === 'connections'
              ? 'bg-white text-teal-800 border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Conexiones
        </button>
        <button
          type="button"
          onClick={() => onSelectTab('rules')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
            activeTab === 'rules'
              ? 'bg-white text-teal-800 border border-slate-200'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Reglas y Registro
        </button>
      </nav>
    </header>
  );
}

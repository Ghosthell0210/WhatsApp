import { FlaskConical, Link2 } from 'lucide-react';
import type { ActiveTab } from './Sidebar';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenTestModal: () => void;
  unreadTotal: number;
}

const TAB_TITLES: Record<ActiveTab, string> = {
  inbox: 'Bandeja de mensajes privados',
  connections: 'Conexión WhatsApp y Telegram',
  rules: 'Reglas de filtrado y registro',
};

export function TopBar({ activeTab, onSelectTab, onOpenTestModal, unreadTotal }: TopBarProps) {
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

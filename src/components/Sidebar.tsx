import { Inbox, Link2, ShieldCheck, MessageSquare, Send } from 'lucide-react';
import type { TelegramPublicState, WhatsAppPublicState } from '../bridge/types';

export type ActiveTab = 'inbox' | 'connections' | 'rules';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  whatsapp: WhatsAppPublicState;
  telegram: TelegramPublicState;
  unreadTotal: number;
}

function waStatusText(status: WhatsAppPublicState['status']): { label: string; tone: string } {
  switch (status) {
    case 'connected':
      return { label: 'Conectado', tone: 'text-emerald-700' };
    case 'qr_ready':
      return { label: 'Esperando QR', tone: 'text-amber-700' };
    case 'connecting':
      return { label: 'Conectando', tone: 'text-amber-700' };
    case 'error':
      return { label: 'Error', tone: 'text-rose-700' };
    default:
      return { label: 'Sin vincular', tone: 'text-slate-500' };
  }
}

function tgStatusText(status: TelegramPublicState['status']): { label: string; tone: string } {
  switch (status) {
    case 'connected':
      return { label: 'Activo', tone: 'text-sky-700' };
    case 'connecting':
      return { label: 'Verificando', tone: 'text-amber-700' };
    case 'error':
      return { label: 'Error', tone: 'text-rose-700' };
    default:
      return { label: 'Sin configurar', tone: 'text-slate-500' };
  }
}

export function Sidebar({
  activeTab,
  onSelectTab,
  whatsapp,
  telegram,
  unreadTotal,
}: SidebarProps) {
  const waInfo = waStatusText(whatsapp.status);
  const tgInfo = tgStatusText(telegram.status);

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    icon: typeof Inbox;
    count?: number;
  }> = [
    { id: 'inbox', label: 'Bandeja PV', icon: Inbox, count: unreadTotal },
    { id: 'connections', label: 'Conexiones', icon: Link2 },
    { id: 'rules', label: 'Reglas y Registro', icon: ShieldCheck },
  ];

  return (
    <aside className="hidden lg:flex lg:w-64 lg:shrink-0 lg:flex-col border-r border-slate-200 bg-white">
      <div className="h-16 px-5 flex items-center border-b border-slate-200">
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
          Puente WA-TG
        </span>
      </div>

      <nav aria-label="Navegación principal" className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${
                isActive
                  ? 'bg-teal-50 text-teal-800'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </span>
              {typeof item.count === 'number' && item.count > 0 && (
                <span className="text-xs font-mono tabular-nums font-semibold text-teal-700">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-200 space-y-3">
        <p className="text-xs font-medium text-slate-500">Estado de canales</p>

        <div className="space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-slate-700 font-medium">
              <MessageSquare className="w-3.5 h-3.5 text-emerald-700 shrink-0" aria-hidden="true" />
              WhatsApp
            </span>
            <span className={`font-medium whitespace-nowrap ${waInfo.tone}`}>{waInfo.label}</span>
          </div>
          {whatsapp.connectedPhone && (
            <p className="font-mono tabular-nums text-[11px] text-slate-500 pl-5 truncate">
              {whatsapp.connectedPhone}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="flex items-center gap-2 text-slate-700 font-medium">
              <Send className="w-3.5 h-3.5 text-sky-700 shrink-0" aria-hidden="true" />
              Telegram
            </span>
            <span className={`font-medium whitespace-nowrap ${tgInfo.tone}`}>{tgInfo.label}</span>
          </div>
          {telegram.botUsername && (
            <p className="font-mono text-[11px] text-slate-500 pl-5 truncate">
              @{telegram.botUsername}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onSelectTab('connections')}
          className="w-full mt-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          Configurar canales
        </button>
      </div>
    </aside>
  );
}

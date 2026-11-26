import { useMemo, useState } from 'react';
import { Sidebar, type ActiveTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { InboxView } from './components/InboxView';
import { ContactsView } from './components/ContactsView';
import { ConnectionsView } from './components/ConnectionsView';
import { RulesAndLogView } from './components/RulesAndLogView';
import { PipelineTestModal } from './components/PipelineTestModal';
import { useBridgeSocket } from './hooks/useBridgeSocket';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('inbox');
  const [testModalOpen, setTestModalOpen] = useState(false);

  const {
    state,
    loading,
    error,
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
  } = useBridgeSocket();

  const unreadTotal = useMemo(() => {
    if (!state) return 0;
    return state.conversations.reduce((acc, c) => acc + c.unreadCount, 0);
  }, [state]);

  const fallbackWa = state?.whatsapp ?? {
    status: 'disconnected' as const,
    qrDataUrl: null,
    pairingCode: null,
    connectedPhone: null,
    connectedName: null,
    lastError: null,
  };

  const fallbackTg = state?.telegram ?? {
    status: 'disconnected' as const,
    hasToken: false,
    tokenMasked: '',
    botUsername: null,
    chatId: '',
    lastError: null,
    lastDetectedChatId: null,
  };

  const fallbackStats = state?.stats ?? {
    totalForwardedToTg: 0,
    totalRepliesToWa: 0,
    totalIgnoredNonPv: 0,
    activeConversations: 0,
  };

  const fallbackRules = state?.rules ?? {
    onlyPrivateMessages: true,
    ignoreStatusBroadcasts: true,
    includePhoneHeader: true,
    autoAcknowledge: false,
    autoAckMessage: 'Recibí tu mensaje, te respondo en breve.',
    paused: false,
    blockedJids: [],
    reactionsEnabled: true,
  };

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        whatsapp={fallbackWa}
        telegram={fallbackTg}
        unreadTotal={unreadTotal}
        paused={fallbackRules.paused}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onOpenTestModal={() => setTestModalOpen(true)}
          unreadTotal={unreadTotal}
          whatsapp={fallbackWa}
          telegram={fallbackTg}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-[1280px] w-full mx-auto">
          {error && (
            <div
              role="alert"
              className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-xl text-sm text-rose-800"
            >
              {error}
            </div>
          )}

          {activeTab === 'inbox' && (
            <InboxView
              conversations={state?.conversations ?? []}
              stats={fallbackStats}
              whatsapp={fallbackWa}
              loading={loading}
              onSelectConversation={(jid) => void markAsRead(jid)}
              onSendReply={sendReply}
              onClearSamples={clearSamples}
              onOpenTestModal={() => setTestModalOpen(true)}
            />
          )}

          {activeTab === 'contacts' && (
            <ContactsView contacts={state?.contacts ?? []} />
          )}

          {activeTab === 'connections' && (
            <ConnectionsView
              whatsapp={fallbackWa}
              telegram={fallbackTg}
              onConnectWhatsApp={connectWhatsApp}
              onDisconnectWhatsApp={disconnectWhatsApp}
              onConnectTelegram={connectTelegram}
              onDisconnectTelegram={disconnectTelegram}
              onTestTelegram={testTelegram}
            />
          )}

          {activeTab === 'rules' && (
            <RulesAndLogView
              rules={fallbackRules}
              auditLog={state?.auditLog ?? []}
              onUpdateRules={updateRules}
            />
          )}
        </main>
      </div>

      <PipelineTestModal
        isOpen={testModalOpen}
        onClose={() => setTestModalOpen(false)}
        onSubmitTest={sendPipelineTest}
      />
    </div>
  );
}

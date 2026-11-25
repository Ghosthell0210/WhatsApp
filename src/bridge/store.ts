import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AuditLogEntry,
  BridgeConversation,
  BridgeMessage,
  BridgePublicState,
  BridgeStats,
  MediaKind,
  MessageDirection,
  RoutingRules,
  TelegramPublicState,
  WhatsAppPublicState,
} from './types';
import { formatPhoneDisplay } from './logic';

interface PersistedBridgeData {
  rules: RoutingRules;
  conversations: BridgeConversation[];
  auditLog: AuditLogEntry[];
  telegramMap: Record<string, string>; // telegramMessageId -> whatsappJid
  telegramChatId: string;
  stats: {
    totalForwardedToTg: number;
    totalRepliesToWa: number;
    totalIgnoredNonPv: number;
  };
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'bridge-state.json');

function buildSeedData(): PersistedBridgeData {
  const now = Date.now();
  const min = 60_000;

  const conversations: BridgeConversation[] = [
    {
      jid: '5491155551234@s.whatsapp.net',
      name: 'Lucía Méndez',
      phoneDisplay: '+5491155551234',
      lastMessageText: 'Perfecto, te paso el comprobante por aquí apenas salga.',
      lastMessageAt: now - 4 * min,
      lastDirection: 'inbound_wa',
      unreadCount: 1,
      lastTelegramMessageId: 1042,
      isSample: true,
      messages: [
        {
          id: crypto.randomUUID(),
          jid: '5491155551234@s.whatsapp.net',
          senderName: 'Lucía Méndez',
          phoneDisplay: '+5491155551234',
          direction: 'inbound_wa',
          text: 'Hola! ¿Confirmamos la entrega para las 16:30?',
          mediaType: 'text',
          timestamp: now - 14 * min,
          telegramMessageId: 1040,
          isSample: true,
          deliveryStatus: 'delivered_tg',
        },
        {
          id: crypto.randomUUID(),
          jid: '5491155551234@s.whatsapp.net',
          senderName: 'Tú (Telegram)',
          phoneDisplay: '+5491155551234',
          direction: 'outbound_tg',
          text: 'Sí, Lucía. A las 16:30 te esperamos en recepción.',
          mediaType: 'text',
          timestamp: now - 9 * min,
          telegramMessageId: 1041,
          isSample: true,
          deliveryStatus: 'sent_wa',
        },
        {
          id: crypto.randomUUID(),
          jid: '5491155551234@s.whatsapp.net',
          senderName: 'Lucía Méndez',
          phoneDisplay: '+5491155551234',
          direction: 'inbound_wa',
          text: 'Perfecto, te paso el comprobante por aquí apenas salga.',
          mediaType: 'text',
          timestamp: now - 4 * min,
          telegramMessageId: 1042,
          isSample: true,
          deliveryStatus: 'delivered_tg',
        },
      ],
    },
    {
      jid: '5215548291034@s.whatsapp.net',
      name: 'Mateo Herrera',
      phoneDisplay: '+5215548291034',
      lastMessageText: '¿Me puedes confirmar si recibieron los planos corregidos?',
      lastMessageAt: now - 26 * min,
      lastDirection: 'inbound_wa',
      unreadCount: 1,
      lastTelegramMessageId: 1039,
      isSample: true,
      messages: [
        {
          id: crypto.randomUUID(),
          jid: '5215548291034@s.whatsapp.net',
          senderName: 'Mateo Herrera',
          phoneDisplay: '+5215548291034',
          direction: 'inbound_wa',
          text: '¿Me puedes confirmar si recibieron los planos corregidos?',
          mediaType: 'text',
          timestamp: now - 26 * min,
          telegramMessageId: 1039,
          isSample: true,
          deliveryStatus: 'delivered_tg',
        },
      ],
    },
    {
      jid: '34612908451@s.whatsapp.net',
      name: 'Sofía Navarro',
      phoneDisplay: '+34612908451',
      lastMessageText: 'Genial, quedamos así entonces. Gracias!',
      lastMessageAt: now - 95 * min,
      lastDirection: 'inbound_wa',
      unreadCount: 0,
      lastTelegramMessageId: 1036,
      isSample: true,
      messages: [
        {
          id: crypto.randomUUID(),
          jid: '34612908451@s.whatsapp.net',
          senderName: 'Sofía Navarro',
          phoneDisplay: '+34612908451',
          direction: 'inbound_wa',
          text: '[Nota de voz]',
          mediaType: 'audio',
          timestamp: now - 110 * min,
          telegramMessageId: 1034,
          isSample: true,
          deliveryStatus: 'delivered_tg',
        },
        {
          id: crypto.randomUUID(),
          jid: '34612908451@s.whatsapp.net',
          senderName: 'Tú (Consola)',
          phoneDisplay: '+34612908451',
          direction: 'outbound_web',
          text: 'Recibido Sofía, lo reviso hoy por la tarde.',
          mediaType: 'text',
          timestamp: now - 102 * min,
          isSample: true,
          deliveryStatus: 'sent_wa',
        },
        {
          id: crypto.randomUUID(),
          jid: '34612908451@s.whatsapp.net',
          senderName: 'Sofía Navarro',
          phoneDisplay: '+34612908451',
          direction: 'inbound_wa',
          text: 'Genial, quedamos así entonces. Gracias!',
          mediaType: 'text',
          timestamp: now - 95 * min,
          telegramMessageId: 1036,
          isSample: true,
          deliveryStatus: 'delivered_tg',
        },
      ],
    },
  ];

  const auditLog: AuditLogEntry[] = [
    {
      id: crypto.randomUUID(),
      timestamp: now - 4 * min,
      source: 'whatsapp',
      jid: '5491155551234@s.whatsapp.net',
      contactName: 'Lucía Méndez',
      action: 'forwarded_to_tg',
      detail: 'Mensaje privado reenviado al chat de Telegram',
      telegramMessageId: 1042,
      isSample: true,
    },
    {
      id: crypto.randomUUID(),
      timestamp: now - 9 * min,
      source: 'telegram',
      jid: '5491155551234@s.whatsapp.net',
      contactName: 'Lucía Méndez',
      action: 'replied_to_wa',
      detail: 'Respuesta desde Telegram enviada al contacto PV',
      telegramMessageId: 1041,
      isSample: true,
    },
    {
      id: crypto.randomUUID(),
      timestamp: now - 18 * min,
      source: 'whatsapp',
      jid: '1203630491823@g.us',
      contactName: 'Grupo Proyecto Norte',
      action: 'ignored_group',
      detail: 'Filtrado automáticamente por regla Solo PV',
      isSample: true,
    },
    {
      id: crypto.randomUUID(),
      timestamp: now - 26 * min,
      source: 'whatsapp',
      jid: '5215548291034@s.whatsapp.net',
      contactName: 'Mateo Herrera',
      action: 'forwarded_to_tg',
      detail: 'Mensaje privado reenviado al chat de Telegram',
      telegramMessageId: 1039,
      isSample: true,
    },
  ];

  return {
    rules: {
      onlyPrivateMessages: true,
      ignoreStatusBroadcasts: true,
      includePhoneHeader: true,
      autoAcknowledge: false,
      autoAckMessage: 'Recibí tu mensaje, te respondo en breve.',
    },
    conversations,
    auditLog,
    telegramMap: {
      '1040': '5491155551234@s.whatsapp.net',
      '1042': '5491155551234@s.whatsapp.net',
      '1039': '5215548291034@s.whatsapp.net',
      '1034': '34612908451@s.whatsapp.net',
      '1036': '34612908451@s.whatsapp.net',
    },
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? '',
    stats: {
      totalForwardedToTg: 5,
      totalRepliesToWa: 2,
      totalIgnoredNonPv: 1,
    },
  };
}

export class BridgeStore {
  private data: PersistedBridgeData;

  private waState: WhatsAppPublicState = {
    status: 'disconnected',
    qrDataUrl: null,
    pairingCode: null,
    connectedPhone: null,
    connectedName: null,
    lastError: null,
  };

  private tgState: TelegramPublicState = {
    status: 'disconnected',
    hasToken: false,
    tokenMasked: '',
    botUsername: null,
    chatId: '',
    lastError: null,
    lastDetectedChatId: null,
  };

  constructor() {
    this.data = this.loadFromDisk();
    this.tgState.chatId = process.env.TELEGRAM_CHAT_ID?.trim() || this.data.telegramChatId || '';
  }

  private loadFromDisk(): PersistedBridgeData {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedBridgeData;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.conversations)) {
          return parsed;
        }
      }
    } catch {
      // Fallback to seed data if file is corrupted
    }
    const seeded = buildSeedData();
    this.persistToDisk(seeded);
    return seeded;
  }

  private persistToDisk(target: PersistedBridgeData = this.data): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmpPath = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(target, null, 2), 'utf-8');
      fs.renameSync(tmpPath, STATE_FILE);
    } catch (err) {
      console.error('[BridgeStore] Failed to persist state:', err);
    }
  }

  getRules(): RoutingRules {
    return { ...this.data.rules };
  }

  updateRules(partial: Partial<RoutingRules>): RoutingRules {
    this.data.rules = {
      ...this.data.rules,
      ...partial,
    };
    this.persistToDisk();
    return this.getRules();
  }

  getWhatsAppState(): WhatsAppPublicState {
    return { ...this.waState };
  }

  setWhatsAppState(next: Partial<WhatsAppPublicState>): WhatsAppPublicState {
    this.waState = { ...this.waState, ...next };
    return this.getWhatsAppState();
  }

  getTelegramState(): TelegramPublicState {
    return { ...this.tgState };
  }

  setTelegramState(next: Partial<TelegramPublicState>): TelegramPublicState {
    this.tgState = { ...this.tgState, ...next };
    if (typeof next.chatId === 'string') {
      this.data.telegramChatId = next.chatId;
      this.persistToDisk();
    }
    return this.getTelegramState();
  }

  getStats(): BridgeStats {
    return {
      ...this.data.stats,
      activeConversations: this.data.conversations.length,
    };
  }

  getPublicState(): BridgePublicState {
    return {
      whatsapp: this.getWhatsAppState(),
      telegram: this.getTelegramState(),
      rules: this.getRules(),
      conversations: [...this.data.conversations].sort((a, b) => b.lastMessageAt - a.lastMessageAt),
      auditLog: [...this.data.auditLog].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100),
      stats: this.getStats(),
    };
  }

  recordMessage(params: {
    jid: string;
    senderName: string;
    direction: MessageDirection;
    text: string;
    mediaType?: MediaKind;
    telegramMessageId?: number;
    deliveryStatus: BridgeMessage['deliveryStatus'];
    isSample?: boolean;
  }): { conversation: BridgeConversation; message: BridgeMessage; stats: BridgeStats } {
    const phoneDisplay = formatPhoneDisplay(params.jid);
    const now = Date.now();
    const message: BridgeMessage = {
      id: crypto.randomUUID(),
      jid: params.jid,
      senderName: params.senderName,
      phoneDisplay,
      direction: params.direction,
      text: params.text,
      mediaType: params.mediaType ?? 'text',
      timestamp: now,
      telegramMessageId: params.telegramMessageId,
      isSample: params.isSample,
      deliveryStatus: params.deliveryStatus,
    };

    let conv = this.data.conversations.find((c) => c.jid === params.jid);
    if (!conv) {
      conv = {
        jid: params.jid,
        name: params.direction === 'inbound_wa' ? params.senderName : phoneDisplay,
        phoneDisplay,
        lastMessageText: params.text,
        lastMessageAt: now,
        lastDirection: params.direction,
        unreadCount: params.direction === 'inbound_wa' ? 1 : 0,
        lastTelegramMessageId: params.telegramMessageId,
        isSample: params.isSample,
        messages: [message],
      };
      this.data.conversations.unshift(conv);
    } else {
      if (params.direction === 'inbound_wa' && params.senderName && params.senderName !== phoneDisplay) {
        conv.name = params.senderName;
      }
      conv.lastMessageText = params.text;
      conv.lastMessageAt = now;
      conv.lastDirection = params.direction;
      if (params.direction === 'inbound_wa') {
        conv.unreadCount += 1;
      } else {
        conv.unreadCount = 0;
      }
      if (params.telegramMessageId) {
        conv.lastTelegramMessageId = params.telegramMessageId;
      }
      if (!params.isSample) {
        conv.isSample = false;
      }
      conv.messages.push(message);
      if (conv.messages.length > 200) {
        conv.messages = conv.messages.slice(-200);
      }
    }

    if (params.telegramMessageId) {
      this.data.telegramMap[String(params.telegramMessageId)] = params.jid;
      const keys = Object.keys(this.data.telegramMap);
      if (keys.length > 1000) {
        delete this.data.telegramMap[keys[0]];
      }
    }

    if (params.direction === 'inbound_wa') {
      this.data.stats.totalForwardedToTg += 1;
    } else {
      this.data.stats.totalRepliesToWa += 1;
    }

    this.persistToDisk();
    return {
      conversation: { ...conv, messages: [...conv.messages] },
      message,
      stats: this.getStats(),
    };
  }

  appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): { entry: AuditLogEntry; stats: BridgeStats } {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    if (entry.action === 'ignored_group' || entry.action === 'ignored_broadcast') {
      this.data.stats.totalIgnoredNonPv += 1;
    }

    this.data.auditLog.unshift(fullEntry);
    if (this.data.auditLog.length > 250) {
      this.data.auditLog = this.data.auditLog.slice(0, 250);
    }

    this.persistToDisk();
    return { entry: fullEntry, stats: this.getStats() };
  }

  markConversationRead(jid: string): BridgeConversation | null {
    const conv = this.data.conversations.find((c) => c.jid === jid);
    if (!conv) return null;
    conv.unreadCount = 0;
    this.persistToDisk();
    return { ...conv, messages: [...conv.messages] };
  }

  lookupJidByTelegramMessageId(tgMessageId: number): string | null {
    return this.data.telegramMap[String(tgMessageId)] ?? null;
  }

  clearSampleData(): BridgePublicState {
    this.data.conversations = this.data.conversations.filter((c) => !c.isSample);
    this.data.auditLog = this.data.auditLog.filter((l) => !l.isSample);
    const remainingIds = new Set<string>();
    for (const c of this.data.conversations) {
      for (const m of c.messages) {
        if (m.telegramMessageId) remainingIds.add(String(m.telegramMessageId));
      }
    }
    for (const key of Object.keys(this.data.telegramMap)) {
      if (!remainingIds.has(key)) {
        delete this.data.telegramMap[key];
      }
    }
    this.data.stats = {
      totalForwardedToTg: this.data.conversations.reduce(
        (acc, c) => acc + c.messages.filter((m) => m.direction === 'inbound_wa').length,
        0,
      ),
      totalRepliesToWa: this.data.conversations.reduce(
        (acc, c) => acc + c.messages.filter((m) => m.direction !== 'inbound_wa').length,
        0,
      ),
      totalIgnoredNonPv: this.data.auditLog.filter(
        (l) => l.action === 'ignored_group' || l.action === 'ignored_broadcast',
      ).length,
    };
    this.persistToDisk();
    return this.getPublicState();
  }
}

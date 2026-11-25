export type WhatsAppConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_code_ready'
  | 'connected'
  | 'error';

export type TelegramConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type MessageDirection = 'inbound_wa' | 'outbound_tg' | 'outbound_web';

export type MediaKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction';

export interface BridgeMessage {
  id: string;
  jid: string;
  senderName: string;
  phoneDisplay: string;
  direction: MessageDirection;
  text: string;
  mediaType: MediaKind;
  timestamp: number;
  telegramMessageId?: number;
  replyToText?: string;
  isSample?: boolean;
  deliveryStatus: 'delivered_tg' | 'sent_wa' | 'simulated' | 'pending' | 'failed';
}

export interface BridgeConversation {
  jid: string;
  name: string;
  phoneDisplay: string;
  lastMessageText: string;
  lastMessageAt: number;
  lastDirection: MessageDirection;
  unreadCount: number;
  lastTelegramMessageId?: number;
  isSample?: boolean;
  messages: BridgeMessage[];
}

export interface RoutingRules {
  onlyPrivateMessages: boolean;
  ignoreStatusBroadcasts: boolean;
  includePhoneHeader: boolean;
  autoAcknowledge: boolean;
  autoAckMessage: string;
  paused: boolean;
  blockedJids: string[];
}

export interface WhatsAppMediaPayload {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  buffer: Buffer;
  mimeType?: string;
  fileName?: string;
  ptt?: boolean;
  caption?: string;
  byteLength: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  source: 'whatsapp' | 'telegram' | 'web' | 'pipeline_test';
  jid: string;
  contactName: string;
  action:
    | 'forwarded_to_tg'
    | 'replied_to_wa'
    | 'ignored_group'
    | 'ignored_broadcast'
    | 'ignored_blocked'
    | 'ignored_paused'
    | 'error';
  detail: string;
  telegramMessageId?: number;
  isSample?: boolean;
}

export interface WhatsAppPublicState {
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  lastError: string | null;
}

export interface TelegramPublicState {
  status: TelegramConnectionStatus;
  hasToken: boolean;
  tokenMasked: string;
  botUsername: string | null;
  chatId: string;
  lastError: string | null;
  lastDetectedChatId: string | null;
}

export interface BridgeStats {
  totalForwardedToTg: number;
  totalRepliesToWa: number;
  totalIgnoredNonPv: number;
  activeConversations: number;
}

export interface BridgePublicState {
  whatsapp: WhatsAppPublicState;
  telegram: TelegramPublicState;
  rules: RoutingRules;
  conversations: BridgeConversation[];
  auditLog: AuditLogEntry[];
  stats: BridgeStats;
}

export type BridgeWsEvent =
  | { type: 'state:sync'; payload: BridgePublicState }
  | { type: 'wa:status'; payload: WhatsAppPublicState }
  | { type: 'tg:status'; payload: TelegramPublicState }
  | { type: 'rules:updated'; payload: RoutingRules }
  | { type: 'message:new'; payload: { conversation: BridgeConversation; message: BridgeMessage; stats: BridgeStats } }
  | { type: 'log:new'; payload: { entry: AuditLogEntry; stats: BridgeStats } };

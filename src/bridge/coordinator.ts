import { formatPhoneDisplay, isPrivateWhatsAppJid } from './logic';
import type { BridgeStore } from './store';
import { TelegramManager } from './telegramManager';
import type { BridgePublicState, BridgeWsEvent, MediaKind, RoutingRules } from './types';
import { WhatsAppManager } from './whatsappManager';

export class BridgeCoordinator {
  public readonly store: BridgeStore;
  public readonly whatsapp: WhatsAppManager;
  public readonly telegram: TelegramManager;
  private listeners = new Set<(event: BridgeWsEvent) => void>();

  constructor(store: BridgeStore) {
    this.store = store;

    this.whatsapp = new WhatsAppManager({
      store,
      onStateChange: (waState) => {
        this.emit({ type: 'wa:status', payload: waState });
      },
      onIncomingMessage: async (payload) => {
        await this.handleIncomingWhatsApp({
          jid: payload.jid,
          senderName: payload.senderName,
          text: payload.text,
          mediaType: payload.mediaType,
          source: 'whatsapp',
        });
      },
    });

    this.telegram = new TelegramManager({
      store,
      onStateChange: (tgState) => {
        this.emit({ type: 'tg:status', payload: tgState });
      },
      onReplyReceived: async ({ jid, text, telegramMessageId }) => {
        return this.sendOutboundReply({
          jid,
          text,
          origin: 'telegram',
          telegramMessageId,
        });
      },
    });
  }

  subscribe(listener: (event: BridgeWsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: BridgeWsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore individual WebSocket send failures
      }
    }
  }

  async bootstrapFromEnv(): Promise<void> {
    const ruleOverrides: Partial<RoutingRules> = {};
    if (process.env.ONLY_PRIVATE_MESSAGES === 'true' || process.env.ONLY_PRIVATE_MESSAGES === 'false') {
      ruleOverrides.onlyPrivateMessages = process.env.ONLY_PRIVATE_MESSAGES === 'true';
    }
    if (process.env.IGNORE_STATUS_BROADCASTS === 'true' || process.env.IGNORE_STATUS_BROADCASTS === 'false') {
      ruleOverrides.ignoreStatusBroadcasts = process.env.IGNORE_STATUS_BROADCASTS === 'true';
    }
    if (Object.keys(ruleOverrides).length > 0) {
      this.updateRules(ruleOverrides);
    }

    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    const envChatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? '';
    if (envToken && envChatId) {
      const tgState = await this.telegram.connect(envToken, envChatId);
      if (tgState.status === 'connected') {
        console.log(`[Telegram] Bot conectado desde variables de entorno (@${tgState.botUsername}) -> Chat ID ${tgState.chatId}`);
      } else {
        console.log(`[Telegram] Error al conectar desde entorno: ${tgState.lastError}`);
      }
    } else {
      console.log('[Telegram] Sin configurar aún. Define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID o escribe: tg <token> <chatId>');
    }

    const pairingPhone = process.env.WA_PAIRING_PHONE?.trim() || undefined;
    const forceQrOnBoot = process.env.WA_AUTH_MODE === 'qr' && process.env.WA_AUTO_CONNECT === 'true';

    if (this.whatsapp.hasSavedSession()) {
      console.log('[WhatsApp] Sesión guardada detectada. Reconectando automáticamente...');
      await this.whatsapp.connect();
    } else if (pairingPhone) {
      console.log(`[WhatsApp] Solicitando código de vinculación (sin QR) para +${pairingPhone}...`);
      await this.whatsapp.connect({ pairingPhone });
    } else if (forceQrOnBoot) {
      console.log('[WhatsApp] Iniciando conexión automática por QR...');
      await this.whatsapp.connect();
    } else {
      console.log('[WhatsApp] Sin vincular aún. Se solicitará tu número para generar código de 8 dígitos (sin QR).');
    }
  }

  getPublicState(): BridgePublicState {
    return this.store.getPublicState();
  }

  updateRules(partial: Partial<RoutingRules>): RoutingRules {
    const updated = this.store.updateRules(partial);
    this.emit({ type: 'rules:updated', payload: updated });
    return updated;
  }

  async handleIncomingWhatsApp(params: {
    jid: string;
    senderName: string;
    text: string;
    mediaType?: MediaKind;
    source: 'whatsapp' | 'pipeline_test';
  }): Promise<{ accepted: boolean; reason?: string; forwardedToTelegram: boolean }> {
    const rules = this.store.getRules();
    const check = isPrivateWhatsAppJid(params.jid, rules);

    if (!check.allowed) {
      const action =
        check.reason === 'broadcast_ignored' ? 'ignored_broadcast' : 'ignored_group';
      const detail =
        check.reason === 'broadcast_ignored'
          ? 'Estado o difusión ignorada por regla de filtro'
          : 'Mensaje grupal (@g.us) filtrado por regla Solo PV';

      const logEvent = this.store.appendAuditLog({
        source: params.source,
        jid: params.jid,
        contactName: params.senderName || formatPhoneDisplay(params.jid),
        action,
        detail,
      });
      this.emit({ type: 'log:new', payload: logEvent });
      console.log(`[Filtro PV] Ignorado (${check.reason}): ${params.jid}`);
      return { accepted: false, reason: check.reason, forwardedToTelegram: false };
    }

    const phoneDisplay = formatPhoneDisplay(params.jid);
    const tgResult = await this.telegram.forwardPrivateMessage({
      senderName: params.senderName,
      phoneDisplay,
      text: params.text,
      includePhoneHeader: rules.includePhoneHeader,
    });

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: params.senderName,
      direction: 'inbound_wa',
      text: params.text,
      mediaType: params.mediaType ?? 'text',
      telegramMessageId: tgResult.telegramMessageId,
      deliveryStatus: tgResult.delivered ? 'delivered_tg' : 'simulated',
    });

    this.emit({ type: 'message:new', payload: recorded });

    const logEvent = this.store.appendAuditLog({
      source: params.source,
      jid: params.jid,
      contactName: params.senderName,
      action: 'forwarded_to_tg',
      detail: tgResult.delivered
        ? `Reenviado a Telegram (#${tgResult.telegramMessageId})`
        : 'Registrado en bandeja local (Telegram no conectado)',
      telegramMessageId: tgResult.telegramMessageId,
    });
    this.emit({ type: 'log:new', payload: logEvent });

    console.log(
      `[Puente WA→TG] ${params.senderName} (${phoneDisplay}): ${params.text.slice(0, 80)}${tgResult.delivered ? ` -> TG #${tgResult.telegramMessageId}` : ' (Telegram sin conectar)'}`,
    );

    if (rules.autoAcknowledge && rules.autoAckMessage.trim() && params.source === 'whatsapp') {
      await this.whatsapp.sendTextMessage(params.jid, rules.autoAckMessage.trim());
    }

    return {
      accepted: true,
      forwardedToTelegram: tgResult.delivered,
    };
  }

  async sendOutboundReply(params: {
    jid: string;
    text: string;
    origin: 'telegram' | 'web';
    telegramMessageId?: number;
  }): Promise<{ ok: boolean; detail: string; sentOverWhatsApp: boolean }> {
    const cleanText = params.text.trim();
    if (!cleanText) {
      return { ok: false, detail: 'El mensaje de respuesta está vacío.', sentOverWhatsApp: false };
    }

    const sendRes = await this.whatsapp.sendTextMessage(params.jid, cleanText);
    const direction = params.origin === 'telegram' ? 'outbound_tg' : 'outbound_web';
    const senderLabel = params.origin === 'telegram' ? 'Tú (Telegram)' : 'Tú (Consola)';

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: senderLabel,
      direction,
      text: cleanText,
      mediaType: 'text',
      telegramMessageId: params.telegramMessageId,
      deliveryStatus: sendRes.sentOverNetwork ? 'sent_wa' : 'simulated',
    });
    this.emit({ type: 'message:new', payload: recorded });

    const phoneDisplay = formatPhoneDisplay(params.jid);
    const logEvent = this.store.appendAuditLog({
      source: params.origin,
      jid: params.jid,
      contactName: recorded.conversation.name || phoneDisplay,
      action: 'replied_to_wa',
      detail: sendRes.sentOverNetwork
        ? `Respuesta enviada por WhatsApp a ${phoneDisplay}`
        : `Respuesta registrada en consola hacia ${phoneDisplay} (WhatsApp sin vincular)`,
      telegramMessageId: params.telegramMessageId,
    });
    this.emit({ type: 'log:new', payload: logEvent });
    console.log(`[Puente ${params.origin === 'telegram' ? 'TG→WA' : 'Consola→WA'}] Respuesta a ${phoneDisplay}: ${cleanText.slice(0, 80)}`);

    return {
      ok: true,
      sentOverWhatsApp: sendRes.sentOverNetwork,
      detail: sendRes.sentOverNetwork
        ? `Enviado a WhatsApp (${phoneDisplay})`
        : `Registrado hacia ${phoneDisplay} (vincula WhatsApp para envío real)`,
    };
  }

  clearSamples(): BridgePublicState {
    const state = this.store.clearSampleData();
    this.emit({ type: 'state:sync', payload: state });
    return state;
  }
}

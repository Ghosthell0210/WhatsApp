import {
  formatPhoneDisplay,
  isPrivateWhatsAppJid,
  normalizePhoneToJid,
  sanitizePairingPhoneNumber,
} from './logic';
import type { BridgeStore } from './store';
import { TelegramManager, type TelegramControlCommand } from './telegramManager';
import type {
  BridgePublicState,
  BridgeWsEvent,
  MediaKind,
  RoutingRules,
  WhatsAppMediaPayload,
} from './types';
import { WhatsAppManager } from './whatsappManager';

export class BridgeCoordinator {
  public readonly store: BridgeStore;
  public readonly whatsapp: WhatsAppManager;
  public readonly telegram: TelegramManager;
  private listeners = new Set<(event: BridgeWsEvent) => void>();
  private lastNotifiedPairingCode: string | null = null;

  constructor(store: BridgeStore) {
    this.store = store;

    this.whatsapp = new WhatsAppManager({
      store,
      onStateChange: (waState) => {
        this.emit({ type: 'wa:status', payload: waState });
        if (
          waState.status === 'pairing_code_ready' &&
          waState.pairingCode &&
          waState.pairingCode !== this.lastNotifiedPairingCode
        ) {
          this.lastNotifiedPairingCode = waState.pairingCode;
          void this.telegram.sendSystemNotice(
            `Código de vinculación WhatsApp (sin QR):\n\n${waState.pairingCode}\n\n1. Toca la notificación que te envió WhatsApp (o entra a Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono).\n2. Ingresa este código de 8 dígitos.`,
          );
        } else if (waState.status === 'connected' || waState.status === 'disconnected') {
          this.lastNotifiedPairingCode = null;
        }
      },
      onIncomingMessage: async (payload) => {
        await this.handleIncomingWhatsApp({
          jid: payload.jid,
          senderName: payload.senderName,
          text: payload.text,
          mediaType: payload.mediaType,
          media: payload.media,
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
      onPairingRequest: async (rawPhone) => {
        const cleanPhone = sanitizePairingPhoneNumber(rawPhone);
        if (!cleanPhone) {
          return 'Envía tu número con código de país (sin +). Ejemplo:\n/codigo 5491155551234';
        }
        if (this.store.getWhatsAppState().status === 'connected') {
          return 'WhatsApp ya está vinculado y activo.';
        }
        void this.whatsapp.connect({ pairingPhone: cleanPhone });
        return `Generando código de 8 dígitos para +${cleanPhone}... Te lo enviaré aquí en unos segundos.`;
      },
      onControlCommand: async (cmd) => this.handleTelegramControlCommand(cmd),
    });
  }

  private async handleTelegramControlCommand(cmd: TelegramControlCommand): Promise<string> {
    if (cmd.type === 'status') {
      const s = this.store.getPublicState();
      const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      const upSec = Math.floor(process.uptime());
      const mins = Math.floor(upSec / 60);
      const hrs = Math.floor(mins / 60);
      const uptimeText = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${upSec % 60}s`;
      const waLine =
        s.whatsapp.status === 'connected'
          ? `Conectado (${s.whatsapp.connectedPhone || 'activo'})`
          : s.whatsapp.status;

      return [
        'Estado de Puente WA-TG',
        `• WhatsApp: ${waLine}`,
        `• Reenvío: ${s.rules.paused ? 'EN PAUSA' : 'ACTIVO'}`,
        `• Solo PV: ${s.rules.onlyPrivateMessages ? 'Sí' : 'No'}`,
        `• Contactos bloqueados: ${s.rules.blockedJids.length}`,
        `• Reenviados / Respuestas: ${s.stats.totalForwardedToTg} / ${s.stats.totalRepliesToWa}`,
        `• RAM / Tiempo activo: ${rssMb} MB · ${uptimeText}`,
      ].join('\n');
    }

    if (cmd.type === 'pause') {
      this.updateRules({ paused: true });
      return 'Reenvío WA → TG PAUSADO. Los mensajes privados no llegarán a Telegram hasta que envíes /reanudar.';
    }

    if (cmd.type === 'resume') {
      this.updateRules({ paused: false });
      return 'Reenvío WA → TG REANUDADO. Volverás a recibir tus mensajes privados aquí.';
    }

    if (cmd.type === 'block') {
      if (!cmd.targetJidOrPhone) {
        return 'Indica el número o responde a un mensaje del contacto.\nEjemplo: /bloquear +5491155551234';
      }
      const jid = normalizePhoneToJid(cmd.targetJidOrPhone);
      if (!jid) {
        return 'Número o JID inválido. Ejemplo: /bloquear +5491155551234';
      }
      const current = this.store.getRules().blockedJids;
      const label = formatPhoneDisplay(jid);
      if (current.includes(jid)) {
        return `El contacto ${label} ya estaba bloqueado.`;
      }
      this.updateRules({ blockedJids: [...current, jid] });
      return `Contacto bloqueado: ${label}. Sus mensajes ya no se reenviarán a Telegram.`;
    }

    if (cmd.type === 'unblock') {
      if (!cmd.targetJidOrPhone) {
        return 'Indica el número a desbloquear. Ejemplo: /desbloquear +5491155551234';
      }
      const jid = normalizePhoneToJid(cmd.targetJidOrPhone);
      if (!jid) {
        return 'Número o JID inválido. Ejemplo: /desbloquear +5491155551234';
      }
      const current = this.store.getRules().blockedJids;
      const label = formatPhoneDisplay(jid);
      if (!current.includes(jid)) {
        return `El contacto ${label} no estaba en la lista de bloqueados.`;
      }
      this.updateRules({ blockedJids: current.filter((item) => item !== jid) });
      return `Contacto desbloqueado: ${label}.`;
    }

    if (cmd.type === 'list_blocked') {
      const blocked = this.store.getRules().blockedJids;
      if (blocked.length === 0) {
        return 'No hay contactos bloqueados actualmente.';
      }
      const lines = blocked.map((jid, idx) => `${idx + 1}. ${formatPhoneDisplay(jid)}`);
      return `Contactos bloqueados (${blocked.length}):\n${lines.join('\n')}\n\nUsa /desbloquear <numero> para quitar uno.`;
    }

    return [
      'Comandos de Puente WA-TG:',
      '/estado — Ver conexión, memoria RAM y contadores',
      '/pausar — Pausar reenvío de WhatsApp a Telegram',
      '/reanudar — Reanudar reenvío',
      '/bloquear <num> — Silenciar contacto (o responde a un mensaje con /bloquear)',
      '/desbloquear <num> — Quitar bloqueo',
      '/bloqueados — Ver lista de bloqueados',
      '/responder <num> <msg> — Enviar mensaje nuevo por WhatsApp',
      '/codigo <num> — Pedir código de vinculación sin QR',
    ].join('\n');
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
    const savedSession = !envToken ? this.telegram.loadSavedSession() : null;
    const bootToken = envToken || savedSession?.botToken || '';
    const bootChatId = envChatId || savedSession?.chatId || '';

    if (bootToken && bootChatId) {
      const tgState = await this.telegram.connect(bootToken, bootChatId);
      if (tgState.status === 'connected') {
        console.log(
          `[Telegram] ${envToken ? 'Bot conectado desde variables de entorno' : 'Sesión guardada restaurada'} (@${tgState.botUsername}) -> Chat ID ${tgState.chatId}`,
        );
      } else {
        console.log(`[Telegram] Error al conectar: ${tgState.lastError}`);
      }
    } else {
      console.log('[Telegram] Sin configurar aún. Define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID o escribe: tg <token> <chatId>');
    }

    const pairingPhone = process.env.WA_PAIRING_PHONE?.trim() || undefined;
    const forceQrOnBoot = process.env.WA_AUTH_MODE === 'qr' && process.env.WA_AUTO_CONNECT === 'true';

    if (this.whatsapp.hasSavedSession()) {
      console.log('[WhatsApp] Sesión guardada detectada. Reconectando automáticamente...');
      await this.whatsapp.connect();
      await this.whatsapp.waitUntilSettled(3500);
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
    media?: WhatsAppMediaPayload;
    source: 'whatsapp' | 'pipeline_test';
  }): Promise<{ accepted: boolean; reason?: string; forwardedToTelegram: boolean }> {
    const rules = this.store.getRules();
    const check = isPrivateWhatsAppJid(params.jid, rules);

    if (!check.allowed) {
      const action =
        check.reason === 'broadcast_ignored'
          ? 'ignored_broadcast'
          : check.reason === 'blocked_contact'
            ? 'ignored_blocked'
            : 'ignored_group';
      const detail =
        check.reason === 'broadcast_ignored'
          ? 'Estado o difusión ignorada por regla de filtro'
          : check.reason === 'blocked_contact'
            ? 'Contacto silenciado en lista de bloqueos'
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

    if (rules.paused) {
      const logEvent = this.store.appendAuditLog({
        source: params.source,
        jid: params.jid,
        contactName: params.senderName || formatPhoneDisplay(params.jid),
        action: 'ignored_paused',
        detail: 'Puente en pausa (reenvío a Telegram desactivado)',
      });
      this.emit({ type: 'log:new', payload: logEvent });
      console.log(`[Puente En Pausa] Ignorado: ${params.jid}`);
      return { accepted: false, reason: 'paused', forwardedToTelegram: false };
    }

    const phoneDisplay = formatPhoneDisplay(params.jid);
    const tgResult = await this.telegram.forwardPrivateMessage({
      senderName: params.senderName,
      phoneDisplay,
      text: params.text,
      includePhoneHeader: rules.includePhoneHeader,
      media: params.media,
    });

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: params.senderName,
      direction: 'inbound_wa',
      text: params.text,
      mediaType: params.mediaType ?? 'text',
      telegramMessageId: tgResult.telegramMessageId,
      extraTelegramMessageIds: tgResult.extraTelegramMessageIds,
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

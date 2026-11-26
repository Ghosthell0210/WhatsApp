import {
  escapeHtml,
  formatPhoneDisplay,
  getMediaBadge,
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
  WhatsAppMessageKeyRef,
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
            `<b>🔐 Código de vinculación WhatsApp (sin QR):</b>\n\n<code>${escapeHtml(waState.pairingCode)}</code>\n\n1. Toca la notificación que te envió WhatsApp (o entra a Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono).\n2. Ingresa este código de 8 dígitos.`,
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
          whatsappMessageId: payload.whatsappMessageId,
          whatsappKey: payload.whatsappKey,
          source: 'whatsapp',
        });
      },
      onIncomingReaction: async (payload) => {
        await this.handleIncomingWhatsAppReaction(payload);
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
      onMediaReplyReceived: async ({ jid, media, telegramMessageId }) => {
        return this.sendOutboundMediaReply({
          jid,
          media,
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

  private async handleIncomingWhatsAppReaction(payload: {
    jid: string;
    senderJid: string;
    targetMessageId: string;
    emoji: string;
  }): Promise<void> {
    const rules = this.store.getRules();
    if (!rules.reactionsEnabled) {
      return;
    }

    const updated = this.store.applyReaction({
      targetWhatsappMessageId: payload.targetMessageId,
      senderId: payload.senderJid,
      emoji: payload.emoji,
    });
    if (!updated) return;

    this.emit({
      type: 'message:updated',
      payload: { conversation: updated.conversation, message: updated.message },
    });

    if (updated.message.telegramMessageId) {
      const resolved = this.store.resolveContactName(updated.conversation.jid);
      const notice =
        updated.action === 'added'
          ? `reacción ${updated.emoji} puesta`
          : `reacción ${updated.emoji} retirada`;

      await this.telegram.updateMessageReactions({
        jid: updated.conversation.jid,
        telegramMessageId: updated.message.telegramMessageId,
        senderName: resolved.displayName,
        phoneDisplay: resolved.phoneDisplay,
        text: updated.message.text,
        mediaType: updated.message.mediaType,
        includePhoneHeader: rules.includePhoneHeader,
        hasProfileName: resolved.hasProfileName,
        hasCustomAlias: resolved.hasCustomAlias,
        tags: resolved.tags,
        isArchived: updated.conversation.archived,
        reactions: updated.message.reactions ?? [],
        lastReactionNotice: notice,
      });
    }
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
        '<b>📊 Estado de Puente WA-TG</b>',
        `• <b>WhatsApp:</b> ${escapeHtml(waLine)}`,
        `• <b>Reenvío:</b> ${s.rules.paused ? '⏸️ EN PAUSA' : '🟢 ACTIVO'}`,
        `• <b>Reacciones en vivo:</b> ${s.rules.reactionsEnabled ? '❤️ Activas' : '🔕 Silenciadas'}`,
        `• <b>Solo PV:</b> ${s.rules.onlyPrivateMessages ? 'Sí' : 'No'}`,
        `• <b>Contactos guardados:</b> ${s.contacts.length}`,
        `• <b>Bloqueados:</b> ${s.rules.blockedJids.length}`,
        `• <b>Reenviados / Respuestas:</b> ${s.stats.totalForwardedToTg} / ${s.stats.totalRepliesToWa}`,
        `• <b>RAM / Activo:</b> ${rssMb} MB · ${uptimeText}`,
      ].join('\n');
    }

    if (cmd.type === 'pause') {
      this.updateRules({ paused: true });
      return '⏸️ <b>Reenvío WA → TG PAUSADO.</b> No recibirás mensajes nuevos hasta enviar /reanudar.';
    }

    if (cmd.type === 'resume') {
      this.updateRules({ paused: false });
      return '▶️ <b>Reenvío WA → TG REANUDADO.</b> Volverás a recibir tus mensajes privados aquí.';
    }

    if (cmd.type === 'toggle_reactions') {
      const current = this.store.getRules().reactionsEnabled;
      const nextVal = typeof cmd.enabled === 'boolean' ? cmd.enabled : !current;
      this.updateRules({ reactionsEnabled: nextVal });
      return nextVal
        ? '❤️ <b>Reacciones activadas.</b> Las reacciones actualizarán el mensaje original en Telegram.'
        : '🔕 <b>Reacciones silenciadas</b> (<code>/reacciones off</code>). Usa <code>/reacciones on</code> para activarlas.';
    }

    if (cmd.type === 'set_alias') {
      const contact = this.store.setContactAlias(cmd.jid, cmd.alias);
      const resolved = this.store.resolveContactName(cmd.jid);
      this.emit({ type: 'contacts:updated', payload: this.store.getPublicState().contacts });
      const conv = this.store.getConversation(cmd.jid);
      if (conv) this.emit({ type: 'conversation:updated', payload: conv });
      return `✅ Alias guardado: <b>${escapeHtml(contact.customAlias || resolved.displayName)}</b> (<code>${escapeHtml(resolved.phoneDisplay)}</code>)`;
    }

    if (cmd.type === 'forget_contact') {
      const resolvedBefore = this.store.resolveContactName(cmd.jid);
      const removed = this.store.forgetContact(cmd.jid);
      this.emit({ type: 'contacts:updated', payload: this.store.getPublicState().contacts });
      const conv = this.store.getConversation(cmd.jid);
      if (conv) this.emit({ type: 'conversation:updated', payload: conv });
      return removed
        ? `🗑️ Contacto olvidado de la libreta: <b>${escapeHtml(resolvedBefore.displayName)}</b> (<code>${escapeHtml(resolvedBefore.phoneDisplay)}</code>).`
        : `ℹ️ Ese contacto no tenía alias o ficha guardada.`;
    }

    if (cmd.type === 'add_tag') {
      const existing = this.store.getPublicState().contacts.find((c) => c.jid === cmd.jid);
      const tags = cmd.tag
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      this.store.upsertContact({ jid: cmd.jid, tags });
      const resolved = this.store.resolveContactName(cmd.jid);
      this.emit({ type: 'contacts:updated', payload: this.store.getPublicState().contacts });
      return `🏷️ Etiqueta añadida a <b>${escapeHtml(resolved.displayName)}</b>: <i>${escapeHtml(tags.join(', '))}</i>${existing ? '' : ' (contacto creado)'}`;
    }

    if (cmd.type === 'import_vcf') {
      const count = this.store.importVcf(cmd.vcfText);
      this.emit({ type: 'contacts:updated', payload: this.store.getPublicState().contacts });
      return count > 0
        ? `📇 <b>¡${count} contactos importados/actualizados</b> desde el archivo VCF!`
        : '⚠️ No se encontraron números de teléfono válidos dentro del archivo VCF.';
    }

    if (cmd.type === 'toggle_archive') {
      const conv = this.store.toggleArchive(cmd.jid);
      if (!conv) return '❌ No encontré esa conversación.';
      this.emit({ type: 'conversation:updated', payload: conv });
      return conv.archived
        ? `🗄️ Conversación con <b>${escapeHtml(conv.name)}</b> archivada.`
        : `📥 Conversación con <b>${escapeHtml(conv.name)}</b> restaurada.`;
    }

    if (cmd.type === 'react_from_tg') {
      const lookup = this.store.lookupMessageByTelegramMessageId(cmd.telegramMessageId);
      if (!lookup || !lookup.message.whatsappKey) {
        return '❌ No encontré la referencia de WhatsApp de ese mensaje para reaccionar.';
      }
      const sendRes = await this.whatsapp.sendReactionMessage(
        lookup.conversation.jid,
        lookup.message.whatsappKey,
        cmd.emoji,
      );
      if (!sendRes.sentOverNetwork) {
        return `❌ No se pudo enviar la reacción a WhatsApp: ${escapeHtml(sendRes.error || 'WhatsApp sin conexión')}`;
      }
      const updated = this.store.applyReaction({
        targetTelegramMessageId: cmd.telegramMessageId,
        senderId: 'me_telegram',
        emoji: cmd.emoji,
      });
      if (updated) {
        this.emit({
          type: 'message:updated',
          payload: { conversation: updated.conversation, message: updated.message },
        });
        const resolved = this.store.resolveContactName(updated.conversation.jid);
        await this.telegram.updateMessageReactions({
          jid: updated.conversation.jid,
          telegramMessageId: cmd.telegramMessageId,
          senderName: resolved.displayName,
          phoneDisplay: resolved.phoneDisplay,
          text: updated.message.text,
          mediaType: updated.message.mediaType,
          includePhoneHeader: this.store.getRules().includePhoneHeader,
          hasProfileName: resolved.hasProfileName,
          hasCustomAlias: resolved.hasCustomAlias,
          tags: resolved.tags,
          isArchived: updated.conversation.archived,
          reactions: updated.message.reactions ?? [],
          lastReactionNotice: cmd.emoji ? `tú: ${cmd.emoji}` : 'reacción retirada',
        });
      }
      const resolved = this.store.resolveContactName(lookup.conversation.jid);
      return cmd.emoji
        ? `✨ Reacción ${escapeHtml(cmd.emoji)} enviada a <b>${escapeHtml(resolved.displayName)}</b>.`
        : `✨ Reacción retirada en <b>${escapeHtml(resolved.displayName)}</b>.`;
    }

    if (cmd.type === 'block') {
      if (!cmd.targetJidOrPhone) {
        return 'Indica el número o responde a un mensaje del contacto.\nEjemplo: <code>/bloquear +5491155551234</code>';
      }
      const jid = normalizePhoneToJid(cmd.targetJidOrPhone);
      if (!jid) {
        return 'Número o JID inválido. Ejemplo: <code>/bloquear +5491155551234</code>';
      }
      const current = this.store.getRules().blockedJids;
      const resolved = this.store.resolveContactName(jid);
      if (current.includes(jid)) {
        return `El contacto <b>${escapeHtml(resolved.displayName)}</b> ya estaba bloqueado.`;
      }
      this.updateRules({ blockedJids: [...current, jid] });
      return `🚫 Contacto bloqueado: <b>${escapeHtml(resolved.displayName)}</b> (<code>${escapeHtml(resolved.phoneDisplay)}</code>).`;
    }

    if (cmd.type === 'unblock') {
      if (!cmd.targetJidOrPhone) {
        return 'Indica el número a desbloquear. Ejemplo: <code>/desbloquear +5491155551234</code>';
      }
      const jid = normalizePhoneToJid(cmd.targetJidOrPhone);
      if (!jid) {
        return 'Número o JID inválido. Ejemplo: <code>/desbloquear +5491155551234</code>';
      }
      const current = this.store.getRules().blockedJids;
      const resolved = this.store.resolveContactName(jid);
      if (!current.includes(jid)) {
        return `El contacto <b>${escapeHtml(resolved.displayName)}</b> no estaba bloqueado.`;
      }
      this.updateRules({ blockedJids: current.filter((item) => item !== jid) });
      return `✅ Contacto desbloqueado: <b>${escapeHtml(resolved.displayName)}</b>.`;
    }

    if (cmd.type === 'list_blocked') {
      const blocked = this.store.getRules().blockedJids;
      if (blocked.length === 0) {
        return 'No hay contactos bloqueados actualmente.';
      }
      const lines = blocked.map((jid, idx) => {
        const r = this.store.resolveContactName(jid);
        return `${idx + 1}. <b>${escapeHtml(r.displayName)}</b> · <code>${escapeHtml(r.phoneDisplay)}</code>`;
      });
      return `<b>🚫 Contactos bloqueados (${blocked.length}):</b>\n${lines.join('\n')}\n\nUsa <code>/desbloquear número</code> para quitar uno.`;
    }

    return [
      '<b>🤖 Comandos de Puente WA-TG</b>',
      '',
      '<b>Contactos y Alias:</b>',
      '• <code>/nuevo Nombre</code> o <code>/n Nombre</code> — Alias manual (por reply)',
      '• <code>/renombrar Nombre</code> — Cambiar alias',
      '• <code>/olvidar</code> — Borrar contacto de la libreta',
      '• <code>/etiqueta VIP</code> — Añadir etiqueta al contacto',
      '• <code>/contactos</code> — Ver libreta y abrir chat rápido',
      '• <i>Envía un archivo .vcf para importar contactos</i>',
      '',
      '<b>Chats y Reacciones:</b>',
      '• <code>/chats</code> — Lista interactiva de conversaciones recientes',
      '• <code>/buscar texto</code> — Buscar chat o contacto por nombre',
      '• <code>/historial</code> — Ver últimos mensajes del contacto',
      '• <code>/archivar</code> — Archivar/restaurar conversación',
      '• <code>/reacciones on|off</code> — Activar o silenciar reacciones',
      '• <code>/reaccion ❤️</code> — Reaccionar en WhatsApp (o reacciona directo en TG)',
      '',
      '<b>Control del Puente:</b>',
      '• <code>/estado</code> · <code>/pausar</code> · <code>/reanudar</code>',
      '• <code>/bloquear</code> · <code>/desbloquear</code> · <code>/bloqueados</code>',
      '• <code>/responder num msg</code> · <code>/codigo num</code>',
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

    if (bootToken) {
      const tgState = await this.telegram.connect(bootToken, bootChatId);
      if (tgState.status === 'connected') {
        console.log(
          `[Telegram] ${envToken ? 'Bot conectado desde variables de entorno' : 'Sesión guardada restaurada'} (@${tgState.botUsername}) -> Chat ID ${tgState.chatId || 'pendiente de auto-autorización al enviar /start'}`,
        );
      } else {
        console.log(`[Telegram] Error al conectar: ${tgState.lastError}`);
      }
    } else {
      console.log('[Telegram] Sin configurar aún. Define TELEGRAM_BOT_TOKEN o escribe: tg <token> <chatId>');
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
    whatsappMessageId?: string;
    whatsappKey?: WhatsAppMessageKeyRef;
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

    // Always upsert contact with pushName (preserves last known name if pushName is empty)
    this.store.upsertContact({
      jid: params.jid,
      profileName: params.senderName || undefined,
    });
    const resolved = this.store.resolveContactName(params.jid);
    this.emit({ type: 'contacts:updated', payload: this.store.getPublicState().contacts });

    if (rules.paused) {
      const logEvent = this.store.appendAuditLog({
        source: params.source,
        jid: params.jid,
        contactName: resolved.displayName,
        action: 'ignored_paused',
        detail: 'Puente en pausa (reenvío a Telegram desactivado)',
      });
      this.emit({ type: 'log:new', payload: logEvent });
      console.log(`[Puente En Pausa] Ignorado: ${params.jid}`);
      return { accepted: false, reason: 'paused', forwardedToTelegram: false };
    }

    const existingConv = this.store.getConversation(params.jid);
    const tgResult = await this.telegram.forwardPrivateMessage({
      jid: params.jid,
      senderName: resolved.displayName,
      phoneDisplay: resolved.phoneDisplay,
      text: params.text,
      mediaType: params.mediaType ?? 'text',
      includePhoneHeader: rules.includePhoneHeader,
      hasProfileName: resolved.hasProfileName,
      hasCustomAlias: resolved.hasCustomAlias,
      tags: resolved.tags,
      isArchived: Boolean(existingConv?.archived),
      media: params.media,
    });

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: resolved.displayName,
      direction: 'inbound_wa',
      text: params.text,
      mediaType: params.mediaType ?? 'text',
      telegramMessageId: tgResult.telegramMessageId,
      extraTelegramMessageIds: tgResult.extraTelegramMessageIds,
      whatsappMessageId: params.whatsappMessageId,
      whatsappKey: params.whatsappKey,
      deliveryStatus: tgResult.delivered ? 'delivered_tg' : 'simulated',
    });

    this.emit({ type: 'message:new', payload: recorded });

    const logEvent = this.store.appendAuditLog({
      source: params.source,
      jid: params.jid,
      contactName: resolved.displayName,
      action: 'forwarded_to_tg',
      detail: tgResult.delivered
        ? `Reenviado a Telegram (#${tgResult.telegramMessageId})`
        : 'Registrado en bandeja local (Telegram no conectado)',
      telegramMessageId: tgResult.telegramMessageId,
    });
    this.emit({ type: 'log:new', payload: logEvent });

    console.log(
      `[Puente WA→TG] ${resolved.displayName} (${resolved.phoneDisplay}): ${params.text.slice(0, 80)}${tgResult.delivered ? ` -> TG #${tgResult.telegramMessageId}` : ' (Telegram sin conectar)'}`,
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
      return { ok: false, detail: '❌ El mensaje de respuesta está vacío.', sentOverWhatsApp: false };
    }

    const resolved = this.store.resolveContactName(params.jid);
    const contactLabel =
      resolved.displayName !== resolved.phoneDisplay
        ? `<b>${escapeHtml(resolved.displayName)}</b> (<code>${escapeHtml(resolved.phoneDisplay)}</code>)`
        : `<code>${escapeHtml(resolved.phoneDisplay)}</code>`;

    const sendRes = await this.whatsapp.sendTextMessage(params.jid, cleanText);
    if (params.origin === 'telegram' && !sendRes.sentOverNetwork) {
      const logEvent = this.store.appendAuditLog({
        source: 'telegram',
        jid: params.jid,
        contactName: resolved.displayName,
        action: 'error',
        detail: `Fallo al responder a ${resolved.displayName}: ${sendRes.error || 'WhatsApp sin conexión'}`,
        telegramMessageId: params.telegramMessageId,
      });
      this.emit({ type: 'log:new', payload: logEvent });
      return {
        ok: false,
        sentOverWhatsApp: false,
        detail: `❌ No se pudo enviar a ${contactLabel}: ${escapeHtml(sendRes.error || 'WhatsApp no conectado.')}`,
      };
    }

    const direction = params.origin === 'telegram' ? 'outbound_tg' : 'outbound_web';
    const senderLabel = params.origin === 'telegram' ? 'Tú (Telegram)' : 'Tú (Consola)';

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: senderLabel,
      direction,
      text: cleanText,
      mediaType: 'text',
      telegramMessageId: params.telegramMessageId,
      whatsappMessageId: sendRes.whatsappMessageId,
      whatsappKey: sendRes.whatsappKey,
      deliveryStatus: sendRes.sentOverNetwork ? 'sent_wa' : 'simulated',
    });
    this.emit({ type: 'message:new', payload: recorded });

    const logEvent = this.store.appendAuditLog({
      source: params.origin,
      jid: params.jid,
      contactName: resolved.displayName,
      action: 'replied_to_wa',
      detail: sendRes.sentOverNetwork
        ? `Respuesta enviada por WhatsApp a ${resolved.displayName} (${resolved.phoneDisplay})`
        : `Respuesta registrada en consola hacia ${resolved.phoneDisplay} (WhatsApp sin vincular)`,
      telegramMessageId: params.telegramMessageId,
    });
    this.emit({ type: 'log:new', payload: logEvent });
    console.log(
      `[Puente ${params.origin === 'telegram' ? 'TG→WA' : 'Consola→WA'}] Respuesta a ${resolved.displayName} (${resolved.phoneDisplay}): ${cleanText.slice(0, 80)}`,
    );

    return {
      ok: true,
      sentOverWhatsApp: sendRes.sentOverNetwork,
      detail: sendRes.sentOverNetwork
        ? `✅ Enviado a ${contactLabel}`
        : `Registrado hacia ${resolved.displayName} (vincula WhatsApp para envío real)`,
    };
  }

  async sendOutboundMediaReply(params: {
    jid: string;
    media: WhatsAppMediaPayload;
    telegramMessageId?: number;
  }): Promise<{ ok: boolean; detail: string; sentOverWhatsApp: boolean }> {
    const resolved = this.store.resolveContactName(params.jid);
    const contactLabel =
      resolved.displayName !== resolved.phoneDisplay
        ? `<b>${escapeHtml(resolved.displayName)}</b> (<code>${escapeHtml(resolved.phoneDisplay)}</code>)`
        : `<code>${escapeHtml(resolved.phoneDisplay)}</code>`;
    const badge = getMediaBadge(params.media.kind);

    const sendRes = await this.whatsapp.sendMediaMessage(params.jid, params.media);
    if (!sendRes.sentOverNetwork) {
      const logEvent = this.store.appendAuditLog({
        source: 'telegram',
        jid: params.jid,
        contactName: resolved.displayName,
        action: 'error',
        detail: `Fallo al enviar ${badge} a ${resolved.displayName}: ${sendRes.error || 'WhatsApp sin conexión'}`,
        telegramMessageId: params.telegramMessageId,
      });
      this.emit({ type: 'log:new', payload: logEvent });
      return {
        ok: false,
        sentOverWhatsApp: false,
        detail: `❌ No se pudo enviar ${badge} a ${contactLabel}: ${escapeHtml(sendRes.error || 'WhatsApp no conectado.')}`,
      };
    }

    const summaryText = params.media.caption
      ? `[${badge}] ${params.media.caption}`
      : `[${badge}]${params.media.fileName ? ` ${params.media.fileName}` : ''}`;

    const recorded = this.store.recordMessage({
      jid: params.jid,
      senderName: 'Tú (Telegram)',
      direction: 'outbound_tg',
      text: summaryText,
      mediaType: params.media.kind,
      telegramMessageId: params.telegramMessageId,
      whatsappMessageId: sendRes.whatsappMessageId,
      whatsappKey: sendRes.whatsappKey,
      deliveryStatus: 'sent_wa',
    });
    this.emit({ type: 'message:new', payload: recorded });

    const logEvent = this.store.appendAuditLog({
      source: 'telegram',
      jid: params.jid,
      contactName: resolved.displayName,
      action: 'replied_to_wa',
      detail: `${badge} enviado por WhatsApp a ${resolved.displayName} (${resolved.phoneDisplay})`,
      telegramMessageId: params.telegramMessageId,
    });
    this.emit({ type: 'log:new', payload: logEvent });
    console.log(
      `[Puente TG→WA] ${badge} enviado a ${resolved.displayName} (${resolved.phoneDisplay})`,
    );

    return {
      ok: true,
      sentOverWhatsApp: true,
      detail: `✅ ${badge} enviado a ${contactLabel}`,
    };
  }

  clearSamples(): BridgePublicState {
    const state = this.store.clearSampleData();
    this.emit({ type: 'state:sync', payload: state });
    return state;
  }
}

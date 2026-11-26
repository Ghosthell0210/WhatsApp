import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import {
  escapeHtml,
  formatByteSize,
  formatReactionsSummary,
  formatTelegramCaptionHtml,
  formatTelegramForwardText,
  formatTelegramHeader,
  formatTelegramMessageHtml,
  maskToken,
  MAX_MEDIA_BYTES,
  normalizePhoneToJid,
  parseTelegramReplyCommand,
  TELEGRAM_PHOTO_MAX_BYTES,
} from './logic';
import type { BridgeStore } from './store';
import type {
  MediaKind,
  MessageReaction,
  TelegramPublicState,
  WhatsAppMediaPayload,
} from './types';

const TG_SESSION_FILE = path.resolve(process.cwd(), 'data/tg-session.json');
const TMP_TG_MEDIA_DIR = path.resolve(process.cwd(), 'data/tmp-media');

export const TELEGRAM_BOT_COMMANDS = [
  { command: 'estado', description: 'Ver conexión, chat fijado y estado 24/7' },
  { command: 'fijar', description: 'Fijar un contacto como chat directo' },
  { command: 'desfijar', description: 'Quitar el chat fijado actual' },
  { command: 'chats', description: 'Lista de conversaciones recientes' },
  { command: 'buscar', description: 'Buscar contacto o chat por nombre' },
  { command: 'contactos', description: 'Ver libreta de contactos y alias' },
  { command: 'nuevo', description: 'Asignar alias manual (respondiendo)' },
  { command: 'n', description: 'Atajo rápido para asignar alias' },
  { command: 'renombrar', description: 'Cambiar alias de un contacto' },
  { command: 'olvidar', description: 'Borrar alias o contacto guardado' },
  { command: 'etiqueta', description: 'Añadir etiqueta a un contacto' },
  { command: 'historial', description: 'Ver últimos mensajes del contacto' },
  { command: 'archivar', description: 'Archivar o restaurar conversación' },
  { command: 'reacciones', description: 'Activar/silenciar reacciones (on/off)' },
  { command: 'reaccion', description: 'Reaccionar en WhatsApp (/reaccion ❤️)' },
  { command: 'pausar', description: 'Pausar reenvío de WhatsApp a Telegram' },
  { command: 'reanudar', description: 'Reanudar reenvío de mensajes' },
  { command: 'bloquear', description: 'Silenciar contacto' },
  { command: 'desbloquear', description: 'Quitar bloqueo de un contacto' },
  { command: 'bloqueados', description: 'Listar contactos bloqueados' },
  { command: 'responder', description: 'Enviar mensaje nuevo por WhatsApp' },
  { command: 'codigo', description: 'Pedir código de 8 dígitos para WhatsApp' },
  { command: 'ayuda', description: 'Ver todos los comandos disponibles' },
  { command: 'start', description: 'Mostrar tu Chat ID y ayuda inicial' },
];

export interface TelegramReplyPayload {
  jid: string;
  text: string;
  telegramMessageId: number;
}

export interface TelegramMediaReplyPayload {
  jid: string;
  media: WhatsAppMediaPayload;
  telegramMessageId: number;
}

export type TelegramControlCommand =
  | { type: 'status' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle_reactions'; enabled?: boolean }
  | { type: 'block'; targetJidOrPhone: string }
  | { type: 'unblock'; targetJidOrPhone: string }
  | { type: 'list_blocked' }
  | { type: 'set_alias'; jid: string; alias: string }
  | { type: 'forget_contact'; jid: string }
  | { type: 'add_tag'; jid: string; tag: string }
  | { type: 'import_vcf'; vcfText: string }
  | { type: 'toggle_archive'; jid: string }
  | { type: 'react_from_tg'; telegramMessageId: number; emoji: string }
  | { type: 'help' };

export class TelegramManager {
  private bot: Bot | null = null;
  private activeToken = '';
  private lastChatId = '';
  private activeReplyJid: string | null = null;
  private manualDisconnect = false;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private callbackJidMap = new Map<string, string>();
  private store: BridgeStore;
  private onStateChange: (state: TelegramPublicState) => void;
  private onReplyReceived: (payload: TelegramReplyPayload) => Promise<{ ok: boolean; detail: string }>;
  private onMediaReplyReceived?: (
    payload: TelegramMediaReplyPayload,
  ) => Promise<{ ok: boolean; detail: string }>;
  private onPairingRequest?: (phone: string) => Promise<string>;
  private onControlCommand?: (cmd: TelegramControlCommand) => Promise<string>;
  private chatIdDetectedListeners = new Set<(chatId: string) => void>();

  constructor(params: {
    store: BridgeStore;
    onStateChange: (state: TelegramPublicState) => void;
    onReplyReceived: (payload: TelegramReplyPayload) => Promise<{ ok: boolean; detail: string }>;
    onMediaReplyReceived?: (
      payload: TelegramMediaReplyPayload,
    ) => Promise<{ ok: boolean; detail: string }>;
    onPairingRequest?: (phone: string) => Promise<string>;
    onControlCommand?: (cmd: TelegramControlCommand) => Promise<string>;
  }) {
    this.store = params.store;
    this.onStateChange = params.onStateChange;
    this.onReplyReceived = params.onReplyReceived;
    this.onMediaReplyReceived = params.onMediaReplyReceived;
    this.onPairingRequest = params.onPairingRequest;
    this.onControlCommand = params.onControlCommand;
  }

  onChatIdDetected(listener: (chatId: string) => void): () => void {
    this.chatIdDetectedListeners.add(listener);
    return () => {
      this.chatIdDetectedListeners.delete(listener);
    };
  }

  private encodeCallback(prefix: string, jid: string): string {
    const direct = `${prefix}:${jid}`;
    if (Buffer.byteLength(direct, 'utf8') <= 60) {
      return direct;
    }
    const shortKey = crypto.createHash('sha1').update(jid).digest('hex').slice(0, 12);
    this.callbackJidMap.set(shortKey, jid);
    if (this.callbackJidMap.size > 500) {
      const firstKey = this.callbackJidMap.keys().next().value;
      if (firstKey) this.callbackJidMap.delete(firstKey);
    }
    return `${prefix}:#${shortKey}`;
  }

  private decodeCallbackJid(raw: string): string {
    if (raw.startsWith('#')) {
      return this.callbackJidMap.get(raw.slice(1)) ?? '';
    }
    return raw;
  }

  private buildMessageKeyboard(jid: string, isArchived = false): InlineKeyboard {
    return new InlineKeyboard()
      .text('📌 Fijar', this.encodeCallback('pin', jid))
      .text('↩️ Responder', this.encodeCallback('reply', jid))
      .row()
      .text('📜 Historial', this.encodeCallback('hist', jid))
      .text(isArchived ? '📥 Restaurar' : '🗄️ Archivar', this.encodeCallback('arch', jid));
  }

  private buildPinnedCardKeyboard(jid: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('📌 Desfijar', 'unpin')
      .text('📋 Cambiar chat', 'pick_chat')
      .row()
      .text('📜 Historial', this.encodeCallback('hist', jid));
  }

  private buildContactPickerPrompt(): { text: string; keyboard: InlineKeyboard } {
    const recent = this.store
      .searchConversationsAndContacts('')
      .filter((c) => !c.archived)
      .slice(0, 3);
    const kb = new InlineKeyboard();
    for (const item of recent) {
      kb.text(`📌 Fijar · ${item.displayName.slice(0, 22)}`, this.encodeCallback('pin', item.jid)).row();
    }
    kb.text('📋 Elegir contacto', 'pick_chat');
    return {
      text: [
        '💬 <b>No hay ningún chat fijado</b>',
        '',
        'Elige un contacto para chatear directo aquí, o desliza (<i>Reply</i>) cualquier mensaje recibido para responderle.',
      ].join('\n'),
      keyboard: kb,
    };
  }

  async pinContactChat(
    jid: string,
    chatIdOverride?: string,
  ): Promise<{ ok: boolean; state: TelegramPublicState; note?: string }> {
    const cleanJid = jid.trim();
    const resolved = this.store.resolveContactName(cleanJid);
    const tgState = this.store.getTelegramState();
    const targetChatId = (chatIdOverride || tgState.chatId || '').trim();
    const prevPinnedMsgId = tgState.pinnedStatusMessageId;
    const prevPinnedName = tgState.pinnedChatName;

    if (!this.bot || tgState.status !== 'connected' || !targetChatId) {
      const next = this.store.setPinnedChat(cleanJid, null);
      this.onStateChange(next);
      return { ok: true, state: next, note: 'Chat fijado guardado (Telegram desconectado)' };
    }

    if (prevPinnedMsgId) {
      await this.bot.api.unpinChatMessage(targetChatId, prevPinnedMsgId).catch(() => {});
      await this.bot.api
        .editMessageText(
          targetChatId,
          prevPinnedMsgId,
          `🔄 <i>Chat fijado cambiado de ${escapeHtml(prevPinnedName || 'anterior')} a <b>${escapeHtml(resolved.displayName)}</b>.</i>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    }

    const cardHtml = [
      '📌 <b>Chat fijado activo</b>',
      `Contacto: <b>${escapeHtml(resolved.displayName)}</b>`,
      `<code>${escapeHtml(resolved.phoneDisplay)}</code>`,
      '',
      '<i>Todo mensaje o archivo que envíes sin Reply irá directo a este contacto.</i>',
      '<i>Si te escribe alguien más, desliza su mensaje (Reply) para responderle sin afectar este chat fijado.</i>',
    ].join('\n');

    const sent = await this.bot.api.sendMessage(targetChatId, cardHtml, {
      parse_mode: 'HTML',
      reply_markup: this.buildPinnedCardKeyboard(cleanJid),
    });

    let pinWarning: string | undefined;
    try {
      await this.bot.api.pinChatMessage(targetChatId, sent.message_id, {
        disable_notification: true,
      });
    } catch {
      pinWarning = 'No pude anclar la tarjeta arriba por permisos del chat, pero el chat fijado ya está activo.';
    }

    const next = this.store.setPinnedChat(cleanJid, sent.message_id);
    this.onStateChange(next);
    return { ok: true, state: next, note: pinWarning };
  }

  async unpinContactChat(cardMessageId?: number): Promise<{
    hadPinned: boolean;
    previousName: string | null;
    state: TelegramPublicState;
  }> {
    const current = this.store.getTelegramState();
    const hadPinned = Boolean(current.pinnedChatJid);
    const previousName = current.pinnedChatName ?? null;
    const msgIdToUnpin = cardMessageId ?? current.pinnedStatusMessageId ?? undefined;
    const targetChatId = current.chatId;

    if (this.bot && current.status === 'connected' && targetChatId && msgIdToUnpin) {
      await this.bot.api.unpinChatMessage(targetChatId, msgIdToUnpin).catch(() => {});
      await this.bot.api
        .editMessageText(
          targetChatId,
          msgIdToUnpin,
          `📌 <i>Chat desfijado${previousName ? ` (${escapeHtml(previousName)})` : ''}.</i>\nUsa 📌 <b>Fijar</b> en cualquier chat o escribe /chats para elegir otro.`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    }

    const next = this.store.setPinnedChat(null, null);
    this.onStateChange(next);
    return { hadPinned, previousName, state: next };
  }

  loadSavedSession(): { botToken: string; chatId: string } | null {
    const creds = this.store.credentials.get();
    if (creds.telegramBotToken) {
      return {
        botToken: creds.telegramBotToken,
        chatId: creds.telegramChatId,
      };
    }
    try {
      if (!fs.existsSync(TG_SESSION_FILE)) return null;
      const parsed = JSON.parse(fs.readFileSync(TG_SESSION_FILE, 'utf-8')) as {
        botToken?: unknown;
        chatId?: unknown;
      };
      if (typeof parsed.botToken === 'string' && parsed.botToken.trim()) {
        return {
          botToken: parsed.botToken.trim(),
          chatId: typeof parsed.chatId === 'string' ? parsed.chatId.trim() : '',
        };
      }
    } catch {
      // Ignore corrupt session file
    }
    return null;
  }

  private saveSessionFile(botToken: string, chatId: string): void {
    if (!botToken.trim()) return;
    this.store.credentials.save({
      telegramBotToken: botToken.trim(),
      telegramChatId: chatId.trim(),
    });
    try {
      fs.mkdirSync(path.dirname(TG_SESSION_FILE), { recursive: true });
      const tmp = `${TG_SESSION_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ botToken: botToken.trim(), chatId: chatId.trim() }), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmp, TG_SESSION_FILE);
    } catch {
      // Ignore session write errors
    }
  }

  private clearSessionFile(): void {
    this.store.credentials.clearTelegramCredentials();
    try {
      if (fs.existsSync(TG_SESSION_FILE)) {
        fs.rmSync(TG_SESSION_FILE, { force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  setChatId(chatId: string): TelegramPublicState {
    const cleanChatId = chatId.trim();
    this.lastChatId = cleanChatId;
    const next = this.store.setTelegramState({ chatId: cleanChatId });
    if (this.activeToken && cleanChatId) {
      this.saveSessionFile(this.activeToken, cleanChatId);
    } else if (cleanChatId) {
      this.store.credentials.save({ telegramChatId: cleanChatId });
    }
    this.onStateChange(next);
    return next;
  }

  private resolveTargetJidFromReply(replyTo: unknown): string | null {
    if (!replyTo || typeof replyTo !== 'object') return null;
    const msgObj = replyTo as { message_id?: number; text?: string; caption?: string };
    if (typeof msgObj.message_id === 'number') {
      const mapped = this.store.lookupJidByTelegramMessageId(msgObj.message_id);
      if (mapped) return mapped;
    }
    const quotedBody =
      (typeof msgObj.text === 'string' && msgObj.text) ||
      (typeof msgObj.caption === 'string' && msgObj.caption) ||
      '';
    const phoneMatch = quotedBody.match(/(\+?\d{7,16})/);
    if (phoneMatch?.[1]) {
      return normalizePhoneToJid(phoneMatch[1]);
    }
    return null;
  }

  private async downloadTelegramFile(
    bot: Bot,
    fileId: string,
    fallbackExt: string,
  ): Promise<{ tempFilePath: string; byteLength: number }> {
    const fileInfo = await bot.api.getFile(fileId);
    if (!fileInfo.file_path) {
      throw new Error('Telegram no devolvió la ruta del archivo.');
    }
    if (fileInfo.file_size && fileInfo.file_size > MAX_MEDIA_BYTES) {
      throw new Error(`El archivo supera el límite de ${formatByteSize(MAX_MEDIA_BYTES)}.`);
    }

    const url = `https://api.telegram.org/file/bot${this.activeToken}/${fileInfo.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Error al descargar archivo desde Telegram (HTTP ${res.status}).`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      throw new Error(`El archivo supera el límite de ${formatByteSize(MAX_MEDIA_BYTES)}.`);
    }

    const extFromPath = path.extname(fileInfo.file_path).replace(/[^a-zA-Z0-9]/g, '');
    const ext = extFromPath || fallbackExt || 'bin';
    fs.mkdirSync(TMP_TG_MEDIA_DIR, { recursive: true });
    const tempFilePath = path.join(TMP_TG_MEDIA_DIR, `tg-${Date.now()}-${crypto.randomUUID()}.${ext}`);
    fs.writeFileSync(tempFilePath, buffer);
    return { tempFilePath, byteLength: buffer.byteLength };
  }

  private renderChatsPage(page = 0, query = ''): { text: string; keyboard: InlineKeyboard } {
    const all = this.store.searchConversationsAndContacts(query);
    const active = all.filter((c) => !c.archived);
    const archivedCount = all.length - active.length;
    const list = query ? all : active;

    if (list.length === 0) {
      return {
        text: query
          ? `🔍 No se encontraron chats para "<b>${escapeHtml(query)}</b>".`
          : `📭 No hay conversaciones activas.\n${archivedCount > 0 ? `Tienes ${archivedCount} archivadas.` : ''}`,
        keyboard: new InlineKeyboard(),
      };
    }

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = list.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const lines: string[] = [
      query
        ? `<b>🔍 Resultados para "${escapeHtml(query)}" (${list.length})</b>`
        : `<b>📋 Conversaciones recientes (${list.length})</b>`,
      '',
    ];

    const kb = new InlineKeyboard();
    for (const item of slice) {
      const badge = item.unreadCount > 0 ? `🔵 (${item.unreadCount}) ` : item.archived ? '🗄️ ' : '💬 ';
      const preview = item.lastMessageText.slice(0, 48).replace(/\n/g, ' ');
      lines.push(
        `${badge}<b>${escapeHtml(item.displayName)}</b> · <code>${escapeHtml(item.phoneDisplay)}</code>\n<i>${escapeHtml(preview)}</i>`,
      );
      kb.text(`📌 Fijar ${item.displayName.slice(0, 14)}`, this.encodeCallback('pin', item.jid))
        .text('↩️ Resp.', this.encodeCallback('reply', item.jid))
        .text('📜 Hist.', this.encodeCallback('hist', item.jid))
        .row();
    }

    if (totalPages > 1) {
      if (safePage > 0) kb.text('⬅️ Anterior', `chats_page:${safePage - 1}`);
      kb.text(`${safePage + 1}/${totalPages}`, 'noop');
      if (safePage < totalPages - 1) kb.text('Siguiente ➡️', `chats_page:${safePage + 1}`);
    }

    return { text: lines.join('\n\n'), keyboard: kb };
  }

  private renderContactHistory(jid: string): { text: string; keyboard: InlineKeyboard } {
    const resolved = this.store.resolveContactName(jid);
    const conv = this.store.getConversation(jid);
    const header = `<b>📜 Historial · ${escapeHtml(resolved.displayName)}</b>\n<code>${escapeHtml(resolved.phoneDisplay)}</code>`;

    if (!conv || conv.messages.length === 0) {
      return {
        text: `${header}\n\n<i>Sin mensajes registrados aún.</i>`,
        keyboard: this.buildMessageKeyboard(jid, false),
      };
    }

    const recent = conv.messages.slice(-10);
    const rows = recent.map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const who = m.direction === 'inbound_wa' ? '👤' : '📤';
      const rx = formatReactionsSummary(m.reactions);
      const rxSuffix = rx ? ` <i>[${escapeHtml(rx)}]</i>` : '';
      return `${who} <code>${time}</code> ${escapeHtml(m.text.slice(0, 140))}${rxSuffix}`;
    });

    return {
      text: `${header}\n<i>Últimos ${recent.length} mensajes${conv.archived ? ' · Archivada' : ''}:</i>\n\n${rows.join('\n')}`,
      keyboard: this.buildMessageKeyboard(jid, Boolean(conv.archived)),
    };
  }

  async connect(token: string, chatId: string): Promise<TelegramPublicState> {
    this.clearReconnectTimer();
    this.manualDisconnect = false;
    this.isConnecting = true;
    await this.disconnect(false, true);

    const trimmedToken = token.trim();
    const trimmedChatId = chatId.trim();
    this.activeToken = trimmedToken;
    this.lastChatId = trimmedChatId;

    const connectingState = this.store.setTelegramState({
      status: 'connecting',
      hasToken: Boolean(trimmedToken),
      tokenMasked: maskToken(trimmedToken),
      chatId: trimmedChatId,
      lastError: null,
    });
    this.onStateChange(connectingState);

    try {
      const bot = new Bot(trimmedToken);
      const me = await bot.api.getMe();
      this.reconnectAttempts = 0;
      void bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS).catch(() => {});

      bot.command(['start', 'id'], async (ctx) => {
        const detectedId = String(ctx.chat.id);
        if (!this.store.getTelegramState().chatId) {
          this.setChatId(detectedId);
        }
        const updated = this.store.setTelegramState({
          lastDetectedChatId: detectedId,
        });
        this.onStateChange(updated);

        for (const listener of this.chatIdDetectedListeners) {
          try {
            listener(detectedId);
          } catch {
            // Ignore listener errors
          }
        }

        const pinnedName = updated.pinnedChatName;
        await ctx.reply(
          `<b>⚡ Puente WA-TG activo</b>\n\nTu Chat ID es: <code>${escapeHtml(detectedId)}</code> (autorizado).\n${
            pinnedName ? `\n📌 <b>Chat fijado actual:</b> ${escapeHtml(pinnedName)}\n` : ''
          }\n• Pulsa <b>📌 Fijar</b> en cualquier contacto para chatear directo como un chat 1 a 1.\n• Desliza (<i>Reply</i>) cualquier mensaje recibido para responder sin perder tu chat fijado.\n• Puedes enviar texto, fotos, documentos, audios, notas de voz o videos.\n• Envía un archivo <code>.vcf</code> para importar tus contactos.\n• Usa /ayuda para ver todos los comandos.`,
          { parse_mode: 'HTML' },
        );
      });

      bot.on('callback_query:data', async (ctx) => {
        const incomingChatId = String(ctx.chat?.id ?? '');
        const currentTargetChatId = this.store.getTelegramState().chatId;
        if (currentTargetChatId && incomingChatId !== currentTargetChatId) {
          await ctx.answerCallbackQuery({ text: 'Chat no autorizado.', show_alert: true });
          return;
        }

        const data = ctx.callbackQuery.data;
        if (data === 'noop') {
          await ctx.answerCallbackQuery();
          return;
        }

        if (data === 'cancel_reply') {
          this.activeReplyJid = null;
          await ctx.answerCallbackQuery({ text: 'Modo respuesta cancelado' });
          await ctx.editMessageText('❌ <i>Modo respuesta puntual cancelado.</i>', { parse_mode: 'HTML' }).catch(() => {});
          return;
        }

        if (data === 'unpin') {
          const res = await this.unpinContactChat(ctx.callbackQuery.message?.message_id);
          await ctx.answerCallbackQuery({
            text: res.hadPinned ? `Chat desfijado (${res.previousName || ''})` : 'No había chat fijado',
          });
          return;
        }

        if (data === 'pick_chat') {
          const rendered = this.renderChatsPage(0);
          await ctx.answerCallbackQuery();
          await ctx.reply(rendered.text, {
            parse_mode: 'HTML',
            reply_markup: rendered.keyboard,
          });
          return;
        }

        if (data.startsWith('chats_page:')) {
          const page = Number(data.split(':')[1] || '0');
          const rendered = this.renderChatsPage(page);
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(rendered.text, {
            parse_mode: 'HTML',
            reply_markup: rendered.keyboard,
          }).catch(() => {});
          return;
        }

        const colonIdx = data.indexOf(':');
        if (colonIdx === -1) {
          await ctx.answerCallbackQuery();
          return;
        }
        const action = data.slice(0, colonIdx);
        const jid = this.decodeCallbackJid(data.slice(colonIdx + 1));
        if (!jid) {
          await ctx.answerCallbackQuery({ text: 'Contacto no encontrado.', show_alert: true });
          return;
        }

        const resolved = this.store.resolveContactName(jid);

        if (action === 'pin') {
          try {
            const pinned = await this.pinContactChat(jid, incomingChatId);
            await ctx.answerCallbackQuery({
              text: pinned.note
                ? `📌 Fijado: ${resolved.displayName} (${pinned.note.slice(0, 60)})`
                : `📌 Chat fijado: ${resolved.displayName}`,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Error al fijar contacto';
            await ctx.answerCallbackQuery({ text: `No se pudo fijar: ${msg.slice(0, 120)}`, show_alert: true });
          }
          return;
        }

        if (action === 'reply') {
          this.activeReplyJid = jid;
          const pinnedName = this.store.getTelegramState().pinnedChatName;
          const pinnedNote =
            pinnedName && this.store.getTelegramState().pinnedChatJid !== jid
              ? `\n<i>(Tu chat fijado con <b>${escapeHtml(pinnedName)}</b> seguirá intacto.)</i>`
              : '';
          await ctx.answerCallbackQuery({ text: `Respondiendo a ${resolved.displayName}` });
          const cancelKb = new InlineKeyboard().text('❌ Cancelar', 'cancel_reply');
          await ctx.reply(
            `↩️ <b>Respuesta puntual activa</b>\nDestinatario: <b>${escapeHtml(resolved.displayName)}</b> (<code>${escapeHtml(resolved.phoneDisplay)}</code>)${pinnedNote}\n\nEnvía tu mensaje, foto, audio, video o documento ahora.`,
            { parse_mode: 'HTML', reply_markup: cancelKb },
          );
          return;
        }

        if (action === 'hist') {
          const rendered = this.renderContactHistory(jid);
          await ctx.answerCallbackQuery();
          await ctx.reply(rendered.text, {
            parse_mode: 'HTML',
            reply_markup: rendered.keyboard,
          });
          return;
        }

        if (action === 'arch') {
          const conv = this.store.toggleArchive(jid);
          const label = conv?.archived ? '🗄️ Conversación archivada' : '📥 Conversación restaurada';
          await ctx.answerCallbackQuery({ text: label });
          const msg = ctx.callbackQuery.message;
          if (msg) {
            await ctx.api
              .editMessageReplyMarkup(incomingChatId, msg.message_id, {
                reply_markup: this.buildMessageKeyboard(jid, Boolean(conv?.archived)),
              })
              .catch(() => {});
          }
          return;
        }

        await ctx.answerCallbackQuery();
      });

      bot.on('message_reaction', async (ctx) => {
        const incomingChatId = String(ctx.chat.id);
        const currentTargetChatId = this.store.getTelegramState().chatId;
        if (currentTargetChatId && incomingChatId !== currentTargetChatId) return;
        if (!this.onControlCommand) return;

        const mr = ctx.messageReaction;
        const firstEmoji = mr.new_reaction.find((r) => r.type === 'emoji');
        const emoji = firstEmoji && 'emoji' in firstEmoji ? firstEmoji.emoji : '';

        const feedback = await this.onControlCommand({
          type: 'react_from_tg',
          telegramMessageId: mr.message_id,
          emoji,
        });

        if (feedback && feedback.startsWith('❌')) {
          await this.sendSystemNotice(feedback);
        }
      });

      bot.on('message', async (ctx) => {
        const incomingChatId = String(ctx.chat.id);
        let currentTargetChatId = this.store.getTelegramState().chatId;

        if (!currentTargetChatId) {
          currentTargetChatId = incomingChatId;
          this.setChatId(incomingChatId);
        }

        if (incomingChatId !== this.store.getTelegramState().lastDetectedChatId) {
          this.onStateChange(this.store.setTelegramState({ lastDetectedChatId: incomingChatId }));
        }

        if (currentTargetChatId && incomingChatId !== currentTargetChatId) {
          await ctx.reply('⛔ Este chat no está autorizado en Puente WA-TG.');
          return;
        }

        const msg = ctx.message;
        const text = (msg.text ?? msg.caption ?? '').trim();

        // Check VCF import if a .vcf / .vcard document is sent directly (not replying to a contact)
        if (
          msg.document &&
          !msg.reply_to_message &&
          !this.activeReplyJid &&
          /\.(vcf|vcard)$/i.test(msg.document.file_name ?? '')
        ) {
          let tempPath = '';
          try {
            const downloaded = await this.downloadTelegramFile(bot, msg.document.file_id, 'vcf');
            tempPath = downloaded.tempFilePath;
            const vcfContent = fs.readFileSync(tempPath, 'utf-8');
            if (this.onControlCommand) {
              const resText = await this.onControlCommand({ type: 'import_vcf', vcfText: vcfContent });
              await ctx.reply(resText, {
                parse_mode: 'HTML',
                reply_parameters: { message_id: msg.message_id },
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Error leyendo el archivo VCF';
            await ctx.reply(`❌ Error al importar VCF: ${escapeHtml(errMsg)}`, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
          } finally {
            if (tempPath) fs.rmSync(tempPath, { force: true });
          }
          return;
        }

        // Handle slash commands when text starts with /
        if (msg.text && text.startsWith('/')) {
          // /codigo or /vincular
          const pairMatch = text.match(/^\/(?:codigo|vincular)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (pairMatch && this.onPairingRequest) {
            const rawPhone = (pairMatch[1] ?? '').trim();
            const replyText = await this.onPairingRequest(rawPhone);
            await ctx.reply(replyText, {
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          }

          // /chats or /recientes
          const chatsMatch = text.match(/^\/(?:chats|recientes)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (chatsMatch) {
            const query = (chatsMatch[1] ?? '').trim();
            const rendered = this.renderChatsPage(0, query);
            await ctx.reply(rendered.text, {
              parse_mode: 'HTML',
              reply_markup: rendered.keyboard,
            });
            return;
          }

          // /buscar <nombre>
          const searchMatch = text.match(/^\/buscar(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (searchMatch) {
            const query = (searchMatch[1] ?? '').trim();
            if (!query) {
              await ctx.reply('🔍 Usa <code>/buscar nombre</code> o <code>/buscar número</code>.', {
                parse_mode: 'HTML',
              });
              return;
            }
            const rendered = this.renderChatsPage(0, query);
            await ctx.reply(rendered.text, {
              parse_mode: 'HTML',
              reply_markup: rendered.keyboard,
            });
            return;
          }

          // /fijar [nombre o número]
          const pinMatch = text.match(/^\/fijar(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (pinMatch) {
            const arg = (pinMatch[1] ?? '').trim();
            let targetJid = this.resolveTargetJidFromReply(msg.reply_to_message) || '';
            if (!targetJid && arg) {
              const directJid = normalizePhoneToJid(arg);
              if (directJid) {
                targetJid = directJid;
              } else {
                const found = this.store.searchConversationsAndContacts(arg)[0];
                if (found) targetJid = found.jid;
              }
            }
            if (!targetJid) {
              const rendered = this.renderChatsPage(0, arg);
              await ctx.reply(
                arg
                  ? rendered.text
                  : '📌 <b>Elige un contacto para fijar como chat directo</b> (o responde a un mensaje suyo con <code>/fijar</code>):',
                { parse_mode: 'HTML', reply_markup: rendered.keyboard },
              );
              return;
            }
            await this.pinContactChat(targetJid, incomingChatId);
            return;
          }

          // /desfijar
          if (/^\/desfijar(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
            const res = await this.unpinContactChat();
            if (!res.hadPinned) {
              await ctx.reply('ℹ️ No hay ningún chat fijado actualmente.');
            } else {
              await ctx.reply(
                `📌 Chat desfijado${res.previousName ? ` (<b>${escapeHtml(res.previousName)}</b>)` : ''}.`,
                { parse_mode: 'HTML' },
              );
            }
            return;
          }

          // /contactos
          if (/^\/contactos(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
            const state = this.store.getPublicState();
            if (state.contacts.length === 0) {
              await ctx.reply(
                '📇 Tu libreta está vacía. Envía un archivo <code>.vcf</code> aquí o usa <code>/nuevo Nombre</code> respondiendo a un mensaje.',
                { parse_mode: 'HTML' },
              );
              return;
            }
            const top = state.contacts.slice(0, 10);
            const kb = new InlineKeyboard();
            const lines = top.map((c) => {
              const resolved = this.store.resolveContactName(c.jid);
              kb.text(`📌 ${resolved.displayName.slice(0, 14)}`, this.encodeCallback('pin', c.jid))
                .text('↩️ Resp.', this.encodeCallback('reply', c.jid))
                .row();
              const tags = c.tags.length > 0 ? ` <i>[${escapeHtml(c.tags.join(', '))}]</i>` : '';
              return `• <b>${escapeHtml(resolved.displayName)}</b> · <code>${escapeHtml(c.phone)}</code>${tags}`;
            });
            await ctx.reply(
              `<b>📇 Contactos (${state.contacts.length})</b>\n\n${lines.join('\n')}`,
              { parse_mode: 'HTML', reply_markup: kb },
            );
            return;
          }

          // /historial
          const histMatch = text.match(/^\/historial(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (histMatch) {
            const arg = (histMatch[1] ?? '').trim();
            let targetJid =
              this.resolveTargetJidFromReply(msg.reply_to_message) || this.activeReplyJid || '';
            if (!targetJid && arg) {
              const directJid = normalizePhoneToJid(arg);
              if (directJid) {
                targetJid = directJid;
              } else {
                const found = this.store.searchConversationsAndContacts(arg)[0];
                if (found) targetJid = found.jid;
              }
            }
            if (!targetJid) {
              await ctx.reply(
                '📜 Responde a un mensaje con <code>/historial</code> o escribe <code>/historial nombre</code>.',
                { parse_mode: 'HTML' },
              );
              return;
            }
            const rendered = this.renderContactHistory(targetJid);
            await ctx.reply(rendered.text, {
              parse_mode: 'HTML',
              reply_markup: rendered.keyboard,
            });
            return;
          }

          // /archivar
          if (/^\/archivar(?:@[A-Za-z0-9_]+)?$/i.test(text) && this.onControlCommand) {
            const targetJid =
              this.resolveTargetJidFromReply(msg.reply_to_message) || this.activeReplyJid || '';
            if (!targetJid) {
              await ctx.reply('🗄️ Responde a un mensaje del chat que quieras archivar.', {
                parse_mode: 'HTML',
              });
              return;
            }
            const res = await this.onControlCommand({ type: 'toggle_archive', jid: targetJid });
            await ctx.reply(res, { parse_mode: 'HTML' });
            return;
          }

          // /reacciones [on|off]
          const rxToggleMatch = text.match(/^\/reacciones(?:@[A-Za-z0-9_]+)?(?:\s+(on|off|si|no))?$/i);
          if (rxToggleMatch && this.onControlCommand) {
            const arg = rxToggleMatch[1]?.toLowerCase();
            const enabled = arg === 'on' || arg === 'si' ? true : arg === 'off' || arg === 'no' ? false : undefined;
            const res = await this.onControlCommand({ type: 'toggle_reactions', enabled });
            await ctx.reply(res, { parse_mode: 'HTML' });
            return;
          }

          // /reaccion <emoji>
          const reactCmdMatch = text.match(/^\/reaccion(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
          if (reactCmdMatch && this.onControlCommand) {
            const emoji = (reactCmdMatch[1] ?? '').trim();
            const replyMsg = msg.reply_to_message;
            if (!replyMsg) {
              await ctx.reply('✨ Responde a un mensaje con <code>/reaccion ❤️</code> (o vacío para quitar).', {
                parse_mode: 'HTML',
              });
              return;
            }
            const res = await this.onControlCommand({
              type: 'react_from_tg',
              telegramMessageId: replyMsg.message_id,
              emoji,
            });
            await ctx.reply(res, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          }

          // /nuevo, /n, /renombrar, /olvidar, /etiqueta
          const aliasMatch = text.match(
            /^\/(nuevo|n|renombrar|olvidar|etiqueta|etiquetar)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i,
          );
          if (aliasMatch && this.onControlCommand) {
            const cmd = aliasMatch[1].toLowerCase();
            const arg = (aliasMatch[2] ?? '').trim();
            let targetJid = this.resolveTargetJidFromReply(msg.reply_to_message) || this.activeReplyJid || '';

            if (cmd === 'olvidar') {
              if (!targetJid && arg) {
                targetJid = normalizePhoneToJid(arg) ?? '';
              }
              if (!targetJid) {
                await ctx.reply('🗑️ Responde a un mensaje con <code>/olvidar</code> o indica el número.', {
                  parse_mode: 'HTML',
                });
                return;
              }
              const res = await this.onControlCommand({ type: 'forget_contact', jid: targetJid });
              await ctx.reply(res, {
                parse_mode: 'HTML',
                reply_parameters: { message_id: msg.message_id },
              });
              return;
            }

            if (cmd === 'etiqueta' || cmd === 'etiquetar') {
              if (!targetJid || !arg) {
                await ctx.reply('🏷️ Responde a un mensaje con <code>/etiqueta VIP</code>.', {
                  parse_mode: 'HTML',
                });
                return;
              }
              const res = await this.onControlCommand({ type: 'add_tag', jid: targetJid, tag: arg });
              await ctx.reply(res, {
                parse_mode: 'HTML',
                reply_parameters: { message_id: msg.message_id },
              });
              return;
            }

            // /nuevo, /n, /renombrar
            let alias = arg;
            if (!targetJid && arg) {
              const parts = arg.split(/\s+/);
              const maybeJid = parts[0] ? normalizePhoneToJid(parts[0]) : null;
              if (maybeJid && parts.length > 1) {
                targetJid = maybeJid;
                alias = parts.slice(1).join(' ').trim();
              }
            }
            if (!targetJid || !alias) {
              await ctx.reply(
                `✏️ Responde a un mensaje con <code>/${cmd} Nombre</code> (o <code>/${cmd} +numero Nombre</code>).`,
                { parse_mode: 'HTML' },
              );
              return;
            }
            const res = await this.onControlCommand({ type: 'set_alias', jid: targetJid, alias });
            await ctx.reply(res, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          }

          // Bridge administration commands
          if (this.onControlCommand) {
            const controlMatch = text.match(
              /^\/(estado|status|pausar|pause|reanudar|resume|bloquear|desbloquear|bloqueados|ayuda|help)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i,
            );
            if (controlMatch) {
              const cmdName = controlMatch[1].toLowerCase();
              const arg = (controlMatch[2] ?? '').trim();
              let ctrlRes: string | null = null;

              if (cmdName === 'estado' || cmdName === 'status') {
                ctrlRes = await this.onControlCommand({ type: 'status' });
              } else if (cmdName === 'pausar' || cmdName === 'pause') {
                ctrlRes = await this.onControlCommand({ type: 'pause' });
              } else if (cmdName === 'reanudar' || cmdName === 'resume') {
                ctrlRes = await this.onControlCommand({ type: 'resume' });
              } else if (cmdName === 'bloqueados') {
                ctrlRes = await this.onControlCommand({ type: 'list_blocked' });
              } else if (cmdName === 'ayuda' || cmdName === 'help') {
                ctrlRes = await this.onControlCommand({ type: 'help' });
              } else if (cmdName === 'bloquear') {
                const target = arg || this.resolveTargetJidFromReply(msg.reply_to_message) || '';
                ctrlRes = await this.onControlCommand({ type: 'block', targetJidOrPhone: target });
              } else if (cmdName === 'desbloquear') {
                ctrlRes = await this.onControlCommand({ type: 'unblock', targetJidOrPhone: arg });
              }

              if (ctrlRes !== null) {
                await ctx.reply(ctrlRes, {
                  parse_mode: 'HTML',
                  reply_parameters: { message_id: msg.message_id },
                });
                return;
              }
            }
          }

          // /reply or /responder <target> <message>
          const cmd = parseTelegramReplyCommand(text);
          if (cmd) {
            const jid = normalizePhoneToJid(cmd.target);
            if (!jid) {
              await ctx.reply('❌ Número o JID inválido. Ejemplo: <code>/responder +5491155551234 Hola!</code>', {
                parse_mode: 'HTML',
              });
              return;
            }
            const result = await this.onReplyReceived({
              jid,
              text: cmd.message,
              telegramMessageId: msg.message_id,
            });
            await ctx.reply(result.detail, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          }
        }

        // Resolve target JID with strict non-destructive precedence:
        // 1. Native Reply-to-Message (targets ONLY that contact without disturbing pinnedChatJid)
        // 2. One-shot inline "↩️ Responder" mode (clears activeReplyJid without disturbing pinnedChatJid)
        // 3. Persistent pinned contact (pinnedChatJid)
        // 4. Otherwise prompt user to pick/pin a contact (never fail silently)
        const replyTo = msg.reply_to_message;
        const pinnedChatJid = this.store.getTelegramState().pinnedChatJid || null;
        let targetJid = replyTo ? this.resolveTargetJidFromReply(replyTo) : null;
        let usedActiveReply = false;

        if (!replyTo && this.activeReplyJid) {
          targetJid = this.activeReplyJid;
          usedActiveReply = true;
        } else if (!replyTo && !targetJid && pinnedChatJid) {
          targetJid = pinnedChatJid;
        }

        if (!targetJid) {
          if (replyTo) {
            await ctx.reply(
              '❌ No pude identificar el contacto de WhatsApp para ese mensaje. Responde a un mensaje reenviado por el puente o usa /chats.',
              { reply_parameters: { message_id: msg.message_id } },
            );
          } else {
            const prompt = this.buildContactPickerPrompt();
            await ctx.reply(prompt.text, {
              parse_mode: 'HTML',
              reply_markup: prompt.keyboard,
              reply_parameters: { message_id: msg.message_id },
            });
          }
          return;
        }

        // Check for media attachments first (photo, document, audio, voice, video)
        const hasMedia = Boolean(
          (msg.photo && msg.photo.length > 0) ||
            msg.document ||
            msg.audio ||
            msg.voice ||
            msg.video,
        );

        if (hasMedia) {
          if (!this.onMediaReplyReceived) {
            await ctx.reply('❌ El envío de archivos multimedia no está inicializado.', {
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          }

          let tempFilePath = '';
          try {
            let kind: WhatsAppMediaPayload['kind'] = 'document';
            let fileId = '';
            let mimeType: string | undefined;
            let fileName: string | undefined;
            let ptt = false;
            let fallbackExt = 'bin';

            if (msg.photo && msg.photo.length > 0) {
              const largest = msg.photo[msg.photo.length - 1];
              kind = 'image';
              fileId = largest.file_id;
              mimeType = 'image/jpeg';
              fallbackExt = 'jpg';
            } else if (msg.video) {
              kind = 'video';
              fileId = msg.video.file_id;
              mimeType = msg.video.mime_type || 'video/mp4';
              fileName = msg.video.file_name;
              fallbackExt = 'mp4';
            } else if (msg.voice) {
              kind = 'audio';
              fileId = msg.voice.file_id;
              mimeType = msg.voice.mime_type || 'audio/ogg; codecs=opus';
              ptt = true;
              fallbackExt = 'ogg';
            } else if (msg.audio) {
              kind = 'audio';
              fileId = msg.audio.file_id;
              mimeType = msg.audio.mime_type || 'audio/mpeg';
              fileName = msg.audio.file_name;
              ptt = false;
              fallbackExt = 'mp3';
            } else if (msg.document) {
              kind = 'document';
              fileId = msg.document.file_id;
              mimeType = msg.document.mime_type || 'application/octet-stream';
              fileName = msg.document.file_name || 'archivo';
              fallbackExt = path.extname(fileName).replace('.', '') || 'bin';
            }

            const downloaded = await this.downloadTelegramFile(bot, fileId, fallbackExt);
            tempFilePath = downloaded.tempFilePath;

            const result = await this.onMediaReplyReceived({
              jid: targetJid,
              telegramMessageId: msg.message_id,
              media: {
                kind,
                tempFilePath,
                mimeType,
                fileName,
                ptt,
                caption: msg.caption?.trim() || undefined,
                byteLength: downloaded.byteLength,
              },
            });

            if (usedActiveReply && result.ok) {
              this.activeReplyJid = null;
            }
            await ctx.reply(result.detail, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Error al procesar archivo adjunto';
            await ctx.reply(`❌ No se pudo enviar el archivo a WhatsApp: ${escapeHtml(errMsg)}`, {
              parse_mode: 'HTML',
              reply_parameters: { message_id: msg.message_id },
            });
          } finally {
            if (tempFilePath) {
              fs.rmSync(tempFilePath, { force: true });
            }
          }
          return;
        }

        // Text reply
        if (text) {
          const result = await this.onReplyReceived({
            jid: targetJid,
            text,
            telegramMessageId: msg.message_id,
          });
          if (usedActiveReply && result.ok) {
            this.activeReplyJid = null;
          }
          await ctx.reply(result.detail, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: msg.message_id },
          });
          return;
        }

        // Never fail silently for unsupported reply types (e.g. location/sticker from TG)
        await ctx.reply(
          '⚠️ Tipo de adjunto no soportado para envío a WhatsApp. Envía texto, foto, documento, audio, nota de voz o video.',
          { reply_parameters: { message_id: msg.message_id } },
        );
      });

      bot.catch((err) => {
        console.error('[TelegramManager] Bot polling error:', err.error);
      });

      this.bot = bot;
      this.activeToken = trimmedToken;
      this.isConnecting = false;

      void bot
        .start({
          drop_pending_updates: true,
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : 'Error en polling de Telegram';
          const next = this.store.setTelegramState({
            status: 'error',
            lastError: message,
          });
          this.onStateChange(next);
          if (!this.manualDisconnect && this.activeToken) {
            this.scheduleReconnect(this.activeToken, this.lastChatId);
          }
        });

      const connectedState = this.store.setTelegramState({
        status: 'connected',
        hasToken: true,
        tokenMasked: maskToken(trimmedToken),
        botUsername: me.username ?? me.first_name,
        chatId: trimmedChatId,
        lastError: null,
      });
      this.saveSessionFile(trimmedToken, trimmedChatId);
      this.onStateChange(connectedState);
      return connectedState;
    } catch (err) {
      this.bot = null;
      this.isConnecting = false;
      const errMsg = err instanceof Error ? err.message : 'No se pudo conectar con Telegram Bot API';
      const failedState = this.store.setTelegramState({
        status: 'error',
        botUsername: null,
        lastError: errMsg,
      });
      this.onStateChange(failedState);
      if (!this.manualDisconnect && trimmedToken) {
        this.scheduleReconnect(trimmedToken, trimmedChatId);
      }
      return failedState;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(token: string, chatId: string): void {
    if (this.manualDisconnect || !token.trim() || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(30_000, 5_000 * Math.pow(2, Math.min(3, this.reconnectAttempts - 1)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect && token.trim()) {
        void this.connect(token, chatId);
      }
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  async ensureAwake(): Promise<boolean> {
    if (this.manualDisconnect || this.isConnecting || this.reconnectTimer) {
      return false;
    }
    const saved = this.loadSavedSession();
    const token = this.activeToken || saved?.botToken || '';
    const chatId = this.lastChatId || this.store.getTelegramState().chatId || saved?.chatId || '';
    if (!token) return false;

    const status = this.store.getTelegramState().status;
    if (!this.bot || status !== 'connected') {
      console.log('[Keep-Alive] Bot de Telegram desconectado detectado. Reconectando...');
      await this.connect(token, chatId);
      return false;
    }

    try {
      await Promise.race([
        this.bot.api.getMe(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram getMe timeout')), 8000)),
      ]);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Timeout de Telegram';
      console.log(`[Keep-Alive] Telegram no respondió al latido (${msg}). Reiniciando bot...`);
      await this.connect(token, chatId);
      return false;
    }
  }

  async forwardPrivateMessage(params: {
    jid: string;
    senderName: string;
    phoneDisplay: string;
    text: string;
    mediaType: MediaKind;
    includePhoneHeader: boolean;
    hasProfileName?: boolean;
    hasCustomAlias?: boolean;
    tags?: string[];
    isArchived?: boolean;
    media?: WhatsAppMediaPayload;
  }): Promise<{
    delivered: boolean;
    telegramMessageId?: number;
    extraTelegramMessageIds?: number[];
    error?: string;
  }> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return { delivered: false, error: 'Telegram no conectado' };
    }

    const keyboard = this.buildMessageKeyboard(params.jid, Boolean(params.isArchived));

    if (params.media) {
      try {
        const media = params.media;
        const caption = formatTelegramCaptionHtml({
          senderName: params.senderName,
          phoneDisplay: params.phoneDisplay,
          caption: media.caption,
          mediaType: media.kind,
          includePhoneHeader: params.includePhoneHeader,
          hasProfileName: params.hasProfileName,
          hasCustomAlias: params.hasCustomAlias,
        });
        const ext = media.mimeType?.split('/')[1]?.split(';')[0] || 'bin';
        const defaultName =
          media.fileName ||
          (media.kind === 'image'
            ? `imagen.${ext}`
            : media.kind === 'audio'
              ? media.ptt
                ? 'nota_de_voz.ogg'
                : `audio.${ext}`
              : media.kind === 'video'
                ? `video.${ext}`
                : media.kind === 'sticker'
                  ? 'sticker.webp'
                  : `archivo.${ext}`);
        const inputFile = new InputFile(media.tempFilePath, defaultName);

        if (media.kind === 'image') {
          const sent =
            media.byteLength > TELEGRAM_PHOTO_MAX_BYTES
              ? await this.bot.api.sendDocument(state.chatId, inputFile, {
                  caption,
                  parse_mode: 'HTML',
                  reply_markup: keyboard,
                })
              : await this.bot.api.sendPhoto(state.chatId, inputFile, {
                  caption,
                  parse_mode: 'HTML',
                  reply_markup: keyboard,
                });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'audio') {
          const sent = media.ptt
            ? await this.bot.api.sendVoice(state.chatId, inputFile, {
                caption,
                parse_mode: 'HTML',
                reply_markup: keyboard,
              })
            : await this.bot.api.sendAudio(state.chatId, inputFile, {
                caption,
                parse_mode: 'HTML',
                reply_markup: keyboard,
              });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'video') {
          const sent = await this.bot.api.sendVideo(state.chatId, inputFile, {
            caption,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'sticker') {
          const stickerMsg = await this.bot.api.sendSticker(state.chatId, inputFile);
          const html = formatTelegramMessageHtml({
            senderName: params.senderName,
            phoneDisplay: params.phoneDisplay,
            text: '[Sticker recibido]',
            mediaType: 'sticker',
            includePhoneHeader: params.includePhoneHeader,
            hasProfileName: params.hasProfileName,
            hasCustomAlias: params.hasCustomAlias,
            tags: params.tags,
          });
          const headerMsg = await this.bot.api.sendMessage(state.chatId, html, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: stickerMsg.message_id },
            reply_markup: keyboard,
          });
          return {
            delivered: true,
            telegramMessageId: headerMsg.message_id,
            extraTelegramMessageIds: [stickerMsg.message_id],
          };
        }

        const sent = await this.bot.api.sendDocument(state.chatId, inputFile, {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return { delivered: true, telegramMessageId: sent.message_id };
      } catch {
        // Fallback to HTML text forwarding if Telegram rejects specific media encoding
      }
    }

    try {
      const html = formatTelegramMessageHtml({
        senderName: params.senderName,
        phoneDisplay: params.phoneDisplay,
        text: params.text,
        mediaType: params.mediaType,
        includePhoneHeader: params.includePhoneHeader,
        hasProfileName: params.hasProfileName,
        hasCustomAlias: params.hasCustomAlias,
        tags: params.tags,
      });
      const sent = await this.bot.api.sendMessage(state.chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return { delivered: true, telegramMessageId: sent.message_id };
    } catch (err) {
      // Plain text fallback if HTML fails
      try {
        const formatted = formatTelegramForwardText(params);
        const sent = await this.bot.api.sendMessage(state.chatId, formatted, {
          reply_markup: keyboard,
        });
        return { delivered: true, telegramMessageId: sent.message_id };
      } catch (err2) {
        const error =
          err2 instanceof Error
            ? err2.message
            : err instanceof Error
              ? err.message
              : 'Error al enviar a Telegram';
        return { delivered: false, error };
      }
    }
  }

  async updateMessageReactions(params: {
    jid: string;
    telegramMessageId: number;
    senderName: string;
    phoneDisplay: string;
    text: string;
    mediaType: MediaKind;
    includePhoneHeader: boolean;
    hasProfileName?: boolean;
    hasCustomAlias?: boolean;
    tags?: string[];
    isArchived?: boolean;
    reactions: MessageReaction[];
    lastReactionNotice?: string;
  }): Promise<boolean> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return false;
    }

    const keyboard = this.buildMessageKeyboard(params.jid, Boolean(params.isArchived));
    const isMedia =
      params.mediaType === 'image' ||
      params.mediaType === 'video' ||
      params.mediaType === 'audio' ||
      params.mediaType === 'document';

    try {
      if (isMedia) {
        const caption = formatTelegramCaptionHtml({
          senderName: params.senderName,
          phoneDisplay: params.phoneDisplay,
          caption: params.text,
          mediaType: params.mediaType,
          includePhoneHeader: params.includePhoneHeader,
          hasProfileName: params.hasProfileName,
          hasCustomAlias: params.hasCustomAlias,
          reactions: params.reactions,
          lastReactionNotice: params.lastReactionNotice,
        });
        await this.bot.api.editMessageCaption(state.chatId, params.telegramMessageId, {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } else {
        const html = formatTelegramMessageHtml({
          senderName: params.senderName,
          phoneDisplay: params.phoneDisplay,
          text: params.text,
          mediaType: params.mediaType,
          includePhoneHeader: params.includePhoneHeader,
          hasProfileName: params.hasProfileName,
          hasCustomAlias: params.hasCustomAlias,
          tags: params.tags,
          reactions: params.reactions,
          lastReactionNotice: params.lastReactionNotice,
        });
        await this.bot.api.editMessageText(state.chatId, params.telegramMessageId, html, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async sendTestNotification(): Promise<{ ok: boolean; error?: string; telegramMessageId?: number }> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return { ok: false, error: 'Conecta primero el Bot Token y el Chat ID de Telegram.' };
    }

    try {
      const sent = await this.bot.api.sendMessage(
        state.chatId,
        '<b>✅ Prueba de conexión exitosa</b> desde Puente WA-TG. Los mensajes privados de WhatsApp llegarán aquí.',
        { parse_mode: 'HTML' },
      );
      return { ok: true, telegramMessageId: sent.message_id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Error al enviar mensaje de prueba',
      };
    }
  }

  async sendSystemNotice(text: string): Promise<boolean> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return false;
    }
    try {
      await this.bot.api.sendMessage(state.chatId, text, { parse_mode: 'HTML' });
      return true;
    } catch {
      try {
        await this.bot.api.sendMessage(state.chatId, text);
        return true;
      } catch {
        return false;
      }
    }
  }

  async disconnect(clearToken = true, internalReconnect = false): Promise<TelegramPublicState> {
    if (!internalReconnect) {
      this.manualDisconnect = clearToken;
      this.clearReconnectTimer();
    }
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch {
        // Ignore stop errors
      }
      this.bot = null;
    }
    if (clearToken) {
      this.activeToken = '';
      this.lastChatId = '';
      this.clearSessionFile();
    }

    const next = this.store.setTelegramState({
      status: 'disconnected',
      ...(clearToken ? { hasToken: false, tokenMasked: '', botUsername: null } : {}),
      lastError: null,
    });
    this.onStateChange(next);
    return next;
  }

  isActive(): boolean {
    return Boolean(this.bot && this.activeToken && this.store.getTelegramState().status === 'connected');
  }
}

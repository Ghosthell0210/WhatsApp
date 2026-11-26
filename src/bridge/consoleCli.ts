import QRCode from 'qrcode';
import {
  formatPhoneDisplay,
  maskToken,
  normalizePhoneToJid,
  parseAuthorizedChatIds,
  sanitizePairingPhoneNumber,
  validateBotTokenFormat,
  validateChatIdFormat,
  validateTelegramConfigInput,
} from './logic';
import type { BridgePublicState, RoutingRules, TelegramPublicState } from './types';

export type ConsoleWizardStep =
  | 'idle'
  | 'awaiting_token'
  | 'awaiting_chat_id'
  | 'awaiting_detected_chat_id'
  | 'awaiting_pv_only'
  | 'awaiting_wa_phone';

export type ParsedConsoleCommand =
  | { type: 'empty' }
  | { type: 'help' }
  | { type: 'setup' }
  | { type: 'status' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'block'; target: string }
  | { type: 'unblock'; target: string }
  | { type: 'list_blocked' }
  | { type: 'wa_connect' }
  | { type: 'wa_pair_prompt' }
  | { type: 'wa_pair_code'; phone: string }
  | { type: 'wa_disconnect'; logout: boolean }
  | { type: 'tg_connect'; token: string; chatId: string }
  | { type: 'tg_set_chat_id'; chatId: string }
  | { type: 'tg_add_chat_id'; chatId: string }
  | { type: 'tg_disconnect' }
  | { type: 'tg_test' }
  | { type: 'set_pv_only'; value: boolean }
  | { type: 'set_ignore_broadcasts'; value: boolean }
  | { type: 'reply'; target: string; message: string }
  | { type: 'unknown'; raw: string };

export interface ConsoleBridgeAdapter {
  getPublicState: () => BridgePublicState;
  connectTelegram: (token: string, chatId: string) => Promise<TelegramPublicState>;
  disconnectTelegram: () => Promise<TelegramPublicState>;
  testTelegram: () => Promise<{ ok: boolean; error?: string }>;
  setTelegramChatId: (chatId: string) => void;
  onTelegramChatIdDetected: (listener: (chatId: string) => void) => () => void;
  connectWhatsApp: (options?: { pairingPhone?: string }) => Promise<unknown>;
  disconnectWhatsApp: (logout: boolean) => Promise<unknown>;
  hasSavedWhatsAppSession?: () => boolean;
  updateRules: (partial: Partial<RoutingRules>) => RoutingRules;
  sendOutboundReply: (params: {
    jid: string;
    text: string;
    origin: 'web';
  }) => Promise<{ ok: boolean; detail: string }>;
}

export function parseYesNoInput(input: string, defaultValue: boolean): boolean | null {
  const norm = input.trim().toLowerCase();
  if (!norm) return defaultValue;
  if (norm === 's' || norm === 'si' || norm === 'sí' || norm === 'y' || norm === 'yes' || norm === '1') {
    return true;
  }
  if (norm === 'n' || norm === 'no' || norm === '0') {
    return false;
  }
  return null;
}

export function parseConsoleCommand(line: string): ParsedConsoleCommand {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'empty' };

  const parts = trimmed.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const arg1 = (parts[1] ?? '').toLowerCase();

  if (cmd === 'help' || cmd === 'ayuda' || cmd === '?') {
    return { type: 'help' };
  }
  if (cmd === 'setup' || cmd === 'configurar' || cmd === 'wizard') {
    return { type: 'setup' };
  }
  if (cmd === 'status' || cmd === 'estado') {
    return { type: 'status' };
  }
  if (cmd === 'pausar' || cmd === 'pause') {
    return { type: 'pause' };
  }
  if (cmd === 'reanudar' || cmd === 'resume') {
    return { type: 'resume' };
  }
  if (cmd === 'bloqueados' || cmd === 'blocked') {
    return { type: 'list_blocked' };
  }
  if ((cmd === 'bloquear' || cmd === 'block') && parts.length >= 2) {
    return { type: 'block', target: parts.slice(1).join('') };
  }
  if ((cmd === 'desbloquear' || cmd === 'unblock') && parts.length >= 2) {
    return { type: 'unblock', target: parts.slice(1).join('') };
  }
  if (cmd === 'qr') {
    return { type: 'wa_connect' };
  }

  if (cmd === 'codigo' || cmd === 'código' || cmd === 'code' || cmd === 'vincular') {
    const phone = parts.slice(1).join('');
    if (phone) {
      return { type: 'wa_pair_code', phone };
    }
    return { type: 'wa_pair_prompt' };
  }

  if (cmd === 'wa') {
    if (arg1 === 'connect' || arg1 === 'conectar') {
      return { type: 'wa_pair_prompt' };
    }
    if (arg1 === 'qr') {
      return { type: 'wa_connect' };
    }
    if ((arg1 === 'codigo' || arg1 === 'code') && parts[2]) {
      return { type: 'wa_pair_code', phone: parts.slice(2).join('') };
    }
    if (arg1 === 'logout' || arg1 === 'cerrar') {
      return { type: 'wa_disconnect', logout: true };
    }
    if (arg1 === 'disconnect' || arg1 === 'pausar') {
      return { type: 'wa_disconnect', logout: false };
    }
  }

  if (cmd === 'tg') {
    if (arg1 === 'disconnect' || arg1 === 'desconectar') {
      return { type: 'tg_disconnect' };
    }
    if (arg1 === 'test' || arg1 === 'prueba') {
      return { type: 'tg_test' };
    }
    if ((arg1 === 'chatid' || arg1 === 'chat' || arg1 === 'autorizar') && parts.length >= 3) {
      return { type: 'tg_set_chat_id', chatId: parts.slice(2).join(',') };
    }
    if ((arg1 === 'addchat' || arg1 === 'agregar') && parts.length >= 3) {
      return { type: 'tg_add_chat_id', chatId: parts.slice(2).join(',') };
    }
    if (parts.length >= 3) {
      return {
        type: 'tg_connect',
        token: parts[1] ?? '',
        chatId: parts[2] ?? '',
      };
    }
  }

  if (cmd === 'pv' && (arg1 === 'on' || arg1 === 'off')) {
    return { type: 'set_pv_only', value: arg1 === 'on' };
  }

  if ((cmd === 'estados' || cmd === 'broadcast') && (arg1 === 'on' || arg1 === 'off')) {
    return { type: 'set_ignore_broadcasts', value: arg1 === 'on' };
  }

  if (cmd === 'responder' || cmd === 'reply') {
    const match = trimmed.match(/^(?:responder|reply)\s+(\S+)\s+([\s\S]+)$/i);
    if (match?.[1] && match[2]) {
      return {
        type: 'reply',
        target: match[1].trim(),
        message: match[2].trim(),
      };
    }
  }

  return { type: 'unknown', raw: trimmed };
}

export async function renderQrToTerminal(qrRaw: string): Promise<string> {
  return QRCode.toString(qrRaw, { type: 'terminal', small: true });
}

export function formatConsoleHelp(): string {
  return [
    'Comandos disponibles en consola:',
    '  setup                 Asistente paso a paso para pedir credenciales',
    '  codigo <numero>       Genera código de 8 dígitos para vincular WhatsApp SIN QR',
    '  qr                    Inicia WhatsApp y muestra el código QR en consola',
    '  status                Muestra el estado de WhatsApp, Telegram y reglas',
    '  pausar | reanudar     Pausa o reanuda el reenvío de WhatsApp a Telegram',
    '  bloquear <numero>     Silencia un contacto para no reenviarlo a Telegram',
    '  desbloquear <numero>  Quita un contacto de la lista de bloqueados',
    '  bloqueados            Lista los contactos bloqueados actualmente',
    '  wa logout             Cierra la sesión actual de WhatsApp para cambiar número',
    '  tg <token> <chatId>   Conecta el Bot de Telegram en un solo comando',
    '  tg chatid <chatId>    Cambia y guarda el Chat ID autorizado en credenciales.json',
    '  tg addchat <chatId>   Añade otro Chat ID autorizado sin quitar el actual',
    '  tg test               Envía un mensaje de prueba al chat de Telegram',
    '  tg disconnect         Desconecta el bot de Telegram',
    '  pv on | pv off        Activa o desactiva el filtro Solo mensajes privados',
    '  estados on | off      Ignorar o permitir estados (status@broadcast)',
    '  responder <num> <msg> Envía una respuesta manual a un número por WhatsApp',
    '  help                  Muestra esta ayuda',
  ].join('\n');
}

export class ConsoleSessionController {
  private adapter: ConsoleBridgeAdapter;
  private log: (msg: string) => void;
  private step: ConsoleWizardStep = 'idle';
  private pendingToken = '';
  private unsubDetect: (() => void) | null = null;

  constructor(adapter: ConsoleBridgeAdapter, log: (msg: string) => void = console.log) {
    this.adapter = adapter;
    this.log = log;
  }

  getStep(): ConsoleWizardStep {
    return this.step;
  }

  startInitialWizardIfNeeded(): boolean {
    const state = this.adapter.getPublicState();
    const hasTelegram =
      (state.telegram.status === 'connected' && state.telegram.hasToken) ||
      Boolean(state.credentials?.hasTelegramToken) ||
      Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());

    if (!hasTelegram) {
      this.startWizard();
      return true;
    }

    const hasWaConfigured =
      state.whatsapp.status !== 'disconnected' ||
      Boolean(this.adapter.hasSavedWhatsAppSession?.()) ||
      Boolean(state.credentials?.whatsappPairingPhone) ||
      Boolean(process.env.WA_PAIRING_PHONE?.trim());

    if (!hasWaConfigured) {
      this.step = 'awaiting_wa_phone';
      this.log('\n==================================================');
      this.log(' Vincular WhatsApp por código (sin QR)');
      this.log('==================================================');
      this.log('Ingresa tu número de WhatsApp con código de país (sin +, ej. 5491155551234):');
      this.log('  (También puedes escribir "qr" para usar QR o "cancelar" para omitir)');
      return true;
    }

    return false;
  }

  startWizard(): void {
    this.cleanupDetectListener();
    this.pendingToken = '';
    this.step = 'awaiting_token';
    this.log('\n==================================================');
    this.log(' Configuración inicial de Puente WA-TG (Consola)');
    this.log('==================================================');
    this.log('Responde cada paso directamente aquí (escribe "cancelar" en cualquier momento para salir).\n');
    this.log('[Paso 1/4] Pega el Token de tu bot de Telegram (@BotFather) y presiona Enter:');
  }

  async handleLine(rawLine: string): Promise<void> {
    const trimmed = rawLine.trim();

    if (this.step !== 'idle' && trimmed.toLowerCase() === 'cancelar') {
      this.cleanupDetectListener();
      this.pendingToken = '';
      this.step = 'idle';
      this.log('[Asistente] Configuración cancelada. Puedes retomarla escribiendo "setup".');
      return;
    }

    if (this.step === 'awaiting_token') {
      const tokenErr = validateBotTokenFormat(trimmed);
      if (tokenErr) {
        this.log(`[Error] ${tokenErr}`);
        this.log('[Paso 1/4] Intenta nuevamente pegando el Bot Token (@BotFather):');
        return;
      }

      this.pendingToken = trimmed;
      this.step = 'awaiting_chat_id';
      this.log('');
      this.log('[Paso 2/4] Ingresa tu Chat ID numérico de Telegram.');
      this.log('  (Si no lo sabes, escribe "detectar" y luego envía /start a tu bot):');
      return;
    }

    if (this.step === 'awaiting_chat_id' || this.step === 'awaiting_detected_chat_id') {
      if (trimmed.toLowerCase() === 'detectar' || trimmed.toLowerCase() === 'auto') {
        this.log('[Telegram] Verificando token y esperando tu mensaje /start en Telegram...');
        const tgState = await this.adapter.connectTelegram(this.pendingToken, '');
        if (tgState.status === 'error') {
          this.log(`[Error] ${tgState.lastError || 'Token rechazado por Telegram.'}`);
          this.step = 'awaiting_token';
          this.log('[Paso 1/4] Pega un Bot Token válido (@BotFather):');
          return;
        }

        this.step = 'awaiting_detected_chat_id';
        this.cleanupDetectListener();
        this.unsubDetect = this.adapter.onTelegramChatIdDetected((detectedId) => {
          if (this.step !== 'awaiting_detected_chat_id') return;
          this.cleanupDetectListener();
          this.adapter.setTelegramChatId(detectedId);
          this.log(`[Telegram] Chat ID detectado y guardado automáticamente: ${detectedId}`);
          this.promptStep3();
        });

        this.log(
          `[Telegram] Bot @${tgState.botUsername} conectado! Abre Telegram, búscale y envíale /start (o escribe el número aquí):`,
        );
        return;
      }

      const chatIdErr = validateChatIdFormat(trimmed);
      if (chatIdErr) {
        this.log(`[Error] ${chatIdErr}`);
        this.log('[Paso 2/4] Ingresa tu Chat ID numérico o escribe "detectar":');
        return;
      }

      this.cleanupDetectListener();
      this.log('[Telegram] Conectando bot y verificando credenciales...');
      const tgState = await this.adapter.connectTelegram(this.pendingToken, trimmed);
      if (tgState.status === 'error') {
        this.log(`[Error] ${tgState.lastError || 'No se pudo autenticar con Telegram.'}`);
        this.step = 'awaiting_token';
        this.log('[Paso 1/4] Pega nuevamente el Bot Token (@BotFather):');
        return;
      }

      this.log(`[Telegram] Conectado como @${tgState.botUsername} -> Chat ID ${tgState.chatId}`);
      this.promptStep3();
      return;
    }

    if (this.step === 'awaiting_pv_only') {
      const answer = parseYesNoInput(trimmed, true);
      if (answer === null) {
        this.log('[Paso 3/4] Responde "s" (sí) o "n" (no). ¿Filtrar SOLO mensajes privados (PV)? (Enter = sí):');
        return;
      }

      this.adapter.updateRules({
        onlyPrivateMessages: answer,
        ignoreStatusBroadcasts: true,
      });
      this.log(
        `[Reglas] Solo mensajes privados (PV): ${answer ? 'ACTIVADO (grupos ignorados)' : 'DESACTIVADO'}`,
      );

      const waStatus = this.adapter.getPublicState().whatsapp.status;
      if (waStatus === 'connected' || waStatus === 'connecting' || this.adapter.hasSavedWhatsAppSession?.()) {
        this.finishWizard();
        return;
      }

      this.step = 'awaiting_wa_phone';
      this.log('');
      this.log(
        '[Paso 4/4] Ingresa tu número de WhatsApp con código de país (sin +, ej. 5491155551234) para generar tu código de 8 dígitos (sin QR):',
      );
      this.log('  (También puedes escribir "qr" para código QR o "n" para omitir)');
      return;
    }

    if (this.step === 'awaiting_wa_phone') {
      const lower = trimmed.toLowerCase();
      if (lower === 'qr') {
        this.finishWizard();
        this.log('[WhatsApp] Generando código QR en consola...');
        await this.adapter.connectWhatsApp();
        return;
      }
      if (lower === 'n' || lower === 'no') {
        this.finishWizard();
        this.log('[WhatsApp] Omitido por ahora. Escribe "codigo <numero>" o "qr" cuando quieras vincular.');
        return;
      }

      const cleanPhone = sanitizePairingPhoneNumber(trimmed);
      if (!cleanPhone) {
        this.log('[Error] Número inválido. Escribe código de país + número (ej. 5491155551234), o "qr"/"n":');
        return;
      }

      this.finishWizard();
      this.log(`[WhatsApp] Solicitando código de vinculación (sin QR) para +${cleanPhone}...`);
      await this.adapter.connectWhatsApp({ pairingPhone: cleanPhone });
      return;
    }

    await this.handleRegularCommand(rawLine);
  }

  private promptStep3(): void {
    this.step = 'awaiting_pv_only';
    this.log('');
    this.log('[Paso 3/4] ¿Quieres ignorar grupos y reenviar SOLO mensajes privados (PV)? (s/n, Enter = sí):');
  }

  private finishWizard(): void {
    this.step = 'idle';
    this.pendingToken = '';
    this.log('');
    this.log('==================================================');
    this.log(' Configuración completada — Puente listo');
    this.log('==================================================');
    this.log(
      'Credenciales guardadas automáticamente en credenciales.json: al reiniciar el servidor volverá a conectar solo sin pedirlas de nuevo.',
    );
    this.log('Escribe "help" para ver todos los comandos disponibles.\n');
  }

  private cleanupDetectListener(): void {
    if (this.unsubDetect) {
      this.unsubDetect();
      this.unsubDetect = null;
    }
  }

  private async handleRegularCommand(line: string): Promise<void> {
    const parsed = parseConsoleCommand(line);
    switch (parsed.type) {
      case 'empty':
        return;
      case 'help':
        this.log(formatConsoleHelp());
        return;
      case 'setup':
        this.startWizard();
        return;
      case 'status': {
        const s = this.adapter.getPublicState();
        this.log('[Estado]');
        this.log(
          `  WhatsApp : ${s.whatsapp.status}${s.whatsapp.connectedPhone ? ` (${s.whatsapp.connectedPhone})` : ''}${s.whatsapp.pairingCode ? ` · Código: ${s.whatsapp.pairingCode}` : ''}`,
        );
        this.log(
          `  Telegram : ${s.telegram.status}${s.telegram.botUsername ? ` (@${s.telegram.botUsername})` : ''} · Chat ID: ${s.telegram.chatId || 'sin definir'} · Fijado: ${s.telegram.pinnedChatName || 'ninguno'}`,
        );
        this.log(
          `  Modo 24/7: ${s.rules.keepAliveEnabled ? 'ACTIVO' : 'INACTIVO'} · Credenciales: ${s.credentials?.hasTelegramToken ? 'guardadas (credenciales.json)' : 'pendientes'}`,
        );
        this.log(
          `  Reglas   : Reenvío=${s.rules.paused ? 'PAUSA' : 'ACTIVO'} · Solo PV=${s.rules.onlyPrivateMessages ? 'ON' : 'OFF'} · Ignorar estados=${s.rules.ignoreStatusBroadcasts ? 'ON' : 'OFF'} · Bloqueados=${s.rules.blockedJids.length}`,
        );
        return;
      }
      case 'pause':
        this.adapter.updateRules({ paused: true });
        this.log('[Puente] Reenvío WA → TG PAUSADO. Escribe "reanudar" para reactivarlo.');
        return;
      case 'resume':
        this.adapter.updateRules({ paused: false });
        this.log('[Puente] Reenvío WA → TG REANUDADO.');
        return;
      case 'block': {
        const jid = normalizePhoneToJid(parsed.target);
        if (!jid) {
          this.log('[Reglas] Número inválido. Ejemplo: bloquear +5491155551234');
          return;
        }
        const current = this.adapter.getPublicState().rules.blockedJids;
        const label = formatPhoneDisplay(jid);
        if (current.includes(jid)) {
          this.log(`[Reglas] ${label} ya estaba bloqueado.`);
          return;
        }
        this.adapter.updateRules({ blockedJids: [...current, jid] });
        this.log(`[Reglas] Contacto bloqueado: ${label}`);
        return;
      }
      case 'unblock': {
        const jid = normalizePhoneToJid(parsed.target);
        if (!jid) {
          this.log('[Reglas] Número inválido. Ejemplo: desbloquear +5491155551234');
          return;
        }
        const current = this.adapter.getPublicState().rules.blockedJids;
        const label = formatPhoneDisplay(jid);
        if (!current.includes(jid)) {
          this.log(`[Reglas] ${label} no está bloqueado.`);
          return;
        }
        this.adapter.updateRules({ blockedJids: current.filter((item) => item !== jid) });
        this.log(`[Reglas] Contacto desbloqueado: ${label}`);
        return;
      }
      case 'list_blocked': {
        const blocked = this.adapter.getPublicState().rules.blockedJids;
        if (blocked.length === 0) {
          this.log('[Reglas] No hay contactos bloqueados.');
          return;
        }
        this.log(`[Reglas] Contactos bloqueados (${blocked.length}):`);
        blocked.forEach((jid, idx) => {
          this.log(`  ${idx + 1}. ${formatPhoneDisplay(jid)}`);
        });
        return;
      }
      case 'wa_connect':
        this.log('[WhatsApp] Iniciando sesión y generando código QR...');
        await this.adapter.connectWhatsApp();
        return;
      case 'wa_pair_prompt':
        this.step = 'awaiting_wa_phone';
        this.log(
          '[WhatsApp] Ingresa tu número con código de país (sin +, ej. 5491155551234) para generar tu código de 8 dígitos:',
        );
        return;
      case 'wa_pair_code': {
        const cleanPhone = sanitizePairingPhoneNumber(parsed.phone);
        if (!cleanPhone) {
          this.log('[WhatsApp] Número inválido. Ejemplo: codigo 5491155551234');
          return;
        }
        this.log(`[WhatsApp] Solicitando código de vinculación (sin QR) para +${cleanPhone}...`);
        await this.adapter.connectWhatsApp({ pairingPhone: cleanPhone });
        return;
      }
      case 'wa_disconnect':
        await this.adapter.disconnectWhatsApp(parsed.logout);
        this.log(
          parsed.logout
            ? '[WhatsApp] Sesión cerrada y credenciales eliminadas.'
            : '[WhatsApp] Conexión pausada.',
        );
        return;
      case 'tg_connect': {
        const validation = validateTelegramConfigInput(parsed.token, parsed.chatId);
        if (!validation.valid) {
          this.log(
            `[Telegram] Datos inválidos: ${validation.errors.token || validation.errors.chatId}`,
          );
          return;
        }
        this.log(`[Telegram] Conectando bot (${maskToken(parsed.token)})...`);
        const next = await this.adapter.connectTelegram(parsed.token, parsed.chatId);
        if (next.status === 'connected') {
          this.log(`[Telegram] Conectado como @${next.botUsername} -> Chat ID ${next.chatId}`);
        } else {
          this.log(`[Telegram] Error: ${next.lastError || 'No se pudo conectar'}`);
        }
        return;
      }
      case 'tg_set_chat_id': {
        const chatIdErr = validateChatIdFormat(parsed.chatId);
        if (chatIdErr) {
          this.log(`[Telegram] ${chatIdErr}`);
          return;
        }
        const normalized = parseAuthorizedChatIds(parsed.chatId).join(', ');
        this.adapter.setTelegramChatId(normalized);
        this.log(`[Telegram] Chat ID autorizado actualizado en credenciales.json: ${normalized}`);
        if (process.env.TELEGRAM_CHAT_ID?.trim() && process.env.TELEGRAM_CHAT_ID.trim() !== normalized) {
          this.log(
            '[Telegram] Aviso: TELEGRAM_CHAT_ID está definido en las variables del servidor; actualízalo o déjalo vacío para que no sobrescriba credenciales.json al reiniciar.',
          );
        }
        return;
      }
      case 'tg_add_chat_id': {
        const chatIdErr = validateChatIdFormat(parsed.chatId);
        if (chatIdErr) {
          this.log(`[Telegram] ${chatIdErr}`);
          return;
        }
        const existing = parseAuthorizedChatIds(this.adapter.getPublicState().telegram.chatId);
        const added = parseAuthorizedChatIds(parsed.chatId);
        const combined = [...new Set([...existing, ...added])].join(', ');
        this.adapter.setTelegramChatId(combined);
        this.log(`[Telegram] Chat(s) autorizado(s) guardados en credenciales.json: ${combined}`);
        return;
      }
      case 'tg_disconnect':
        await this.adapter.disconnectTelegram();
        this.log('[Telegram] Bot desconectado.');
        return;
      case 'tg_test': {
        const res = await this.adapter.testTelegram();
        this.log(
          res.ok
            ? '[Telegram] Mensaje de prueba enviado correctamente.'
            : `[Telegram] No se pudo enviar prueba: ${res.error}`,
        );
        return;
      }
      case 'set_pv_only':
        this.adapter.updateRules({ onlyPrivateMessages: parsed.value });
        this.log(
          `[Reglas] Solo mensajes privados (PV): ${parsed.value ? 'ACTIVADO' : 'DESACTIVADO'}`,
        );
        return;
      case 'set_ignore_broadcasts':
        this.adapter.updateRules({ ignoreStatusBroadcasts: parsed.value });
        this.log(
          `[Reglas] Ignorar estados/difusiones: ${parsed.value ? 'ACTIVADO' : 'DESACTIVADO'}`,
        );
        return;
      case 'reply': {
        const jid = normalizePhoneToJid(parsed.target);
        if (!jid) {
          this.log('[Consola] Número inválido. Ejemplo: responder +5491155551234 Hola!');
          return;
        }
        const res = await this.adapter.sendOutboundReply({
          jid,
          text: parsed.message,
          origin: 'web',
        });
        this.log(`[Consola] ${res.detail}`);
        return;
      }
      case 'unknown':
        this.log(
          `[Consola] Comando no reconocido: "${parsed.raw}". Escribe "help" o "setup" para configurar.`,
        );
    }
  }
}

export function attachConsoleInterface(adapter: ConsoleBridgeAdapter): ConsoleSessionController {
  const controller = new ConsoleSessionController(adapter);

  if (process.stdin && typeof process.stdin.on === 'function') {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        void controller.handleLine(line);
      }
    });
  }

  return controller;
}

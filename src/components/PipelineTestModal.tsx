import { useState } from 'react';
import { X } from 'lucide-react';

interface PipelineTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitTest: (payload: {
    phoneOrJid: string;
    senderName: string;
    text: string;
    isGroup: boolean;
  }) => Promise<{
    ok: boolean;
    accepted?: boolean;
    reason?: string;
    forwardedToTelegram?: boolean;
    message?: string;
  }>;
}

export function PipelineTestModal({ isOpen, onClose, onSubmitTest }: PipelineTestModalProps) {
  const [isGroup, setIsGroup] = useState(false);
  const [senderName, setSenderName] = useState('Carlos Vega');
  const [phoneOrJid, setPhoneOrJid] = useState('+5491162348899');
  const [text, setText] = useState('Hola! ¿Tienes disponibilidad para revisar la cotización?');
  const [submitting, setSubmitting] = useState(false);
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResultMsg(null);
    try {
      const res = await onSubmitTest({
        phoneOrJid,
        senderName,
        text,
        isGroup,
      });

      if (!res.ok) {
        setResultMsg({ ok: false, text: res.message || 'No se pudo procesar la prueba.' });
      } else if (res.accepted) {
        setResultMsg({
          ok: true,
          text: res.forwardedToTelegram
            ? 'Mensaje PV aceptado y reenviado a tu chat de Telegram.'
            : 'Mensaje PV aceptado y registrado en la bandeja (conecta Telegram para envío real).',
        });
      } else {
        setResultMsg({
          ok: true,
          text: 'Mensaje grupal bloqueado correctamente por la regla Solo mensajes privados (PV).',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pipeline-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40"
    >
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <h2 id="pipeline-modal-title" className="font-display text-base font-semibold text-slate-900">
            Probar flujo de entrada WhatsApp → Telegram
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana de prueba"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4">
          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              Tipo de mensaje entrante
            </span>
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setIsGroup(false)}
                className={`py-2 text-xs font-medium rounded-md transition-colors ${
                  !isGroup ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mensaje privado (PV)
              </button>
              <button
                type="button"
                onClick={() => setIsGroup(true)}
                className={`py-2 text-xs font-medium rounded-md transition-colors ${
                  isGroup ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mensaje de grupo (@g.us)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label htmlFor="test-sender-name" className="block text-xs font-medium text-slate-700 mb-1">
                {isGroup ? 'Nombre del grupo' : 'Nombre del contacto'}
              </label>
              <input
                id="test-sender-name"
                type="text"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>

            <div>
              <label htmlFor="test-phone" className="block text-xs font-medium text-slate-700 mb-1">
                {isGroup ? 'ID de grupo' : 'Teléfono WhatsApp'}
              </label>
              <input
                id="test-phone"
                type="text"
                value={phoneOrJid}
                onChange={(e) => setPhoneOrJid(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <label htmlFor="test-message-text" className="block text-xs font-medium text-slate-700 mb-1">
              Contenido del mensaje
            </label>
            <textarea
              id="test-message-text"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          {resultMsg && (
            <p
              role="status"
              className={`text-xs font-medium ${resultMsg.ok ? 'text-teal-800' : 'text-rose-700'}`}
            >
              {resultMsg.text}
            </p>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 rounded-lg"
            >
              Cerrar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors"
            >
              {submitting ? 'Procesando...' : 'Inyectar mensaje'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

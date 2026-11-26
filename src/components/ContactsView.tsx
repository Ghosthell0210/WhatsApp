import React, { useState } from 'react';
import { Users, Upload, Search, Tag, Trash2, Edit2, Check, X, Phone, Shield } from 'lucide-react';
import type { BridgeContact } from '../bridge/types';

interface ContactsViewProps {
  contacts: BridgeContact[];
}

export function ContactsView({ contacts }: ContactsViewProps) {
  const [search, setSearch] = useState('');
  const [vcfText, setVcfText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [editingJid, setEditingJid] = useState<string | null>(null);
  const [aliasInput, setAliasInput] = useState('');

  const filtered = contacts.filter((c) => {
    const q = search.toLowerCase();
    return (
      c.phone.toLowerCase().includes(q) ||
      c.jid.toLowerCase().includes(q) ||
      (c.profileName && c.profileName.toLowerCase().includes(q)) ||
      (c.customAlias && c.customAlias.toLowerCase().includes(q)) ||
      c.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const content = evt.target?.result as string;
      if (content) {
        await submitVcf(content);
      }
    };
    reader.readAsText(file);
  };

  const submitVcf = async (text: string) => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch('/api/contacts/import-vcf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vcfText: text }),
      });
      const data = await res.json();
      if (data.ok) {
        setImportResult(`¡${data.importedCount} contactos importados con éxito!`);
        setVcfText('');
      } else {
        setImportResult(data.message || 'Error al importar VCF.');
      }
    } catch {
      setImportResult('Error de red al importar contactos.');
    } finally {
      setImporting(false);
    }
  };

  const saveAlias = async (jid: string) => {
    try {
      const res = await fetch(`/api/contacts/${encodeURIComponent(jid)}/alias`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: aliasInput }),
      });
      if (res.ok) {
        setEditingJid(null);
        setAliasInput('');
      }
    } catch {
      // Ignore
    }
  };

  const deleteContact = async (jid: string) => {
    if (!window.confirm('¿Eliminar este contacto de la libreta?')) return;
    try {
      await fetch(`/api/contacts/${encodeURIComponent(jid)}`, {
        method: 'DELETE',
      });
    } catch {
      // Ignore
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 overflow-y-auto">
      <div className="p-6 md:p-8 max-w-6xl w-full mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
              Libreta de Contactos
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Gestiona nombres personalizados, etiquetas y tarjetas VCF importadas.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium transition-colors shadow-sm">
              <Upload className="w-4 h-4" />
              <span>Importar VCF</span>
              <input type="file" accept=".vcf,.vcard" onChange={handleFileUpload} className="hidden" />
            </label>
          </div>
        </div>

        {importResult && (
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium flex items-center justify-between">
            <span>{importResult}</span>
            <button onClick={() => setImportResult(null)} className="text-emerald-600 hover:text-emerald-900">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* VCF Text Input Accordion / Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-3">
          <h2 className="text-sm font-semibold text-slate-800">Pegar contenido VCF manualmente</h2>
          <div className="flex gap-3">
            <textarea
              rows={2}
              value={vcfText}
              onChange={(e) => setVcfText(e.target.value)}
              placeholder="BEGIN:VCARD&#10;FN:Nombre Apellido&#10;TEL:+54911...&#10;END:VCARD"
              className="flex-1 rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-mono text-slate-800 focus:outline-2 focus:outline-teal-700"
            />
            <button
              type="button"
              disabled={importing || !vcfText.trim()}
              onClick={() => submitVcf(vcfText)}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-medium self-end transition-colors"
            >
              {importing ? 'Importando...' : 'Procesar'}
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-2.5 shadow-xs">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, alias, teléfono o etiqueta..."
            className="w-full bg-transparent text-sm text-slate-800 placeholder-slate-400 focus:outline-hidden"
          />
        </div>

        {/* Contacts Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.length === 0 ? (
            <div className="col-span-full py-16 text-center bg-white rounded-2xl border border-slate-200 p-8">
              <Users className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-700">No se encontraron contactos</p>
              <p className="text-xs text-slate-400 mt-1">Importa un archivo .vcf o espera a recibir mensajes.</p>
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.jid}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between space-y-4 hover:border-slate-300 transition-colors"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      {c.customAlias ? (
                        <div>
                          <h3 className="font-semibold text-slate-900 text-base">{c.customAlias}</h3>
                          <p className="text-xs text-slate-400">{c.profileName || c.phone}</p>
                        </div>
                      ) : (
                        <h3 className="font-semibold text-slate-900 text-base">
                          {c.profileName && c.profileName !== c.phone ? c.profileName : c.phone}
                        </h3>
                      )}
                    </div>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-mono">
                      <Phone className="w-3 h-3" />
                      {c.phone}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {c.tags.map((t, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 text-[11px] font-medium"
                      >
                        <Tag className="w-2.5 h-2.5" />
                        {t}
                      </span>
                    ))}
                    {c.isImported && (
                      <span className="px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 text-[11px] font-medium">
                        VCF
                      </span>
                    )}
                  </div>
                </div>

                {editingJid === c.jid ? (
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <input
                      type="text"
                      value={aliasInput}
                      onChange={(e) => setAliasInput(e.target.value)}
                      placeholder="Nuevo alias..."
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-800 focus:outline-2 focus:outline-teal-700"
                    />
                    <button
                      onClick={() => saveAlias(c.jid)}
                      className="p-1.5 bg-teal-700 text-white rounded-lg hover:bg-teal-800"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setEditingJid(null)}
                      className="p-1.5 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-500">
                    <span>Último contacto: {new Date(c.lastSeenAt).toLocaleDateString()}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setEditingJid(c.jid);
                          setAliasInput(c.customAlias || c.profileName || '');
                        }}
                        title="Editar alias"
                        className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteContact(c.jid)}
                        title="Eliminar contacto"
                        className="p-1.5 text-rose-400 hover:text-rose-700 rounded-md hover:bg-rose-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

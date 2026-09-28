import { useEffect, useState } from "react";
import { useI18n, type Key } from "../lib/i18n";
import { DEFAULT_SETTINGS, useSaveSettings, useSettings, type Settings } from "../lib/useSettings";
import type { ExcursionRule, Triggers } from "../lib/useTriggers";

type Draft = Omit<Settings, "saved">;

// Everything the server lets people change, on one screen: the language every browser shares, how long a stopped VM
// stays visible, and the thresholds the incidents are judged with. Values are held in a draft until Save
export function SettingsPanel() {
  const { t } = useI18n();
  const current = useSettings();
  const { save, reset } = useSaveSettings();
  const [draft, setDraft] = useState<Draft>(() => strip(current));
  const [dirty, setDirty] = useState(false);
  // The note keeps its key, not its text, so it follows a language change made on this very screen
  const [note, setNote] = useState<{ kind: "ok" | "err"; key: Key; msg?: string } | null>(null);

  // Follow the server while nothing is being edited (another browser may have saved)
  useEffect(() => {
    if (!dirty) setDraft(strip(current));
  }, [current, dirty]);

  const edit = (f: (d: Draft) => Draft) => {
    setDraft((d) => f(d));
    setDirty(true);
    setNote(null);
  };
  const rule = (get: (tr: Triggers) => ExcursionRule, set: (tr: Triggers, r: ExcursionRule) => Triggers) => ({
    value: get(draft.triggers),
    onChange: (r: ExcursionRule) => edit((d) => ({ ...d, triggers: set(d.triggers, r) })),
  });

  const onSave = () => {
    save.mutate(draft, {
      onSuccess: () => { setDirty(false); setNote({ kind: "ok", key: "settings.saved" }); },
      onError: (e) => setNote({ kind: "err", key: "settings.error", msg: (e as Error).message }),
    });
  };
  const onReset = () => {
    reset.mutate(undefined, {
      onSuccess: (s) => { setDraft(strip({ ...DEFAULT_SETTINGS, ...s })); setDirty(false); setNote({ kind: "ok", key: "settings.resetDone" }); },
      onError: (e) => setNote({ kind: "err", key: "settings.error", msg: (e as Error).message }),
    });
  };

  const rules: { key: Key; get: (tr: Triggers) => ExcursionRule; set: (tr: Triggers, r: ExcursionRule) => Triggers; step?: number }[] = [
    { key: "settings.rule.cpu", get: (tr) => tr.cpu, set: (tr, r) => ({ ...tr, cpu: r }) },
    { key: "settings.rule.memory", get: (tr) => tr.memory, set: (tr, r) => ({ ...tr, memory: r }) },
    { key: "settings.rule.disk", get: (tr) => tr.disk, set: (tr, r) => ({ ...tr, disk: r }) },
    { key: "settings.rule.netFails", get: (tr) => tr.network.connectFails, set: (tr, r) => ({ ...tr, network: { ...tr.network, connectFails: r } }) },
    { key: "settings.rule.netLatency", get: (tr) => tr.network.connectLatency, set: (tr, r) => ({ ...tr, network: { ...tr.network, connectLatency: r } }) },
    { key: "settings.rule.netRetrans", get: (tr) => tr.network.retrans, set: (tr, r) => ({ ...tr, network: { ...tr.network, retrans: r } }) },
    { key: "settings.rule.dnsFails", get: (tr) => tr.dns.fails, set: (tr, r) => ({ ...tr, dns: { ...tr.dns, fails: r } }) },
    { key: "settings.rule.dnsLatency", get: (tr) => tr.dns.latency, set: (tr, r) => ({ ...tr, dns: { ...tr.dns, latency: r } }) },
    { key: "settings.rule.gpuStarved", get: (tr) => tr.gpu.starved, set: (tr, r) => ({ ...tr, gpu: { ...tr.gpu, starved: r } }), step: 0.05 },
    { key: "settings.rule.vram", get: (tr) => tr.gpu.vram, set: (tr, r) => ({ ...tr, gpu: { ...tr.gpu, vram: r } }), step: 0.01 },
  ];

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("settings.desc")}</p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{t(current.saved ? "settings.sourceSaved" : "settings.sourceDefault")}</p>

      <h3 className="mt-6 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("settings.lang")}</h3>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.langNote")}</p>
      <select
        className="rounded-md px-2 py-1 text-sm"
        style={{ background: "var(--page)", border: "1px solid var(--border)" }}
        value={draft.ui.lang}
        onChange={(e) => edit((d) => ({ ...d, ui: { ...d.ui, lang: e.target.value as Draft["ui"]["lang"] } }))}
      >
        <option value="">{t("settings.langAuto")}</option>
        <option value="en">EN</option>
        <option value="ja">日本語</option>
      </select>

      <h3 className="mt-6 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("settings.vm")}</h3>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.vmNote")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Duration label={t("settings.vmAttention")} seconds={draft.ui.vm.attentionSeconds} unit="min" t={t}
          onChange={(v) => edit((d) => ({ ...d, ui: { ...d.ui, vm: { ...d.ui.vm, attentionSeconds: v } } }))} />
        <Duration label={t("settings.vmStopped")} seconds={draft.ui.vm.stoppedSeconds} unit="min" t={t}
          onChange={(v) => edit((d) => ({ ...d, ui: { ...d.ui, vm: { ...d.ui.vm, stoppedSeconds: v } } }))} />
        <Duration label={t("settings.vmPast")} seconds={draft.ui.vm.pastSeconds} unit="h" t={t}
          onChange={(v) => edit((d) => ({ ...d, ui: { ...d.ui, vm: { ...d.ui.vm, pastSeconds: v } } }))} />
      </div>

      <h3 className="mt-6 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("settings.triggers")}</h3>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.triggersNote")}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm tabular">
          <thead style={{ color: "var(--text-muted)" }}>
            <tr>
              <th className="py-1 text-left font-normal">{t("settings.colRule")}</th>
              <th className="py-1 text-right font-normal">{t("settings.colCaution")}</th>
              <th className="py-1 text-right font-normal">{t("settings.colWarning")}</th>
              <th className="py-1 text-right font-normal">{t("settings.colMin")}</th>
              <th className="py-1 text-right font-normal">{t("settings.colGap")}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const { value, onChange } = rule(r.get, r.set);
              return (
                <tr key={r.key} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1.5 pr-3">{t(r.key)}</td>
                  <td className="py-1.5 text-right"><Num value={value.caution} step={r.step} onChange={(v) => onChange({ ...value, caution: v })} /></td>
                  <td className="py-1.5 text-right"><Num value={value.warning} step={r.step} onChange={(v) => onChange({ ...value, warning: v })} /></td>
                  <td className="py-1.5 text-right"><Num value={value.minSeconds} onChange={(v) => onChange({ ...value, minSeconds: v })} /></td>
                  <td className="py-1.5 text-right"><Num value={value.maxGapSeconds} onChange={(v) => onChange({ ...value, maxGapSeconds: v })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t("settings.gpuIdle")}>
          <Num value={draft.triggers.gpu.idleUtil} step={0.05} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, gpu: { ...d.triggers.gpu, idleUtil: v } } }))} />
        </Field>
        <Field label={t("settings.netSpread")}>
          <Num value={draft.triggers.network.failSpreadSeconds} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, network: { ...d.triggers.network, failSpreadSeconds: v } } }))} />
        </Field>
        <Field label={t("settings.dnsSpread")}>
          <Num value={draft.triggers.dns.failSpreadSeconds} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, dns: { ...d.triggers.dns, failSpreadSeconds: v } } }))} />
        </Field>
        <Field label={t("settings.agentDown")}>
          <Num value={draft.triggers.agentDown.afterSeconds} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, agentDown: { afterSeconds: v } } }))} />
        </Field>
        <Field label={t("settings.crashLoop", { n: draft.triggers.processes.crashLoopCount, s: draft.triggers.processes.crashLoopWindowSeconds })}>
          <span className="flex items-center gap-2">
            <Num value={draft.triggers.processes.crashLoopCount} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, processes: { ...d.triggers.processes, crashLoopCount: v } } }))} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.crashLoopCount")}</span>
            <Num value={draft.triggers.processes.crashLoopWindowSeconds} onChange={(v) => edit((d) => ({ ...d, triggers: { ...d.triggers, processes: { ...d.triggers.processes, crashLoopWindowSeconds: v } } }))} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.crashLoopWindow")}</span>
          </span>
        </Field>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={onSave}
          disabled={!dirty || save.isPending}
          className="rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--series-1)", color: "var(--page)" }}
        >
          {t("settings.save")}
        </button>
        <button
          onClick={onReset}
          disabled={reset.isPending}
          className="rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
        >
          {t("settings.reset")}
        </button>
        {dirty && !note && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t("settings.dirty")}</span>}
        {note && (
          <span role="status" className="text-sm" style={{ color: note.kind === "ok" ? "var(--status-good)" : "var(--status-critical)" }}>{t(note.key, { msg: note.msg ?? "" })}</span>
        )}
      </div>
    </section>
  );
}

const strip = (s: Settings): Draft => ({ triggers: s.triggers, ui: s.ui });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      {children}
    </label>
  );
}

// Seconds edited in minutes or hours, since nobody thinks of an hour as 3600
function Duration({ label, seconds, unit, onChange, t }: {
  label: string; seconds: number; unit: "min" | "h"; onChange: (s: number) => void; t: (k: Key) => string;
}) {
  const div = unit === "min" ? 60 : 3600;
  return (
    <Field label={label}>
      <span className="flex items-center gap-2">
        <Num value={Math.round((seconds / div) * 100) / 100} step={unit === "min" ? 1 : 0.5} onChange={(v) => onChange(Math.round(v * div))} />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t(unit === "min" ? "settings.minutes" : "settings.hours")}</span>
      </span>
    </Field>
  );
}

function Num({ value, step, onChange }: { value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step ?? 1}
      min={0}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      className="w-28 rounded-md px-2 py-1 text-right text-sm"
      style={{ background: "var(--page)", border: "1px solid var(--border)" }}
    />
  );
}

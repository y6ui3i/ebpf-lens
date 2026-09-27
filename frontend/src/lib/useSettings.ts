// The settings document the server keeps (GET/PUT/DELETE /api/settings): trigger thresholds plus the UI choices
// every browser shares (language, VM lifecycle bounds). Saving from the settings screen overrides the -triggers file
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_TRIGGERS, type Triggers } from "./useTriggers";

export type VMLifecycleSettings = { attentionSeconds: number; stoppedSeconds: number; pastSeconds: number };
export type UISettings = { lang: "" | "en" | "ja"; vm: VMLifecycleSettings };
export type Settings = { triggers: Triggers; ui: UISettings; saved: boolean };

export const DEFAULT_SETTINGS: Settings = {
  triggers: DEFAULT_TRIGGERS,
  ui: { lang: "", vm: { attentionSeconds: 5 * 60, stoppedSeconds: 60 * 60, pastSeconds: 24 * 60 * 60 } },
  saved: false,
};

export const SETTINGS_KEY = ["settings"];

async function fetchSettings(): Promise<Settings> {
  const r = await fetch("/api/settings");
  if (!r.ok) throw new Error(`GET /api/settings: ${r.status}`);
  const d = (await r.json()) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...d, ui: { ...DEFAULT_SETTINGS.ui, ...d.ui, vm: { ...DEFAULT_SETTINGS.ui.vm, ...d.ui?.vm } } };
}

export function useSettings(): Settings {
  const q = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, staleTime: 5 * 60 * 1000 });
  return q.data ?? DEFAULT_SETTINGS;
}

async function readError(r: Response): Promise<string> {
  const text = (await r.text()).trim();
  return text || `${r.status} ${r.statusText}`;
}

// Save (PUT) or reset (DELETE). Both refresh the settings and the triggers the charts draw their bands from
export function useSaveSettings() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: SETTINGS_KEY });
    qc.invalidateQueries({ queryKey: ["triggers"] });
  };
  const save = useMutation({
    mutationFn: async (s: Omit<Settings, "saved">) => {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
      if (!r.ok) throw new Error(await readError(r));
      return (await r.json()) as Settings;
    },
    onSuccess: invalidate,
  });
  const reset = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settings", { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      return (await r.json()) as Settings;
    },
    onSuccess: invalidate,
  });
  return { save, reset };
}

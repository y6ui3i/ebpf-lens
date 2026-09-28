import { useRef, useState } from "react";
import { useI18n } from "../lib/i18n";

// "Copy report": opens the message ready to send (built on demand, so it reflects this moment) with a copy button.
// The server is usually opened over plain HTTP on a LAN, where the Clipboard API is not available (it needs a secure
// context), so copying falls back to selecting the text and execCommand("copy"); the text stays selectable either way
export function ReportButton({ build }: { build: () => string }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "manual" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const open = () => {
    setText(build());
    setCopied(null);
  };
  const copy = async () => {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        setCopied("ok");
        return;
      }
    } catch {
      // fall through to the selection-based copy
    }
    const el = area.current;
    if (el) {
      el.focus();
      el.select();
      setCopied(document.execCommand("copy") ? "ok" : "manual");
    }
  };

  // display: contents makes the button and the panel direct children of the caller's flex-wrap header row: the button
  // sits at the right end of the headline, and the panel wraps to a full-width row of its own below it
  return (
    <div className="contents">
      <button
        onClick={() => (text == null ? open() : setText(null))}
        aria-expanded={text != null}
        className="rounded-md px-2.5 py-1 text-xs"
        style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
      >
        {t(text == null ? "report.open" : "report.close")}
      </button>
      {text != null && (
        <div className="mt-1 w-full basis-full">
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("report.note")}</p>
          <textarea
            ref={area}
            readOnly
            value={text}
            rows={Math.min(24, text.split("\n").length + 1)}
            className="w-full rounded-md p-3 font-mono text-xs"
            style={{ background: "var(--page)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="mt-2 flex items-center gap-3">
            <button onClick={copy} className="rounded-md px-3 py-1.5 text-sm font-semibold" style={{ background: "var(--series-1)", color: "var(--page)" }}>
              {t("report.copy")}
            </button>
            <button onClick={open} className="rounded-md px-3 py-1.5 text-sm" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
              {t("report.refresh")}
            </button>
            {copied && (
              <span role="status" className="text-sm" style={{ color: copied === "ok" ? "var(--status-good)" : "var(--text-secondary)" }}>
                {t(copied === "ok" ? "report.copied" : "report.copyManual")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

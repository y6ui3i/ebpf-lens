package trigger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// Notifier posts incident transitions (open, escalate, close) to a webhook. Progress updates are not sent.
// Delivery is asynchronous with one retry, so a slow or dead webhook never blocks ingestion.
type Notifier struct {
	url, format string
	client      *http.Client
	queue       chan notification
	mu          sync.Mutex
	seen        map[string]model.Incident // last state notified per incident ID
}

type notification struct {
	Event    string         `json:"event"` // "open" | "escalate" | "close"
	Text     string         `json:"text"`
	Incident model.Incident `json:"incident"`
}

// NewNotifier accepts format "generic" (full JSON), "slack" ({"text"}), or "discord" ({"content"}).
func NewNotifier(url, format string) (*Notifier, error) {
	switch format {
	case "generic", "slack", "discord":
	default:
		return nil, fmt.Errorf("unknown webhook format %q (use generic, slack or discord)", format)
	}
	n := &Notifier{
		url: url, format: format,
		client: &http.Client{Timeout: 5 * time.Second},
		queue:  make(chan notification, 256),
		seen:   map[string]model.Incident{},
	}
	go n.loop()
	return n, nil
}

// OnIncident decides whether a stored incident is a transition worth telling someone about.
// It is called from the store for every upsert, so it must be cheap and must not block.
func (n *Notifier) OnIncident(inc model.Incident) {
	n.mu.Lock()
	defer n.mu.Unlock()
	prev, known := n.seen[inc.ID]
	n.seen[inc.ID] = inc
	if len(n.seen) > 10000 { // bounded memory; old closed incidents are not needed again
		for id, x := range n.seen {
			if !x.Ongoing() && time.Since(x.Updated) > 24*time.Hour {
				delete(n.seen, id)
			}
		}
	}
	var event string
	switch {
	case !known:
		event = "open"
	case prev.Ongoing() && !inc.Ongoing():
		event = "close"
	case prev.Level != inc.Level:
		event = "escalate"
	default:
		return
	}
	// An instant incident (OOM kill, crash) is born closed; report it as an open, never as a close
	if event == "close" && inc.End != nil && inc.End.Equal(inc.Start) {
		return
	}
	select {
	case n.queue <- notification{Event: event, Text: Text(event, inc), Incident: inc}:
	default:
		log.Printf("webhook: queue full, dropped %s for %s", event, inc.ID)
	}
}

func (n *Notifier) loop() {
	for msg := range n.queue {
		if err := n.post(msg); err != nil {
			time.Sleep(2 * time.Second)
			if err = n.post(msg); err != nil {
				log.Printf("webhook: %v", err)
			}
		}
	}
}

func (n *Notifier) post(msg notification) error {
	var body any = msg
	switch n.format {
	case "slack":
		body = map[string]string{"text": msg.Text}
	case "discord":
		body = map[string]string{"content": msg.Text}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	resp, err := n.client.Post(n.url, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned %s", resp.Status)
	}
	return nil
}

// Text renders one line a person can read in a chat channel. English only; the UI has its own translations.
func Text(event string, i model.Incident) string {
	level := map[string]string{LevelCaution: "CAUTION", LevelWarning: "WARNING"}[i.Level]
	if !i.Ongoing() && i.End != nil && !i.End.Equal(i.Start) {
		level = "RESOLVED"
	}
	when := i.Start.Format("15:04:05")
	var what string
	switch i.Kind {
	case KindCPUWait:
		what = fmt.Sprintf("processes are competing for CPU (99%% of tasks waited up to %s, %d s since %s)%s", formatUs(i.Peak), i.Seconds, when, culpritText(i))
	case KindVMCPUWait:
		what = fmt.Sprintf("VM %s is waiting for host CPU (99%% of its tasks waited up to %s, %d s since %s)%s", i.VM, formatUs(i.Peak), i.Seconds, when, culpritText(i))
	case KindMemStall:
		what = fmt.Sprintf("processes are stalling on low memory (%.0f ms/s stalled in reclaim, %d s since %s)", i.Peak, i.Seconds, when)
	case KindOOMKill:
		scope := "the host ran out of memory"
		if i.Memcg {
			scope = "its cgroup memory limit was reached"
		}
		what = fmt.Sprintf("%s (pid %d) was OOM-killed at %s because %s; triggered by %s (pid %d)", i.Subject, i.Pid, when, scope, i.TriggerComm, i.TriggerPid)
	case KindCrash:
		what = fmt.Sprintf("%s (pid %d) crashed with signal %d at %s", i.Subject, i.Pid, i.Signal, when)
		if i.CoreDump {
			what += " (core dumped)"
		}
	case KindCrashLoop:
		what = fmt.Sprintf("%s is crashing repeatedly (%d times since %s)", i.Subject, i.Count, when)
	case KindAgentDown:
		what = fmt.Sprintf("host stopped reporting (last sample at %s, silent for %d s)", when, i.Seconds)
	case KindVMDown:
		var why string
		switch i.Cause {
		case CauseHostOOM:
			why = fmt.Sprintf("the host ran out of memory and the OOM killer chose it; triggered by %s (pid %d)", i.TriggerComm, i.TriggerPid)
		case CauseCgroupOOM:
			why = fmt.Sprintf("its cgroup memory limit was reached; triggered by %s (pid %d)", i.TriggerComm, i.TriggerPid)
		case CauseCrash:
			why = fmt.Sprintf("QEMU crashed with signal %d", i.Signal)
			if i.CoreDump {
				why += " (core dumped)"
			}
		case CauseKilled:
			why = fmt.Sprintf("QEMU was stopped with signal %d", i.Signal)
			switch {
			case isLibvirt(i.TriggerComm):
				// libvirt runs QEMU with -no-shutdown and sends SIGTERM after a guest shutdown as well as on
				// "virsh destroy", so from the host these two look the same; libvirt's own stop reason would tell
				why += fmt.Sprintf(" by %s (pid %d): a managed shutdown or a virsh destroy", i.TriggerComm, i.TriggerPid)
			case i.TriggerComm != "":
				why += fmt.Sprintf(" by %s (pid %d)", i.TriggerComm, i.TriggerPid)
			default:
				why += " (an administrator, libvirt, or a supervisor)"
			}
		default:
			why = fmt.Sprintf("QEMU exited cleanly with status %d (guest shutdown or a managed stop)", i.ExitStatus)
		}
		what = fmt.Sprintf("VM %s stopped at %s: %s", i.VM, when, why)
		if i.ContextStallMs > 0 || i.ContextWaitP99Us > 0 {
			what += fmt.Sprintf(". In the minute before: %.0f ms stalled in memory reclaim, CPU wait p99 %s", i.ContextStallMs, formatUs(i.ContextWaitP99Us))
		}
	default:
		what = i.Kind
	}
	return fmt.Sprintf("[%s] %s: %s", level, i.Host, what)
}

// culpritText renders "; CPU taken by a (34%), b (24%) — 81% together", or the honest alternative when no one stands out.
func culpritText(i model.Incident) string {
	if len(i.Culprits) == 0 {
		if i.HostBusy > 0 {
			return fmt.Sprintf("; no single process or small group is hogging it (host %.0f%% busy)", i.HostBusy*100)
		}
		return ""
	}
	parts := make([]string, len(i.Culprits))
	for k, c := range i.Culprits {
		parts[k] = fmt.Sprintf("%s (%.0f%%)", c.Name, c.Share*100)
	}
	if len(parts) == 1 {
		return "; CPU taken by " + parts[0]
	}
	return fmt.Sprintf("; CPU taken by %s — %.0f%% together", strings.Join(parts, ", "), i.CulpritShare*100)
}

// isLibvirt matches the libvirt daemons (monolithic libvirtd or the modular virtqemud).
func isLibvirt(comm string) bool { return comm == "libvirtd" || comm == "virtqemud" }

func formatUs(us float64) string {
	switch {
	case us < 1000:
		return fmt.Sprintf("%.0f µs", us)
	case us < 1_000_000:
		return fmt.Sprintf("%.1f ms", us/1000)
	default:
		return fmt.Sprintf("%.1f s", us/1_000_000)
	}
}

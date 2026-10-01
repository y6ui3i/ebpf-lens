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

	"github.com/y6ui3i/ebpf-lens/internal/model"
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
	case KindGPUStarved:
		how := "on the CPU"
		if i.CopyShare > i.CPUShare {
			how = "copying data to or from the GPU"
		}
		what = fmt.Sprintf("the GPU is idle (%.0f%% busy) while %s is working %s (%.0f%% of a CPU, %.0f%% of the time in copies; %d s since %s)",
			i.GPUUtil*100, i.Subject, how, i.CPUShare*100, i.CopyShare*100, i.Seconds, when)
	case KindDiskSlow:
		what = fmt.Sprintf("block I/O is slow (99%% of I/Os completed within %s, %d s since %s)%s", formatUs(i.Peak), i.Seconds, when, ioCulpritText(i))
	case KindDiskError:
		what = fmt.Sprintf("%s returned %d I/O error(s) at %s; check dmesg and SMART", i.Device, i.Count, when)
	case KindNetConnectFail:
		what = fmt.Sprintf("outbound TCP connects are failing (%.0f in 10 s, %d s since %s)%s", i.Peak, i.Seconds, when, destText(i, "failures"))
	case KindNetConnectSlow:
		how := "the network path is slow"
		if i.Peak >= 1_000_000 {
			how = "at 1 s the SYN itself is being retransmitted, so packets are being lost"
		}
		what = fmt.Sprintf("outbound TCP connects are slow (99%% established within %s, %d s since %s; %s)%s", formatUs(i.Peak), i.Seconds, when, how, destText(i, "connect time"))
	case KindNetRetrans:
		what = fmt.Sprintf("TCP segments are being retransmitted (%.0f/s, %d s since %s: packet loss or a congested path)%s", i.Peak, i.Seconds, when, destText(i, "retransmissions"))
	case KindNetDrop:
		what = fmt.Sprintf("the kernel is dropping packets (%.0f in 10 s, %d s since %s; the reason names the fix: LISTEN_OVERFLOW is the server not accepting fast enough, NETFILTER_DROP a firewall rule, *NOROUTES the routing, *MEM memory)%s", i.Peak, i.Seconds, when, nameText(i, "drops"))
	case KindDNSFail:
		what = fmt.Sprintf("name lookups are failing (%.0f in 10 s, %d s since %s)%s", i.Peak, i.Seconds, when, nameText(i, "failures"))
	case KindDNSSlow:
		what = fmt.Sprintf("name lookups are slow (99%% resolved within %s, %d s since %s)%s", formatUs(i.Peak), i.Seconds, when, nameText(i, "lookup time"))
	case KindFileFail:
		what = fmt.Sprintf("file opens are failing (%.0f in 10 s, %d s since %s; EACCES / EPERM is a permission, EROFS a read-only mount, ENOSPC a full disk, EMFILE / ENFILE a file descriptor leak or limit)%s", i.Peak, i.Seconds, when, nameText(i, "failures"))
	case KindFsyncSlow:
		what = fmt.Sprintf("fsync is slow (99%% completed within %s, %d s since %s: the disk is stalling and whoever commits feels it)%s", formatUs(i.Peak), i.Seconds, when, nameText(i, "fsync time"))
	case KindLockWait:
		where := "its own locks"
		if len(i.Culprits) > 0 && i.Culprits[0].Name == "kernel lock" && i.Culprits[0].Share > 0.5 {
			where = "kernel locks (mmap_lock, inode locks)"
		}
		what = fmt.Sprintf("%s is waiting for locks (%.1f threads' worth of time blocked, %d s since %s, mostly %s; more CPUs will not help, the work serializes on a lock)", i.Subject, i.Peak, i.Seconds, when, where)
	case KindFaultStall:
		from := "file pages evicted from the page cache"
		if i.SwapShare > 0.5 {
			from = "swap"
		}
		what = fmt.Sprintf("processes are stalled reading their memory back from disk (%.0f ms/s in major page faults, %.0f%% of them from %s, %d s since %s)%s", i.Peak, i.SwapShare*100, from, i.Seconds, when, culpritText(i))
	case KindIRQBusy:
		what = fmt.Sprintf("%s spends %.0f%% of its time in interrupts (%d s since %s): one core takes the device's work; spread it with RSS / RPS / irqbalance%s", i.Subject, i.Peak*100, i.Seconds, when, nameText(i, "interrupt time"))
	case KindVRAMFull:
		what = fmt.Sprintf("VRAM is %.0f%% full (%d s since %s); the next large allocation may fail", i.Peak*100, i.Seconds, when)
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

// nameText renders "; mostly nope.invalid (NONAME) (80%)", or "" when no name stands out.
func nameText(i model.Incident, of string) string {
	if len(i.Culprits) == 0 {
		return ""
	}
	parts := make([]string, len(i.Culprits))
	for k, c := range i.Culprits {
		parts[k] = fmt.Sprintf("%s (%.0f%%)", c.Name, c.Share*100)
	}
	if len(parts) == 1 {
		return "; mostly " + parts[0]
	}
	return fmt.Sprintf("; mostly %s — %.0f%% of the %s", strings.Join(parts, ", "), i.CulpritShare*100, of)
}

// destText renders "; mostly to 10.0.0.5:5432 (80%) — 80% of the failures", or "" when no destination stands out.
func destText(i model.Incident, of string) string {
	if len(i.Culprits) == 0 {
		return ""
	}
	parts := make([]string, len(i.Culprits))
	for k, c := range i.Culprits {
		parts[k] = fmt.Sprintf("%s (%.0f%%)", c.Name, c.Share*100)
	}
	if len(parts) == 1 {
		return "; mostly to " + parts[0]
	}
	return fmt.Sprintf("; mostly to %s — %.0f%% of the %s", strings.Join(parts, ", "), i.CulpritShare*100, of)
}

// ioCulpritText renders "; I/O issued mostly by a (60%), b (25%) — 85% of the bytes", or "" when no one stands out.
func ioCulpritText(i model.Incident) string {
	if len(i.Culprits) == 0 {
		return ""
	}
	parts := make([]string, len(i.Culprits))
	for k, c := range i.Culprits {
		parts[k] = fmt.Sprintf("%s (%.0f%%)", c.Name, c.Share*100)
	}
	if len(parts) == 1 {
		return "; I/O issued mostly by " + parts[0]
	}
	return fmt.Sprintf("; I/O issued mostly by %s — %.0f%% of the bytes", strings.Join(parts, ", "), i.CulpritShare*100)
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

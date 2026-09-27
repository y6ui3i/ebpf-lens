// Package vm recognises virtual machines among the host's processes so their signals can be attributed to a VM
// name instead of a generic "qemu-system-x86". It reads /proc only; it does not talk to libvirt, so it works the
// same on libvirt, Proxmox, and hand-started QEMU.
package vm

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// Prefix marks a per-process stat that belongs to a VM ("vm:<name>" in ProcStat.Comm).
const Prefix = "vm:"

// IsQEMU reports whether a process name (as the kernel truncates it) is a QEMU machine emulator.
func IsQEMU(comm string) bool { return strings.HasPrefix(comm, "qemu-system") }

// ParseName extracts the VM name from a QEMU command line (NUL-separated, as /proc/<pid>/cmdline gives it).
// libvirt passes "-name guest=NAME,debug-threads=on"; Proxmox passes "-name NAME" (plus "-id N");
// a hand-started QEMU may pass nothing, in which case the name is "qemu-<pid>" chosen by the caller.
func ParseName(cmdline []byte) string {
	args := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
	for i, a := range args {
		if a != "-name" || i+1 >= len(args) {
			continue
		}
		v := args[i+1]
		for _, part := range strings.Split(v, ",") {
			if name, ok := strings.CutPrefix(part, "guest="); ok {
				return name
			}
		}
		return strings.SplitN(v, ",", 2)[0]
	}
	return ""
}

// Map is the live table of QEMU processes on this host.
type Map struct {
	mu      sync.RWMutex
	vms     map[uint32]model.VMInfo
	missing map[uint32]time.Time // pids not found by Scan, and since when
	proc    string               // "/proc", overridable for tests
	now     func() time.Time
}

// forgetAfter is how long a pid may be missing from /proc before Scan drops it. The exit event, which carries
// the VM tag, is drained within a second of the death; dropping earlier would strip the tag from that exit.
const forgetAfter = 30 * time.Second

func NewMap() *Map {
	return &Map{vms: map[uint32]model.VMInfo{}, missing: map[uint32]time.Time{}, proc: "/proc", now: time.Now}
}

// Label maps a process to the name its stats should be filed under: "vm:<name>" for a VM, else comm unchanged.
func (m *Map) Label(tgid uint32, comm string) string {
	m.mu.RLock()
	v, ok := m.vms[tgid]
	m.mu.RUnlock()
	if ok {
		return Prefix + v.Name
	}
	return comm
}

// Lookup returns the VM name for a pid, or "".
func (m *Map) Lookup(pid uint32) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.vms[pid].Name
}

// Remove forgets a pid (the process exited).
func (m *Map) Remove(pid uint32) {
	m.mu.Lock()
	delete(m.vms, pid)
	delete(m.missing, pid)
	m.mu.Unlock()
}

// List returns the running VMs sorted by name.
func (m *Map) List() []model.VMInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.VMInfo, 0, len(m.vms))
	for _, v := range m.vms {
		out = append(out, v)
	}
	sortByName(out)
	return out
}

// AddPid inspects one process by pid and records it if it is a QEMU. The start time comes from the process
// itself (via /proc/<pid>/stat is fiddly; the directory's ctime is close enough for "since when").
func (m *Map) AddPid(pid uint32) bool {
	dir := filepath.Join(m.proc, strconv.FormatUint(uint64(pid), 10))
	comm, err := os.ReadFile(filepath.Join(dir, "comm"))
	if err != nil || !IsQEMU(strings.TrimSpace(string(comm))) {
		return false
	}
	cmdline, err := os.ReadFile(filepath.Join(dir, "cmdline"))
	if err != nil {
		return false
	}
	name := ParseName(cmdline)
	if name == "" {
		name = "qemu-" + strconv.FormatUint(uint64(pid), 10)
	}
	since := time.Now()
	if st, err := os.Stat(dir); err == nil {
		since = st.ModTime()
	}
	m.mu.Lock()
	if old, ok := m.vms[pid]; ok {
		since = old.Since // keep the first observation
	}
	m.vms[pid] = model.VMInfo{Name: name, Pid: pid, Since: since}
	m.mu.Unlock()
	return true
}

// Scan walks /proc for QEMU processes that were already running when the agent started, or whose exec was
// missed. Entries whose process is gone are dropped only after forgetAfter (see above); normally the exit event
// removes them first. It is cheap: only the comm file is read for non-QEMU processes.
func (m *Map) Scan() {
	entries, err := os.ReadDir(m.proc)
	if err != nil {
		return
	}
	alive := map[uint32]bool{}
	for _, e := range entries {
		pid, err := strconv.ParseUint(e.Name(), 10, 32)
		if err != nil {
			continue
		}
		if m.AddPid(uint32(pid)) {
			alive[uint32(pid)] = true
		}
	}
	now := m.now()
	m.mu.Lock()
	for pid := range m.vms {
		if alive[pid] {
			delete(m.missing, pid)
			continue
		}
		since, seen := m.missing[pid]
		switch {
		case !seen:
			m.missing[pid] = now
		case now.Sub(since) > forgetAfter:
			delete(m.vms, pid)
			delete(m.missing, pid)
		}
	}
	m.mu.Unlock()
}

func sortByName(xs []model.VMInfo) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j].Name < xs[j-1].Name; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}

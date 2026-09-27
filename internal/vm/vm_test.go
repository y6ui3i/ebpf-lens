package vm

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseName(t *testing.T) {
	cases := map[string]string{
		"/usr/bin/qemu-system-x86_64\x00-name\x00guest=ebpflens-lab,debug-threads=on\x00-S\x00": "ebpflens-lab", // libvirt
		"/usr/bin/kvm\x00-id\x00101\x00-name\x00vm101,debug-threads=on\x00":                     "vm101",        // Proxmox
		"/usr/bin/qemu-system-x86_64\x00-name\x00plain\x00":                                     "plain",
		"/usr/bin/qemu-system-x86_64\x00-m\x001024\x00":                                         "",
		"/usr/bin/qemu-system-x86_64\x00-name\x00":                                              "",
	}
	for in, want := range cases {
		if got := ParseName([]byte(in)); got != want {
			t.Errorf("ParseName(%q) = %q, want %q", in, got, want)
		}
	}
}

// A fake /proc with one QEMU and one ordinary process.
func fakeProc(t *testing.T) string {
	root := t.TempDir()
	mk := func(pid, comm, cmdline string) {
		dir := filepath.Join(root, pid)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644)
		os.WriteFile(filepath.Join(dir, "cmdline"), []byte(cmdline), 0o644)
	}
	mk("4242", "qemu-system-x86", "/usr/bin/qemu-system-x86_64\x00-name\x00guest=web-02,debug-threads=on\x00")
	mk("4300", "bash", "bash\x00")
	return root
}

func TestScanAndLabel(t *testing.T) {
	m := NewMap()
	m.proc = fakeProc(t)
	m.Scan()
	if got := m.List(); len(got) != 1 || got[0].Name != "web-02" || got[0].Pid != 4242 {
		t.Fatalf("List() = %+v, want web-02 at pid 4242", got)
	}
	if m.Label(4242, "qemu-system-x86") != "vm:web-02" || m.Label(4300, "bash") != "bash" {
		t.Fatal("Label must rename QEMU stats and leave others alone")
	}
	// The VM dies. A rescan right after must keep it (its exit event, still to be drained, needs the tag);
	// only a rescan much later forgets it
	os.RemoveAll(filepath.Join(m.proc, "4242"))
	now := time.Now()
	m.now = func() time.Time { return now }
	m.Scan()
	if m.Lookup(4242) != "web-02" {
		t.Fatal("a pid that just vanished must survive the next scan so its exit can be tagged")
	}
	m.now = func() time.Time { return now.Add(forgetAfter + time.Second) }
	m.Scan()
	if len(m.List()) != 0 || m.Lookup(4242) != "" {
		t.Fatal("a pid missing for longer than forgetAfter must be dropped")
	}
}

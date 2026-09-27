package settings

import (
	"encoding/json"
	"testing"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/trigger"
)

type memStore struct{ body *string }

func (m *memStore) LoadSettings() (string, bool, error) {
	if m.body == nil {
		return "", false, nil
	}
	return *m.body, true, nil
}
func (m *memStore) SaveSettings(b string) error { m.body = &b; return nil }
func (m *memStore) DeleteSettings() error       { m.body = nil; return nil }

// Precedence: the file (base) applies until something is saved; a saved copy wins across restarts; reset drops it.
func TestSavedSettingsOverrideTheFileUntilReset(t *testing.T) {
	file := trigger.Default()
	file.CPU.Caution = 2_000 // "the -triggers file"
	db := &memStore{}
	var applied trigger.Config
	m, err := NewManager(Default(file), db, func(c trigger.Config) { applied = c })
	if err != nil {
		t.Fatal(err)
	}
	if m.Saved() || applied.CPU.Caution != 2_000 {
		t.Fatalf("fresh start must apply the file: saved=%v caution=%v", m.Saved(), applied.CPU.Caution)
	}

	s := m.Get()
	s.Triggers.CPU.Caution = 5_000
	s.UI.Lang = "ja"
	s.UI.VM.StoppedSeconds = 1800
	if err := m.Put(s); err != nil {
		t.Fatal(err)
	}
	if !m.Saved() || applied.CPU.Caution != 5_000 || db.body == nil {
		t.Fatalf("put must save and apply: saved=%v caution=%v body=%v", m.Saved(), applied.CPU.Caution, db.body != nil)
	}

	// A restart loads the saved copy over the file
	m2, err := NewManager(Default(file), db, func(c trigger.Config) { applied = c })
	if err != nil {
		t.Fatal(err)
	}
	if !m2.Saved() || m2.Get().UI.Lang != "ja" || applied.CPU.Caution != 5_000 {
		t.Fatalf("restart must use the saved copy: %+v", m2.Get())
	}

	if _, err := m2.Reset(); err != nil {
		t.Fatal(err)
	}
	if m2.Saved() || applied.CPU.Caution != 2_000 || m2.Get().UI.Lang != "" || db.body != nil {
		t.Fatalf("reset must go back to the file: %+v", m2.Get())
	}
}

func TestValidateRejectsNonsense(t *testing.T) {
	s := Default(trigger.Default())
	s.UI.VM.StoppedSeconds = 10
	s.UI.VM.AttentionSeconds = 20
	if err := s.Validate(); err == nil {
		t.Fatal("attention > stopped must be rejected")
	}
	s = Default(trigger.Default())
	s.UI.Lang = "fr"
	if err := s.Validate(); err == nil {
		t.Fatal("an unknown language must be rejected")
	}
	s = Default(trigger.Default())
	s.Triggers.CPU.Warning = 1
	if err := s.Validate(); err == nil {
		t.Fatal("warning below caution must be rejected (delegated to trigger.Config)")
	}
}

// A partial PUT body ("just the language") merges into the current settings; nothing else changes.
func TestPartialDocumentMergesOverCurrent(t *testing.T) {
	cur := Default(trigger.Default())
	cur.Triggers.CPU.Caution = 7_000
	if err := json.Unmarshal([]byte(`{"ui":{"lang":"ja"}}`), &cur); err != nil {
		t.Fatal(err)
	}
	if cur.UI.Lang != "ja" || cur.Triggers.CPU.Caution != 7_000 || cur.UI.VM.PastSeconds != 24*60*60 {
		t.Fatalf("merge: %+v", cur)
	}
}

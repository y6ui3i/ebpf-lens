// Package settings holds what the settings screen can change: the trigger thresholds and a few UI choices.
// Precedence: built-in defaults ← the -triggers file at startup ← what was saved from the screen (kept in the DB).
// Saving from the screen therefore overrides the file until "reset", which drops the saved copy.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/trigger"
)

// UI is what the browser needs from the server: the language everyone sees and the VM lifecycle bounds.
type UI struct {
	Lang string      `json:"lang"` // "en" | "ja" | "" (follow the browser)
	VM   VMLifecycle `json:"vm"`
}

// VMLifecycle bounds a stopped VM's life in the UI (see the manual, "A VM's life after it stops"), in seconds.
type VMLifecycle struct {
	AttentionSeconds int `json:"attentionSeconds"` // in the menu with its level mark
	StoppedSeconds   int `json:"stoppedSeconds"`   // under the menu's "Stopped (N)" fold
	PastSeconds      int `json:"pastSeconds"`      // in the list only
}

// Settings is everything the screen edits, as one JSON document.
type Settings struct {
	Triggers trigger.Config `json:"triggers"`
	UI       UI             `json:"ui"`
}

// Default returns the settings with the given trigger config (defaults, or the -triggers file) and the UI defaults.
func Default(triggers trigger.Config) Settings {
	return Settings{
		Triggers: triggers,
		UI:       UI{Lang: "", VM: VMLifecycle{AttentionSeconds: 5 * 60, StoppedSeconds: 60 * 60, PastSeconds: 24 * 60 * 60}},
	}
}

// Validate rejects what would make the screens or the rules meaningless.
func (s Settings) Validate() error {
	if err := s.Triggers.Validate(); err != nil {
		return err
	}
	switch s.UI.Lang {
	case "", "en", "ja":
	default:
		return fmt.Errorf("ui.lang must be \"en\", \"ja\" or empty")
	}
	v := s.UI.VM
	switch {
	case v.AttentionSeconds < 0 || v.StoppedSeconds < 0 || v.PastSeconds < 0:
		return errors.New("ui.vm: seconds must not be negative")
	case v.AttentionSeconds > v.StoppedSeconds || v.StoppedSeconds > v.PastSeconds:
		return errors.New("ui.vm: attention <= stopped <= past is required")
	case v.PastSeconds > 24*60*60:
		return errors.New("ui.vm: pastSeconds cannot exceed 24 hours (the UI holds a day of incidents)")
	}
	return nil
}

// Store is where the saved copy lives (the SQLite persister implements it). nil means nothing is saved.
type Store interface {
	LoadSettings() (body string, ok bool, err error)
	SaveSettings(body string) error
	DeleteSettings() error
}

// Manager serves the current settings and applies changes to the evaluator.
type Manager struct {
	mu    sync.RWMutex
	base  Settings // defaults (+ the -triggers file): what "reset" goes back to
	cur   Settings
	saved bool // whether cur came from the store
	db    Store
	apply func(trigger.Config)
}

// NewManager loads the saved copy (if any) over base and applies it.
func NewManager(base Settings, db Store, apply func(trigger.Config)) (*Manager, error) {
	m := &Manager{base: base, cur: base, db: db, apply: apply}
	if db != nil {
		body, ok, err := db.LoadSettings()
		if err != nil {
			return nil, err
		}
		if ok {
			s := base
			if err := json.Unmarshal([]byte(body), &s); err != nil {
				return nil, fmt.Errorf("saved settings: %w", err)
			}
			if err := s.Validate(); err != nil {
				return nil, fmt.Errorf("saved settings: %w", err)
			}
			m.cur, m.saved = s, true
		}
	}
	if apply != nil {
		apply(m.cur.Triggers)
	}
	return m, nil
}

// Get returns the current settings.
func (m *Manager) Get() Settings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cur
}

// Saved reports whether the current settings came from the store (as opposed to defaults or the file).
func (m *Manager) Saved() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.saved
}

// Put validates, saves and applies new settings.
func (m *Manager) Put(s Settings) error {
	if err := s.Validate(); err != nil {
		return err
	}
	body, err := json.Marshal(s)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.db != nil {
		if err := m.db.SaveSettings(string(body)); err != nil {
			return err
		}
	}
	m.cur, m.saved = s, m.db != nil
	if m.apply != nil {
		m.apply(s.Triggers)
	}
	return nil
}

// Reset drops the saved copy and goes back to the defaults (+ the -triggers file).
func (m *Manager) Reset() (Settings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.db != nil {
		if err := m.db.DeleteSettings(); err != nil {
			return m.cur, err
		}
	}
	m.cur, m.saved = m.base, false
	if m.apply != nil {
		m.apply(m.cur.Triggers)
	}
	return m.cur, nil
}

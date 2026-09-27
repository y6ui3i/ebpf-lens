package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// After saving, closing, and reopening, the history for the UI window is restored into the Store.
func TestSQLiteRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ebpflens.db")
	now := time.Now().Truncate(time.Millisecond)

	db, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	st := New(900, 1000)
	st.SetPersister(db)
	for i := range 3 {
		st.Add(model.Sample{Host: "h", Probe: "runqlat", Time: now.Add(time.Duration(i-3) * time.Second), Slots: []uint64{uint64(i), 1}})
	}
	st.AddEvents(model.EventBatch{Host: "h", Events: []model.ProcEvent{
		{Time: now.Add(-2 * time.Second), Kind: "exec", Pid: 10, Comm: "true", Filename: "/bin/true"},
		{Time: now.Add(-time.Second), Kind: "exit", Pid: 10, Comm: "true", LifetimeNs: 880_000},
	}})
	// A sample with the same timestamp is not inserted twice
	st.Add(model.Sample{Host: "h", Probe: "runqlat", Time: now.Add(-3 * time.Second), Slots: []uint64{9}})
	if err := db.Close(); err != nil { // Close flushes the rest of the queue
		t.Fatal(err)
	}

	db2, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	st2 := New(900, 1000)
	r, err := db2.LoadInto(context.Background(), st2, now.Add(-time.Minute), now.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if r.Samples != 3 || r.Events != 2 {
		t.Fatalf("loaded samples=%d events=%d, want 3 and 2", r.Samples, r.Events)
	}
	got := st2.Samples("h", "runqlat")
	if len(got) != 3 || got[0].Slots[0] != 0 || got[2].Slots[0] != 2 {
		t.Fatalf("samples out of order or wrong: %+v", got)
	}
	if ev := st2.Events("h"); ev[1].LifetimeNs != 880_000 {
		t.Fatalf("event body not restored: %+v", ev[1])
	}
	if h := st2.Hosts(); len(h) != 1 || !h[0].LastSeen.Equal(now.Add(-time.Second)) {
		t.Fatalf("lastSeen not restored: %+v", h)
	}
}

// Rows past the retention period are removed by the prune that runs on open.
func TestSQLitePrune(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ebpflens.db")
	db, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	db.SaveSample(model.Sample{Host: "h", Probe: "runqlat", Time: old, Slots: []uint64{1}})
	db.SaveSample(model.Sample{Host: "h", Probe: "runqlat", Time: time.Now(), Slots: []uint64{1}})
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db2, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour) // prune runs right after opening
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	var count int
	deadline := time.Now().Add(2 * time.Second)
	for {
		if err := db2.db.QueryRow(`SELECT COUNT(*) FROM samples`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if count != 1 {
		t.Fatalf("samples after prune = %d, want 1", count)
	}
}

// An incident is one row updated in place; one still open at shutdown is restored as closed at its last update.
func TestSQLiteIncidentUpsertAndRestore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ebpflens.db")
	now := time.Now().Truncate(time.Millisecond)
	db, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	st := New(900, 1000)
	st.SetPersister(db)
	inc := model.Incident{ID: "h|cpu_wait||1", Host: "h", Kind: "cpu_wait", Level: "caution", Start: now.Add(-20 * time.Second), Updated: now.Add(-18 * time.Second), Seconds: 3, Peak: 2000}
	st.AddIncident(inc)
	inc.Level, inc.Seconds, inc.Peak, inc.Updated = "warning", 10, 16000, now.Add(-10*time.Second)
	st.AddIncident(inc) // progress: same ID, escalated
	end := now.Add(-5 * time.Second)
	closed := model.Incident{ID: "h|crash|7|2", Host: "h", Kind: "crash", Level: "caution", Subject: "flaky", Start: end, End: &end, Updated: end}
	st.AddIncident(closed)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db2, err := OpenSQLite(path, time.Hour, time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	st2 := New(900, 1000)
	r, err := db2.LoadInto(context.Background(), st2, now.Add(-time.Minute), now.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	got := st2.Incidents("h")
	if r.Incidents != 2 || len(got) != 2 {
		t.Fatalf("restored %d incidents (%d in store), want 2", r.Incidents, len(got))
	}
	cpu := got[0]
	if cpu.ID != inc.ID || cpu.Level != "warning" || cpu.Peak != 16000 {
		t.Fatalf("upsert did not keep the latest state: %+v", cpu)
	}
	if cpu.Ongoing() || !cpu.End.Equal(inc.Updated) {
		t.Fatalf("an incident open at shutdown must be restored closed at its last update, got end=%v", cpu.End)
	}
	if got[1].ID != closed.ID || got[1].Ongoing() {
		t.Fatalf("closed incident not restored as closed: %+v", got[1])
	}
	var n int
	if err := db2.db.QueryRow(`SELECT COUNT(*) FROM incidents`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("incident rows = %d (%v), want 2 (upsert, not insert)", n, err)
	}
}

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite" // pure Go driver with no cgo, so the project can still ship as a single binary

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// SQL is limited to syntax that works on both SQLite and PostgreSQL (so we can move to PostgreSQL once it grows).
//   - Timestamps are integer Unix milliseconds, so differences in date types do not get in the way
//   - The body is JSON text. When moving to PostgreSQL, make it jsonb
//   - No SQLite-specific syntax such as INSERT OR REPLACE (ON CONFLICT exists in both)
//   - The ? placeholders become $1 and so on in PostgreSQL
const schema = `
CREATE TABLE IF NOT EXISTS samples (
	host  TEXT   NOT NULL,
	probe TEXT   NOT NULL,
	ts_ms BIGINT NOT NULL,
	body  TEXT   NOT NULL,
	PRIMARY KEY (host, probe, ts_ms)
);
CREATE TABLE IF NOT EXISTS events (
	host  TEXT   NOT NULL,
	ts_ms BIGINT NOT NULL,
	kind  TEXT   NOT NULL,
	pid   BIGINT NOT NULL,
	comm  TEXT   NOT NULL,
	body  TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS events_host_ts ON events (host, ts_ms);
CREATE TABLE IF NOT EXISTS incidents (
	id       TEXT   PRIMARY KEY,
	host     TEXT   NOT NULL,
	kind     TEXT   NOT NULL,
	level    TEXT   NOT NULL,
	start_ms BIGINT NOT NULL,
	end_ms   BIGINT,
	body     TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_host_start ON incidents (host, start_ms);
CREATE TABLE IF NOT EXISTS settings (
	key  TEXT PRIMARY KEY,
	body TEXT NOT NULL
);
`

// SQLite is a Persister that writes samples and events to SQLite.
// Writes are queued in the order received and written together in one transaction every second.
type SQLite struct {
	db                *sql.DB
	queue             chan any // model.Sample, model.EventBatch or model.Incident
	retention         time.Duration
	eventRetention    time.Duration
	incidentRetention time.Duration
	dropped           atomic.Uint64
	done              chan struct{}
	wg                sync.WaitGroup
}

const (
	queueSize     = 4096
	flushInterval = time.Second
	pruneInterval = 10 * time.Minute
)

// OpenSQLite opens the DB at path (creating it if missing) and starts the writer goroutine.
// path must be on a local disk of the monitored host (over NFS, locking is unreliable and the DB can be corrupted).
func OpenSQLite(path string, retention, eventRetention, incidentRetention time.Duration) (*SQLite, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // a single writer, matching SQLite's single-writer model
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	s := &SQLite{
		db: db, queue: make(chan any, queueSize),
		retention: retention, eventRetention: eventRetention, incidentRetention: incidentRetention,
		done: make(chan struct{}),
	}
	s.wg.Add(1)
	go s.loop()
	return s, nil
}

// The settings document saved from the settings screen (see internal/settings). One row, written synchronously:
// it changes once in a blue moon and the caller wants to know it is on disk.
const settingsKey = "settings"

func (s *SQLite) LoadSettings() (string, bool, error) {
	var body string
	err := s.db.QueryRow(`SELECT body FROM settings WHERE key = ?`, settingsKey).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return body, err == nil, err
}

func (s *SQLite) SaveSettings(body string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body`, settingsKey, body)
	return err
}

func (s *SQLite) DeleteSettings() error {
	_, err := s.db.Exec(`DELETE FROM settings WHERE key = ?`, settingsKey)
	return err
}

// SaveSample and SaveEvents drop and count items when the queue is full, so HTTP ingestion is never blocked.
func (s *SQLite) SaveSample(x model.Sample) { s.enqueue(x) }

func (s *SQLite) SaveEvents(b model.EventBatch) {
	if len(b.Events) > 0 {
		s.enqueue(b)
	}
}

// SaveIncident upserts by ID, so an incident is one row that is updated as it progresses.
func (s *SQLite) SaveIncident(i model.Incident) { s.enqueue(i) }

func (s *SQLite) enqueue(v any) {
	select {
	case s.queue <- v:
	default:
		s.dropped.Add(1)
	}
}

func (s *SQLite) loop() {
	defer s.wg.Done()
	flush := time.NewTicker(flushInterval)
	prune := time.NewTicker(pruneInterval)
	defer flush.Stop()
	defer prune.Stop()
	s.prune()
	for {
		select {
		case <-s.done:
			s.flush()
			return
		case <-flush.C:
			s.flush()
			if n := s.dropped.Swap(0); n > 0 {
				log.Printf("sqlite: queue full, dropped %d items", n)
			}
		case <-prune.C:
			s.prune()
		}
	}
}

// flush writes everything accumulated in the queue in one transaction.
func (s *SQLite) flush() {
	var items []any
drain:
	for len(items) < queueSize {
		select {
		case v := <-s.queue:
			items = append(items, v)
		default:
			break drain
		}
	}
	if len(items) == 0 {
		return
	}
	if err := s.write(items); err != nil {
		log.Printf("sqlite: write %d items: %v", len(items), err)
	}
}

func (s *SQLite) write(items []any) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	insSample, err := tx.Prepare(`INSERT INTO samples (host, probe, ts_ms, body) VALUES (?, ?, ?, ?)
		ON CONFLICT (host, probe, ts_ms) DO NOTHING`)
	if err != nil {
		return err
	}
	insEvent, err := tx.Prepare(`INSERT INTO events (host, ts_ms, kind, pid, comm, body) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	upsertIncident, err := tx.Prepare(`INSERT INTO incidents (id, host, kind, level, start_ms, end_ms, body) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET level = excluded.level, end_ms = excluded.end_ms, body = excluded.body`)
	if err != nil {
		return err
	}
	for _, v := range items {
		switch x := v.(type) {
		case model.Sample:
			body, err := json.Marshal(x)
			if err != nil {
				return err
			}
			if _, err := insSample.Exec(x.Host, x.Probe, x.Time.UnixMilli(), string(body)); err != nil {
				return err
			}
		case model.EventBatch:
			for _, e := range x.Events {
				body, err := json.Marshal(e)
				if err != nil {
					return err
				}
				if _, err := insEvent.Exec(x.Host, e.Time.UnixMilli(), e.Kind, e.Pid, e.Comm, string(body)); err != nil {
					return err
				}
			}
		case model.Incident:
			body, err := json.Marshal(x)
			if err != nil {
				return err
			}
			var end any // NULL while ongoing
			if x.End != nil {
				end = x.End.UnixMilli()
			}
			if _, err := upsertIncident.Exec(x.ID, x.Host, x.Kind, x.Level, x.Start.UnixMilli(), end, string(body)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// prune deletes rows older than the retention period.
func (s *SQLite) prune() {
	now := time.Now()
	for _, q := range []struct {
		sql    string
		before time.Time
	}{
		{`DELETE FROM samples WHERE ts_ms < ?`, now.Add(-s.retention)},
		{`DELETE FROM events WHERE ts_ms < ?`, now.Add(-s.eventRetention)},
		// Ongoing incidents are never pruned, however old their start is
		{`DELETE FROM incidents WHERE end_ms IS NOT NULL AND start_ms < ?`, now.Add(-s.incidentRetention)},
	} {
		if _, err := s.db.Exec(q.sql, q.before.UnixMilli()); err != nil {
			log.Printf("sqlite: prune: %v", err)
		}
	}
}

// Restored counts what LoadInto put back into the Store.
type Restored struct{ Samples, Events, Incidents int }

// LoadInto restores samples and events since `since` (the UI's live window), plus incidents that ended since
// `incidentsSince` (the UI's incident list covers a day) or were still open, into the in-memory Store. It exists so
// the UI survives a server restart; call it before any subscribers attach. Incidents that were still open are
// closed at their last update: the rule state that kept them open did not survive the restart, and a stale
// "ongoing" would be a lie.
func (s *SQLite) LoadInto(ctx context.Context, st *Store, since, incidentsSince time.Time) (Restored, error) {
	var r Restored
	rows, err := s.db.QueryContext(ctx, `SELECT body FROM samples WHERE ts_ms >= ? ORDER BY ts_ms`, since.UnixMilli())
	if err != nil {
		return r, err
	}
	for rows.Next() {
		var body string
		var x model.Sample
		if err := rows.Scan(&body); err != nil {
			rows.Close()
			return r, err
		}
		if err := json.Unmarshal([]byte(body), &x); err != nil {
			rows.Close()
			return r, err
		}
		st.add(x, false)
		r.Samples++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT host, body FROM events WHERE ts_ms >= ? ORDER BY ts_ms`, since.UnixMilli())
	if err != nil {
		return r, err
	}
	byHost := map[string][]model.ProcEvent{}
	for rows.Next() {
		var host, body string
		var e model.ProcEvent
		if err := rows.Scan(&host, &body); err != nil {
			rows.Close()
			return r, err
		}
		if err := json.Unmarshal([]byte(body), &e); err != nil {
			rows.Close()
			return r, err
		}
		byHost[host] = append(byHost[host], e)
		r.Events++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, err
	}
	for host, es := range byHost {
		st.addEvents(model.EventBatch{Host: host, Events: es}, false)
	}

	rows, err = s.db.QueryContext(ctx, `SELECT body FROM incidents WHERE end_ms IS NULL OR end_ms >= ? ORDER BY start_ms`, incidentsSince.UnixMilli())
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		var inc model.Incident
		if err := rows.Scan(&body); err != nil {
			return r, err
		}
		if err := json.Unmarshal([]byte(body), &inc); err != nil {
			return r, err
		}
		if inc.End == nil {
			end := inc.Updated
			inc.End = &end
			s.enqueue(inc) // write the closed state back
		}
		st.addIncident(inc, false)
		r.Incidents++
	}
	return r, rows.Err()
}

// Close flushes the remaining items and then closes the DB.
func (s *SQLite) Close() error {
	close(s.done)
	s.wg.Wait()
	return s.db.Close()
}

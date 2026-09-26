package store

import (
	"context"
	"database/sql"
	"encoding/json"
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
`

// SQLite is a Persister that writes samples and events to SQLite.
// Writes are queued in the order received and written together in one transaction every second.
type SQLite struct {
	db             *sql.DB
	queue          chan any // model.Sample or model.EventBatch
	retention      time.Duration
	eventRetention time.Duration
	dropped        atomic.Uint64
	done           chan struct{}
	wg             sync.WaitGroup
}

const (
	queueSize     = 4096
	flushInterval = time.Second
	pruneInterval = 10 * time.Minute
)

// OpenSQLite opens the DB at path (creating it if missing) and starts the writer goroutine.
// path must be on a local disk of the monitored host (over NFS, locking is unreliable and the DB can be corrupted).
func OpenSQLite(path string, retention, eventRetention time.Duration) (*SQLite, error) {
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
		retention: retention, eventRetention: eventRetention,
		done: make(chan struct{}),
	}
	s.wg.Add(1)
	go s.loop()
	return s, nil
}

// SaveSample and SaveEvents drop and count items when the queue is full, so HTTP ingestion is never blocked.
func (s *SQLite) SaveSample(x model.Sample) { s.enqueue(x) }

func (s *SQLite) SaveEvents(b model.EventBatch) {
	if len(b.Events) > 0 {
		s.enqueue(b)
	}
}

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
	} {
		if _, err := s.db.Exec(q.sql, q.before.UnixMilli()); err != nil {
			log.Printf("sqlite: prune: %v", err)
		}
	}
}

// LoadInto reads samples and events since the given time and restores them into the in-memory Store.
// It exists so the UI history survives a server restart; call it before any subscribers attach.
func (s *SQLite) LoadInto(ctx context.Context, st *Store, since time.Time) (samples, events int, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT body FROM samples WHERE ts_ms >= ? ORDER BY ts_ms`, since.UnixMilli())
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var body string
		var x model.Sample
		if err := rows.Scan(&body); err != nil {
			rows.Close()
			return samples, events, err
		}
		if err := json.Unmarshal([]byte(body), &x); err != nil {
			rows.Close()
			return samples, events, err
		}
		st.add(x, false)
		samples++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return samples, events, err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT host, body FROM events WHERE ts_ms >= ? ORDER BY ts_ms`, since.UnixMilli())
	if err != nil {
		return samples, events, err
	}
	defer rows.Close()
	byHost := map[string][]model.ProcEvent{}
	for rows.Next() {
		var host, body string
		var e model.ProcEvent
		if err := rows.Scan(&host, &body); err != nil {
			return samples, events, err
		}
		if err := json.Unmarshal([]byte(body), &e); err != nil {
			return samples, events, err
		}
		byHost[host] = append(byHost[host], e)
		events++
	}
	for host, es := range byHost {
		st.addEvents(model.EventBatch{Host: host, Events: es}, false)
	}
	return samples, events, rows.Err()
}

// Close flushes the remaining items and then closes the DB.
func (s *SQLite) Close() error {
	close(s.done)
	s.wg.Wait()
	return s.db.Close()
}

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

	_ "modernc.org/sqlite" // cgo 不要の pure Go ドライバ。単一バイナリで配れる性質を崩さない

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// SQL は SQLite と PostgreSQL の両方で動く書き方に限る(大きくなったら PostgreSQL に移すため)。
//   - 時刻は整数の Unix ミリ秒。日付型の違いに引きずられない
//   - 本体は JSON のテキスト。PostgreSQL に移すときは jsonb にする
//   - INSERT OR REPLACE のような SQLite 独自の構文は使わない(ON CONFLICT は両方にある)
//   - プレースホルダの ? は、PostgreSQL では $1 に置き換える
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

// SQLite はサンプルとイベントを SQLite に書く Persister。
// 書き込みは受け付けた順にキューへ積み、1 秒ごとに 1 トランザクションでまとめて書く。
type SQLite struct {
	db             *sql.DB
	queue          chan any // model.Sample か model.EventBatch
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

// OpenSQLite は path の DB を開き(無ければ作り)、書き込み用の goroutine を始める。
// path は監視対象と同じホストのローカルディスクに置くこと(NFS 越しではロックが当てにならず壊れうる)。
func OpenSQLite(path string, retention, eventRetention time.Duration) (*SQLite, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // 書き手は 1 つ。SQLite の単一ライターに合わせる
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

// SaveSample と SaveEvents は HTTP の受信を止めないよう、キューが満杯なら捨てて数える。
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
				log.Printf("sqlite: キューが満杯で %d 件を捨てた", n)
			}
		case <-prune.C:
			s.prune()
		}
	}
}

// flush はキューに溜まった分を 1 トランザクションで書く。
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

// prune は保持期間を過ぎた行を消す。
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

// LoadInto は since 以降のサンプルとイベントを読み、メモリ上の Store に戻す。
// サーバーを再起動しても画面の履歴が消えないようにするため、購読者が付く前に呼ぶ。
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

// Close は残りを書き切ってから閉じる。
func (s *SQLite) Close() error {
	close(s.done)
	s.wg.Wait()
	return s.db.Close()
}

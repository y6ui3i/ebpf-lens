// ebpflens-server はエージェントからサンプルを受け取り、API・SSE・フロントを配信する。
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/server"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/store"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/webui"
)

func main() {
	addr := flag.String("addr", ":8080", "待ち受けアドレス")
	keep := flag.Int("keep", 900, "ホスト×プローブごとに保持するサンプル数")
	keepEvents := flag.Int("keep-events", 20000, "ホストごとに保持するイベント数")
	dbPath := flag.String("db", "", "SQLite の保存先(空なら保存しない)。監視対象のローカルディスクに置く")
	retention := flag.Duration("retention", 24*time.Hour, "サンプルを DB に残す期間")
	eventRetention := flag.Duration("event-retention", 7*24*time.Hour, "イベントを DB に残す期間")
	flag.Parse()

	st := store.New(*keep, *keepEvents)
	if *dbPath != "" {
		db, err := store.OpenSQLite(*dbPath, *retention, *eventRetention)
		if err != nil {
			log.Fatalf("sqlite: %v", err)
		}
		// 画面の窓(直近 keep 秒)ぶんの履歴を戻してから、保存を始める
		since := time.Now().Add(-time.Duration(*keep) * time.Second)
		n, m, err := db.LoadInto(context.Background(), st, since)
		if err != nil {
			log.Fatalf("sqlite: load: %v", err)
		}
		log.Printf("sqlite: %s から履歴を戻した(サンプル %d 件、イベント %d 件)", *dbPath, n, m)
		st.SetPersister(db)
		// 終了時にキューの残りを書き切る
		go func() {
			sig := make(chan os.Signal, 1)
			signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
			<-sig
			if err := db.Close(); err != nil {
				log.Printf("sqlite: close: %v", err)
			}
			os.Exit(0)
		}()
	}
	mux := http.NewServeMux()
	server.Register(mux, st)
	mux.Handle("/", webui.Handler())

	log.Printf("ebpflens-server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

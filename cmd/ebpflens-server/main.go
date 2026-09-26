// ebpflens-server receives samples from agents and serves the API, SSE, and the frontend.
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
	addr := flag.String("addr", ":8080", "listen address")
	keep := flag.Int("keep", 900, "number of samples to keep per host × probe")
	keepEvents := flag.Int("keep-events", 20000, "number of events to keep per host")
	dbPath := flag.String("db", "", "SQLite file path (empty disables persistence). Place it on a local disk of the monitored machine")
	retention := flag.Duration("retention", 24*time.Hour, "how long to keep samples in the DB")
	eventRetention := flag.Duration("event-retention", 7*24*time.Hour, "how long to keep events in the DB")
	flag.Parse()

	st := store.New(*keep, *keepEvents)
	if *dbPath != "" {
		db, err := store.OpenSQLite(*dbPath, *retention, *eventRetention)
		if err != nil {
			log.Fatalf("sqlite: %v", err)
		}
		// Restore enough history to fill the UI window (the last keep seconds), then start persisting
		since := time.Now().Add(-time.Duration(*keep) * time.Second)
		n, m, err := db.LoadInto(context.Background(), st, since)
		if err != nil {
			log.Fatalf("sqlite: load: %v", err)
		}
		log.Printf("sqlite: restored history from %s (%d samples, %d events)", *dbPath, n, m)
		st.SetPersister(db)
		// On shutdown, flush whatever is left in the queue
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

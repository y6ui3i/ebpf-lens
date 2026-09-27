// ebpflens-server receives samples from agents and serves the API, SSE, and the frontend.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/server"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/store"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/trigger"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/webui"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	keep := flag.Int("keep", 900, "number of samples to keep per host × probe")
	keepEvents := flag.Int("keep-events", 20000, "number of events to keep per host")
	dbPath := flag.String("db", "", "SQLite file path (empty disables persistence). Place it on a local disk of the monitored machine")
	retention := flag.Duration("retention", 24*time.Hour, "how long to keep samples in the DB")
	eventRetention := flag.Duration("event-retention", 7*24*time.Hour, "how long to keep events in the DB")
	incidentRetention := flag.Duration("incident-retention", 30*24*time.Hour, "how long to keep closed incidents in the DB")
	triggersPath := flag.String("triggers", "", "JSON file with trigger thresholds (defaults are used for anything not set)")
	printTriggers := flag.Bool("print-triggers", false, "print the default trigger thresholds as JSON and exit")
	webhook := flag.String("webhook", "", "URL to POST incident transitions (open / escalate / close) to")
	webhookFormat := flag.String("webhook-format", "generic", "webhook payload: generic (full JSON), slack, or discord")
	flag.Parse()

	if *printTriggers {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(trigger.Default()); err != nil {
			log.Fatal(err)
		}
		return
	}
	triggers := trigger.Default()
	if *triggersPath != "" {
		var err error
		if triggers, err = trigger.Load(*triggersPath); err != nil {
			log.Fatalf("triggers: %v", err)
		}
		log.Printf("triggers: loaded %s", *triggersPath)
	}

	st := store.New(*keep, *keepEvents)
	if *dbPath != "" {
		db, err := store.OpenSQLite(*dbPath, *retention, *eventRetention, *incidentRetention)
		if err != nil {
			log.Fatalf("sqlite: %v", err)
		}
		// Restore enough history to fill the UI window (the last keep seconds), then start persisting
		since := time.Now().Add(-time.Duration(*keep) * time.Second)
		r, err := db.LoadInto(context.Background(), st, since)
		if err != nil {
			log.Fatalf("sqlite: load: %v", err)
		}
		log.Printf("sqlite: restored history from %s (%d samples, %d events, %d incidents)", *dbPath, r.Samples, r.Events, r.Incidents)
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
	// Judge live data on the server; incidents go to the store (and from there to the DB, SSE, and hooks)
	ev := trigger.New(triggers, st)
	for _, h := range st.Hosts() { // so a host that is still silent after a restart is flagged, not forgotten
		ev.MarkSeen(h.Name, h.LastSeen)
	}
	st.AddObserver(ev)
	go ev.Run(context.Background())
	if *webhook != "" {
		n, err := trigger.NewNotifier(*webhook, *webhookFormat)
		if err != nil {
			log.Fatalf("webhook: %v", err)
		}
		st.OnIncident(n.OnIncident)
		log.Printf("webhook: notifying %s (%s)", *webhook, *webhookFormat)
	}

	mux := http.NewServeMux()
	server.Register(mux, st, triggers)
	mux.Handle("/", webui.Handler())

	log.Printf("ebpflens-server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

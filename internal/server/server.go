// Package server provides the HTTP API of ebpflens-server.
package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/store"
)

const maxSlots = 64

// Register registers the handlers under /api/ on mux.
//
//	POST /api/ingest                  receive samples from agents
//	GET  /api/hosts                   list hosts
//	GET  /api/samples?host=&probe=    history
//	POST /api/events                  receive events from agents
//	GET  /api/events?host=            event history
//	GET  /api/stream?host=            SSE of new data (event: sample / events)
func Register(mux *http.ServeMux, st *store.Store) {
	mux.HandleFunc("POST /api/ingest", func(w http.ResponseWriter, r *http.Request) {
		var x model.Sample
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&x); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if x.Host == "" || x.Probe == "" || len(x.Slots) == 0 || len(x.Slots) > maxSlots {
			http.Error(w, "host, probe, slots(1..64) are required", http.StatusBadRequest)
			return
		}
		if x.Time.IsZero() {
			x.Time = time.Now()
		}
		st.Add(x)
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("POST /api/events", func(w http.ResponseWriter, r *http.Request) {
		var b model.EventBatch
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&b); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if b.Host == "" {
			http.Error(w, "host is required", http.StatusBadRequest)
			return
		}
		st.AddEvents(b)
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, st.Events(r.URL.Query().Get("host")))
	})

	mux.HandleFunc("GET /api/hosts", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, st.Hosts())
	})

	mux.HandleFunc("GET /api/samples", func(w http.ResponseWriter, r *http.Request) {
		probe := r.URL.Query().Get("probe")
		if probe == "" {
			probe = "runqlat"
		}
		writeJSON(w, st.Samples(r.URL.Query().Get("host"), probe))
	})

	mux.HandleFunc("GET /api/stream", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		ch, cancel := st.Subscribe(r.URL.Query().Get("host"))
		defer cancel()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Send a comment line periodically so intermediate proxies do not cut the connection
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
			case m := <-ch:
				b, err := json.Marshal(m.Data)
				if err != nil {
					log.Printf("stream: %v", err)
					continue
				}
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m.Name, b)
			}
			flusher.Flush()
		}
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

// Package server provides the HTTP API of ebpflens-server.
package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/settings"
	"github.com/y6ui3i/ebpf-lens/internal/store"
	"github.com/y6ui3i/ebpf-lens/internal/trigger"
)

const maxSlots = 64

// Register registers the handlers under /api/ on mux.
//
//	POST /api/ingest                  receive samples from agents
//	GET  /api/hosts                   list hosts
//	GET  /api/samples?host=&probe=    history
//	POST /api/events                  receive events from agents
//	GET  /api/events?host=            event history
//	GET  /api/incidents?host=         incidents, newest first (ongoing ones have no "end")
//	GET  /api/triggers                the thresholds the server judges with (the UI draws its bands from them)
//	GET  /api/settings                thresholds and UI settings (the settings screen); PUT replaces them, DELETE resets to defaults / the file
//	GET  /api/stream?host=            SSE of new data (event: sample / events / incident)
func Register(mux *http.ServeMux, st *store.Store, sm *settings.Manager) {
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

	mux.HandleFunc("GET /api/incidents", func(w http.ResponseWriter, r *http.Request) {
		xs := st.Incidents(r.URL.Query().Get("host"))
		trigger.SortIncidents(xs)
		writeJSON(w, xs)
	})

	mux.HandleFunc("GET /api/triggers", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, sm.Get().Triggers)
	})

	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, settingsResponse{Settings: sm.Get(), Saved: sm.Saved()})
	})
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		s := sm.Get() // fields the client leaves out keep their current value
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&s); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := sm.Put(s); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, settingsResponse{Settings: sm.Get(), Saved: sm.Saved()})
	})
	mux.HandleFunc("DELETE /api/settings", func(w http.ResponseWriter, r *http.Request) {
		s, err := sm.Reset()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, settingsResponse{Settings: s, Saved: false})
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

// settingsResponse is the settings document plus where it came from (saved from the screen, or defaults / the file).
type settingsResponse struct {
	settings.Settings
	Saved bool `json:"saved"`
}

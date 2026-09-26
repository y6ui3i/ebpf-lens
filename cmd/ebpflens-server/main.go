// ebpflens-server はエージェントからサンプルを受け取り、API・SSE・フロントを配信する。
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/server"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/store"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/webui"
)

func main() {
	addr := flag.String("addr", ":8080", "待ち受けアドレス")
	keep := flag.Int("keep", 900, "ホスト×プローブごとに保持するサンプル数")
	flag.Parse()

	st := store.New(*keep)
	mux := http.NewServeMux()
	server.Register(mux, st)
	mux.Handle("/", webui.Handler())

	log.Printf("ebpflens-server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

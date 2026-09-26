.PHONY: all vmlinux generate build agent server types web install clean

# フロントのビルド(make web)は Node のあるマシンで行い、
# Go のビルド(make build)は監視対象と同じ Linux で行う。
all: web build

# 実行中カーネルの BTF から CO-RE 用ヘッダを作る
bpf/headers/vmlinux.h:
	mkdir -p bpf/headers
	bpftool btf dump file /sys/kernel/btf/vmlinux format c > $@

vmlinux: bpf/headers/vmlinux.h

generate: bpf/headers/vmlinux.h
	go generate ./internal/probe/...

build: agent server

agent: generate
	go build -o bin/ebpflens-agent ./cmd/ebpflens-agent

server:
	go build -o bin/ebpflens-server ./cmd/ebpflens-server

# Go の共有型から TS の型を生成する
types:
	go tool tygo generate

# frontend/ をビルドして internal/webui/dist に出す(server に埋め込まれる)
web: types
	cd frontend && npm ci && npm run build

# 常駐用のバイナリとユニットを入れる(反映は sudo systemctl restart ebpflens-server ebpflens-agent)。
# 開発中の bin/ を直接動かさないのは、ビルドし直すたびに常駐中のサービスが差し替わらないようにするため
install: build
	sudo install -d /opt/ebpflens/bin
	sudo install -m 0755 bin/ebpflens-agent bin/ebpflens-server /opt/ebpflens/bin/
	sudo install -m 0644 deploy/systemd/ebpflens-server.service deploy/systemd/ebpflens-agent.service /etc/systemd/system/
	sudo systemctl daemon-reload

clean:
	rm -rf bin bpf/headers/vmlinux.h internal/probe/*/*_bpfel.go internal/probe/*/*_bpfel.o
	find internal/webui/dist -mindepth 1 ! -name .gitkeep -delete

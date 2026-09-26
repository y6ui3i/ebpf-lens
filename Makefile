.PHONY: all vmlinux generate build clean

all: build

# 実行中カーネルの BTF から CO-RE 用ヘッダを作る
bpf/headers/vmlinux.h:
	mkdir -p bpf/headers
	bpftool btf dump file /sys/kernel/btf/vmlinux format c > $@

vmlinux: bpf/headers/vmlinux.h

generate: bpf/headers/vmlinux.h
	go generate ./...

build: generate
	go build -o bin/ebpflens-agent ./cmd/ebpflens-agent

clean:
	rm -rf bin bpf/headers/vmlinux.h internal/probe/*/*_bpfel.go internal/probe/*/*_bpfel.o

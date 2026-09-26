.PHONY: all vmlinux generate build agent server types web install clean

# Build the frontend (make web) on a machine with Node,
# and build Go (make build) on the same Linux as the monitored host.
all: web build

# Generate the CO-RE header from the running kernel's BTF
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

# Generate TS types from the shared Go types
types:
	go tool tygo generate

# Build frontend/ into internal/webui/dist (embedded into the server)
web: types
	cd frontend && npm ci && npm run build

# Install the binaries and units for the resident services (apply with sudo systemctl restart ebpflens-server ebpflens-agent).
# The services do not run bin/ directly so that every rebuild during development does not swap out the running services
install: build
	sudo install -d /opt/ebpflens/bin
	sudo install -m 0755 bin/ebpflens-agent bin/ebpflens-server /opt/ebpflens/bin/
	sudo install -m 0644 deploy/systemd/ebpflens-server.service deploy/systemd/ebpflens-agent.service /etc/systemd/system/
	sudo systemctl daemon-reload

clean:
	rm -rf bin bpf/headers/vmlinux.h internal/probe/*/*_bpfel.go internal/probe/*/*_bpfel.o
	find internal/webui/dist -mindepth 1 ! -name .gitkeep -delete

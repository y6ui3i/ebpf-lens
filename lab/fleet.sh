#!/bin/sh
# A fleet of small test VMs (libvirt / KVM) to try the VM screens and noisy-neighbour scenarios at scale.
# Shares the base image and ssh key of lab/create-vm.sh (run that once first).
#
#   sh lab/fleet.sh up 10          # create and start ebpflens-fleet-01..10 (1 GB, 2 vCPUs each)
#   sh lab/fleet.sh ssh 3 "cmd"    # run a command inside VM 03
#   sh lab/fleet.sh ips            # print name and IP of each fleet VM
#   sh lab/fleet.sh down           # destroy and undefine every fleet VM and delete its disk
set -eu

DIR=${LAB_DIR:-/var/lib/libvirt/images/ebpflens-lab}
MEM_MB=${FLEET_MEM_MB:-1024}
CPUS=${FLEET_CPUS:-2}
V="virsh -c qemu:///system"
SSH_OPTS="-i $DIR/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"

name() { printf 'ebpflens-fleet-%02d' "$1"; }

vm_ip() {
	$V domifaddr "$1" 2>/dev/null | awk '/ipv4/ {split($4, a, "/"); print a[1]}'
}

case "${1:-}" in
up)
	n=${2:-10}
	[ -f "$DIR/base.img" ] || { echo "run lab/create-vm.sh once first (base image and key)" >&2; exit 1; }
	mkdir -p "$DIR/fleet"
	i=1
	while [ "$i" -le "$n" ]; do
		nm=$(name "$i")
		if ! $V dominfo "$nm" >/dev/null 2>&1; then
			d="$DIR/fleet/$nm"
			mkdir -p "$d"
			qemu-img create -q -f qcow2 -F qcow2 -b "$DIR/base.img" "$d/disk.qcow2" 10G
			cat > "$d/user-data" <<EOC
#cloud-config
hostname: $nm
users:
  - name: lab
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$DIR/id_ed25519.pub")
packages: [stress-ng]
EOC
			printf "instance-id: %s-1\nlocal-hostname: %s\n" "$nm" "$nm" > "$d/meta-data"
			cloud-localds "$d/seed.iso" "$d/user-data" "$d/meta-data"
			virt-install --connect qemu:///system --name "$nm" --memory "$MEM_MB" --vcpus "$CPUS" \
				--disk path="$d/disk.qcow2",format=qcow2,bus=virtio --disk path="$d/seed.iso",device=cdrom \
				--import --osinfo detect=on,require=off --network network=default --graphics none --noautoconsole >/dev/null
		else
			$V start "$nm" >/dev/null 2>&1 || true
		fi
		i=$((i + 1))
	done
	echo "started $n VMs"
	;;
ssh)
	nm=$(name "$2"); shift 2
	ip=$(vm_ip "$nm")
	[ -n "$ip" ] || { echo "$nm has no IP yet" >&2; exit 1; }
	exec ssh $SSH_OPTS "lab@$ip" "$@"
	;;
ips)
	for nm in $($V list --all --name | grep '^ebpflens-fleet-'); do
		echo "$nm $(vm_ip "$nm")"
	done
	;;
down)
	for nm in $($V list --all --name | grep '^ebpflens-fleet-'); do
		$V destroy "$nm" >/dev/null 2>&1 || true
		$V undefine "$nm" >/dev/null 2>&1 || true
	done
	rm -rf "$DIR/fleet"
	echo "fleet removed"
	;;
*)
	echo "usage: $0 up [n] | ssh i cmd | ips | down" >&2
	exit 1
	;;
esac

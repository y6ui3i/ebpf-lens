#!/bin/sh
# Create a test VM (libvirt / KVM) to trigger memory shortage, OOM and the like on a real kernel
# without disturbing the host.
#
#   sh lab/create-vm.sh            # create and start (just start if it already exists)
#   sh lab/create-vm.sh ssh        # log in to the VM
#   sh lab/create-vm.sh push       # copy bin/ebpflens-agent into the VM
#   virsh -c qemu:///system shutdown ebpflens-lab   # stop it (the disk is kept)
#
# Requires: qemu-system-x86 libvirt-daemon-system virtinst cloud-image-utils, and membership in the libvirt group.
# Set LAB_DIR to keep the VM files somewhere other than the default.
set -eu

NAME=ebpflens-lab
DIR=${LAB_DIR:-/var/lib/libvirt/images/$NAME}
MEM_MB=${LAB_MEM_MB:-1024} # keep it small so a machine-wide shortage (direct reclaim / OOM) is easy to trigger
CPUS=${LAB_CPUS:-2}
IMG_URL=https://cloud-images.ubuntu.com/resolute/current/resolute-server-cloudimg-amd64.img
V="virsh -c qemu:///system"
SSH_OPTS="-i $DIR/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

vm_ip() {
	$V domifaddr "$NAME" 2>/dev/null | awk '/ipv4/ {split($4, a, "/"); print a[1]}'
}

wait_ip() {
	for _ in $(seq 1 60); do
		ip=$(vm_ip)
		[ -n "$ip" ] && { echo "$ip"; return; }
		sleep 3
	done
	echo "could not get the VM IP address" >&2
	exit 1
}

# Right after boot the IP from the previous DHCP lease comes back immediately, but sshd is not up yet.
# Wait until we can actually log in.
wait_ssh() {
	ip=$(wait_ip)
	for _ in $(seq 1 60); do
		ssh $SSH_OPTS -o ConnectTimeout=3 "lab@$ip" true 2>/dev/null && { echo "$ip"; return; }
		sleep 3
	done
	echo "cannot ssh to $ip" >&2
	exit 1
}

case "${1:-create}" in
ssh)
	shift
	exec ssh $SSH_OPTS "lab@$(wait_ssh)" "$@"
	;;
push)
	scp -q $SSH_OPTS bin/ebpflens-agent "lab@$(wait_ssh):"
	echo "copied bin/ebpflens-agent"
	exit 0
	;;
esac

if $V dominfo "$NAME" >/dev/null 2>&1; then
	$V start "$NAME" 2>/dev/null || true
	echo "$NAME: $(wait_ssh)"
	exit 0
fi

[ -d "$DIR" ] || sudo install -d -o "$(id -un)" -g "$(id -gn)" "$DIR"
cd "$DIR"
if [ ! -f base.img ]; then
	curl -s -o base.img "$IMG_URL"
	# Verify against the official SHA256SUMS
	sum=$(curl -s "${IMG_URL%/*}/SHA256SUMS" | awk '/resolute-server-cloudimg-amd64.img$/ {print $1}')
	echo "$sum  base.img" | sha256sum -c -
fi
[ -f id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "$NAME" -f id_ed25519
qemu-img create -q -f qcow2 -F qcow2 -b "$DIR/base.img" disk.qcow2 10G

cat > user-data <<EOF
#cloud-config
hostname: $NAME
users:
  - name: lab
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat id_ed25519.pub)
package_update: true
packages: [stress-ng]
EOF
printf "instance-id: %s-1\nlocal-hostname: %s\n" "$NAME" "$NAME" > meta-data
cloud-localds seed.iso user-data meta-data

# No swap: only the page cache can be reclaimed, which makes direct reclaim easy to trigger
virt-install --connect qemu:///system --name "$NAME" --memory "$MEM_MB" --vcpus "$CPUS" \
	--disk path="$DIR/disk.qcow2",format=qcow2,bus=virtio --disk path="$DIR/seed.iso",device=cdrom \
	--import --osinfo detect=on,require=off --network network=default --graphics none --noautoconsole

ip=$(wait_ip)
for _ in $(seq 1 60); do
	ssh $SSH_OPTS -o ConnectTimeout=5 "lab@$ip" "cloud-init status --wait" >/dev/null 2>&1 && break
	sleep 5
done
echo "$NAME: $ip"

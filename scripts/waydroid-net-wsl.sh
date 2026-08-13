#!/bin/sh -
# Version WSL : le noyau Waydroid-WSL n'a pas CONFIG_BRIDGE, on utilise donc
# une paire veth + NAT statique au lieu du bridge waydroid0 + dnsmasq.
# Remplacé par le banc de test : voir scripts/TEST-BENCH.md

varrun="/run/waydroid-lxc"
LXC_BRIDGE="waydroid0"
LXC_VETH_PEER="waydroid1"
LXC_ADDR="192.168.240.1"
LXC_NETWORK="192.168.240.0/24"
LXC_BRIDGE_MAC="00:16:3e:00:00:01"

IPTABLES_BIN="$(command -v iptables-legacy)"
[ -n "$IPTABLES_BIN" ] || IPTABLES_BIN="$(command -v iptables)"

start() {
    [ ! -d "${varrun}" ] && mkdir -p "${varrun}"
    [ -f "${varrun}/network_up" ] && { echo "waydroid-net is already running"; exit 0; }

    if [ ! -d /sys/class/net/${LXC_BRIDGE} ]; then
        ip link add dev ${LXC_BRIDGE} type veth peer name ${LXC_VETH_PEER} || exit 1
    fi
    ip link set dev ${LXC_BRIDGE} address ${LXC_BRIDGE_MAC}
    ip link set dev ${LXC_BRIDGE} up
    ip link set dev ${LXC_VETH_PEER} up
    ip addr replace ${LXC_ADDR}/24 dev ${LXC_BRIDGE}
    echo 1 > /proc/sys/net/ipv4/ip_forward
    ${IPTABLES_BIN} -t nat -C POSTROUTING -s ${LXC_NETWORK} ! -d ${LXC_NETWORK} -j MASQUERADE 2>/dev/null || \
        ${IPTABLES_BIN} -t nat -A POSTROUTING -s ${LXC_NETWORK} ! -d ${LXC_NETWORK} -j MASQUERADE
    touch "${varrun}/network_up"
    echo "waydroid-net up (veth sans bridge)"
}

stop() {
    ${IPTABLES_BIN} -t nat -D POSTROUTING -s ${LXC_NETWORK} ! -d ${LXC_NETWORK} -j MASQUERADE 2>/dev/null
    [ -d /sys/class/net/${LXC_BRIDGE} ] && ip link del dev ${LXC_BRIDGE} 2>/dev/null
    rm -f "${varrun}/network_up"
}

case "$1" in
    start) start ;;
    stop|force) stop ;;
    *) echo "usage: $0 start|stop" >&2; exit 1 ;;
esac

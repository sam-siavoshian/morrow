# Stand-in for an engineer VM (freestyle/ubuntu is Ubuntu 24.04) with systemd as PID 1, for the Relay node
# layout proof (test/vm/relay-node-docker.test.ts). Build context: backend/vm.
# The relay step of golden-setup.sh runs for real here (pinned installer, sudo), so a cached layer is the
# golden image's Relay install. python3 runs the fake coding CLIs only.
FROM ubuntu:24.04
RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    systemd systemd-sysv dbus ca-certificates curl git procps python3 util-linux >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/systemd/system/*.wants/* /lib/systemd/system/multi-user.target.wants/* \
    /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev* \
    /lib/systemd/system/sockets.target.wants/*initctl* /lib/systemd/system/sysinit.target.wants/systemd-tmpfiles-setup*
COPY golden-setup.sh /tmp/golden-setup.sh
RUN MORROW_GOLDEN_STEP=relay bash /tmp/golden-setup.sh && rm -f /tmp/golden-setup.sh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

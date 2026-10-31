# Stand-in for an engineer VM (freestyle/ubuntu is Ubuntu 24.04) for the git.sh proof.
# python3 and openssl serve the fake GitHub only; git.sh itself needs bash, git and util-linux.
FROM ubuntu:24.04
RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates openssl python3 procps >/dev/null \
  && rm -rf /var/lib/apt/lists/*

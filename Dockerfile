# =============================================================================
# Multi-stage Dockerfile for qemu-ppc-screamer with noVNC
#
# Builds an optimized QEMU PPC (Screamer audio) binary and bundles it with
# a noVNC web interface for browser-based access to the emulated display.
#
# Usage:
#   docker build -t qemu-screamer .
#   docker run -it -p 6080:6080 -v /path/to/disk.iso:/data/disk.iso qemu-screamer
#
# Then open http://localhost:6080 in a browser.
#
# Written by claud-4.6-opus-high
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Builder
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        ccache \
        flex \
        bison \
        git \
        ninja-build \
        pkg-config \
        python3 \
        python3-pip \
        python3-setuptools \
        python3-venv \
        python3-wheel \
        python3-distutils-extra \
        # QEMU core dependencies
        libglib2.0-dev \
        libpixman-1-dev \
        libfdt-dev \
        zlib1g-dev \
        # VNC / display
        libepoxy-dev \
        libjpeg-turbo8-dev \
        libpng-dev \
        libgbm-dev \
        libdrm-dev \
        # Networking (slirp for user-mode NAT)
        libslirp-dev \
        # SDL2 (useful if running outside VNC too)
        libsdl2-dev \
        libsdl2-image-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --recurse-submodules -j8 -b screamer https://github.com/mcayland/qemu /src
WORKDIR /src

# Configure: PPC softmmu only, optimised, with VNC + SDL + slirp networking
RUN ./configure \
        --disable-werror \
        --target-list=ppc-softmmu \
        --without-default-features \
        --enable-tcg \
        --enable-fdt \
        --enable-slirp \
        --enable-vnc \
        --enable-vnc-jpeg \
        --enable-sdl \
        --enable-opengl \
        --disable-docs \
        --disable-guest-agent \
        --disable-tools \
        --audio-drv-list=sdl \
        --extra-cflags="-O2 -g0" \
        --extra-ldflags="-O2"

RUN make -j"$(nproc)"

# ---------------------------------------------------------------------------
# Stage 2: Runtime with noVNC
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries matching the build, plus noVNC prereqs
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        libglib2.0-0 \
        libpixman-1-0 \
        libfdt1 \
        zlib1g \
        libepoxy0 \
        libjpeg-turbo8 \
        libpng16-16 \
        libgbm1 \
        libdrm2 \
        libslirp0 \
        libsdl2-2.0-0 \
        libsdl2-image-2.0-0 \
        # websockify (Python) for noVNC → VNC proxying
        python3 \
        python3-numpy \
        python3-pip \
        # Useful utilities
        procps \
        net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install websockify
RUN pip3 install --break-system-packages --no-cache-dir websockify

# noVNC customizations (kept in source control as standalone files)
COPY novnc/index.html /tmp/novnc-index.html
COPY novnc/pointer-lock.js /tmp/novnc-pointer-lock.js
COPY novnc/qemu-audio.js /tmp/novnc-qemu-audio.js

# Install noVNC (auto-connect + pointer lock + QEMU audio enabled by default)
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC && \
    rm -rf /opt/noVNC/.git && \
    cp /tmp/novnc-index.html /opt/noVNC/index.html && \
    cp /tmp/novnc-pointer-lock.js /opt/noVNC/app/pointer-lock.js && \
    cp /tmp/novnc-qemu-audio.js /opt/noVNC/app/qemu-audio.js && \
    sed -i '/<\/body>/i <script src="app/qemu-audio.js"><\/script>' /opt/noVNC/vnc.html && \
    sed -i '/<\/body>/i <script src="app/pointer-lock.js"><\/script>' /opt/noVNC/vnc.html


COPY patch-rfb.py /tmp/patch-rfb.py
RUN python3 /tmp/patch-rfb.py && rm /tmp/patch-rfb.py

# --- Copy built artefacts from the builder stage ---
COPY --from=builder /src/build/qemu-system-ppc /usr/local/bin/qemu-system-ppc

# pc-bios firmware / ROM files needed for PPC Mac emulation
COPY --from=builder /src/pc-bios/openbios-ppc        /usr/local/share/qemu/openbios-ppc
COPY --from=builder /src/pc-bios/qemu_vga.ndrv       /usr/local/share/qemu/qemu_vga.ndrv
COPY --from=builder /src/pc-bios/vgabios-stdvga.bin   /usr/local/share/qemu/vgabios-stdvga.bin
COPY --from=builder /src/pc-bios/vgabios.bin          /usr/local/share/qemu/vgabios.bin
COPY --from=builder /src/pc-bios/keymaps               /usr/local/share/qemu/keymaps

# Optional: copy all pc-bios for broader compatibility
# COPY --from=builder /src/pc-bios /usr/local/share/qemu

# Create a data directory for disk images
RUN mkdir -p /data

# ---------------------------------------------------------------------------
# Entrypoint script
# ---------------------------------------------------------------------------
COPY <<'ENTRYPOINT_SCRIPT' /usr/local/bin/entrypoint.sh
#!/bin/bash
set -e

# ---- Defaults (overridable via environment) ----
: "${VNC_PORT:=5900}"
: "${NOVNC_PORT:=6080}"
: "${QEMU_RAM:=512}"
: "${QEMU_RES:=640x480x32}"
: "${QEMU_CPU:=G4}"
: "${QEMU_MACHINE:=mac99,via=pmu-adb}"
: "${DISK_IMAGE:=/data/disk.iso}"

echo "=============================================="
echo "  qemu-ppc-screamer + noVNC"
echo "=============================================="
echo "  noVNC URL  : http://localhost:${NOVNC_PORT}"
echo "  VNC port   : ${VNC_PORT}"
echo "  Disk image : ${DISK_IMAGE}"
echo "  RAM        : ${QEMU_RAM}M"
echo "  Resolution : ${QEMU_RES}"
echo "=============================================="

# Start noVNC (websockify) in the background
# It serves the noVNC web client and proxies WebSocket traffic to QEMU's VNC
/opt/noVNC/utils/novnc_proxy \
    --vnc localhost:${VNC_PORT} \
    --listen ${NOVNC_PORT} \
    &
NOVNC_PID=$!

# Give noVNC a moment to start
sleep 1

# Build QEMU arguments
QEMU_ARGS=(
    -display "vnc=:0"
    -L /usr/local/share/qemu
    -boot c
    -M "${QEMU_MACHINE}"
    -m "${QEMU_RAM}"
    -g "${QEMU_RES}"
    -cpu "${QEMU_CPU}"
    -prom-env 'auto-boot?=true'
    -prom-env 'boot-args=-v'
    -prom-env 'vga-ndrv?=true'
    -drive "file=${DISK_IMAGE},format=raw,media=disk"
    -netdev user,id=br0
    -device sungem,netdev=br0
    -device usb-mouse
    -parallel none
    -serial stdio
)

# Append any extra QEMU arguments passed to the container
if [ $# -gt 0 ]; then
    QEMU_ARGS+=("$@")
fi

echo ""
echo "Starting QEMU..."
echo "  qemu-system-ppc ${QEMU_ARGS[*]}"
echo ""

exec qemu-system-ppc "${QEMU_ARGS[@]}"
ENTRYPOINT_SCRIPT

RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose noVNC web port and VNC port
EXPOSE 6080
EXPOSE 5900

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

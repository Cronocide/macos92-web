# MacOS 9.2 - Web

A containerised QEMU PowerPC (Mac99) emulator with _"Screamer"_ audio support, accessible via a browser-based noVNC interface. Boot classic Mac OS disk images directly from Docker and use your browser to control them.

[![Build Status](https://jenkins.cronocide.net/buildStatus/icon?job=git.cronocide.net%2Fmacos92-web%2Fmaster&subject=Jenkins%20Build)](https://jenkins.cronocide.net/job/git.cronocide.net/job/macos92-web/job/master/)


## Quick Start

```bash
docker run -it \
  -p 6080:6080 \
  -v /path/to/disk.iso:/data/disk.iso \
  git.cronocide.net/cronocide/macos92-web:latest
```

Then open **http://localhost:6080** in your browser.

## Environment Variables

All environment variables are optional and have the following defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `VNC_PORT` | `5900` | Port QEMU's built-in VNC server listens on inside the container. Also the port noVNC proxies to. |
| `NOVNC_PORT` | `6080` | Port the noVNC web server listens on inside the container. Map this to the host with `-p`. |
| `QEMU_RAM` | `512` | Amount of guest RAM in megabytes. |
| `QEMU_RES` | `640x480x32` | Guest display resolution in `WIDTHxHEIGHTxDEPTH` format. |
| `QEMU_CPU` | `G4` | Emulated CPU model (e.g. `G4`, `G3`, `750`, `7400`). |
| `QEMU_MACHINE` | `mac99,via=pmu-adb` | QEMU machine type and options. `mac99` is the New World Mac platform; `via=pmu-adb` enables ADB input via the PMU. |
| `DISK_IMAGE` | `/data/disk.iso` | Path to the disk image file inside the container. |

### Example with custom settings

```bash
docker run -it \
  -p 8080:8080 \
  -v ~/macos9.iso:/data/disk.iso \
  -e NOVNC_PORT=8080 \
  -e QEMU_RAM=256 \
  -e QEMU_RES=800x600x32 \
  -e QEMU_CPU=G3 \
  git.cronocide.net/cronocide/macos92-web:latest
```

## Extra QEMU Arguments

Any arguments passed after the image name are appended to the QEMU command line. This lets you add devices, drives, or any other QEMU option:

```bash
docker run -it \
  -p 6080:6080 \
  -v /path/to/disk.iso:/data/disk.iso \
  git.cronocide.net/cronocide/macos92-web:latest \
  -cdrom /data/installer.iso
```

## noVNC Web Interface

The browser UI auto-connects and provides two extensions on top of stock noVNC:

### Audio Streaming

QEMU's VNC audio extension (Screamer) streams audio from the emulated machine to your browser via the Web Audio API. A floating speaker button appears in the bottom-right corner of the page:

| Icon | State |
|------|-------|
| 🔇 | Audio disabled — click to enable |
| 🔈 | Audio enabled, waiting for stream |
| 🔊 | Audio playing |

Audio is enabled automatically on first user interaction (click, keypress, or touch) to comply with browser autoplay policies. You can toggle it at any time with the speaker button.

**Disable audio** by appending `?audio=0` to the URL:
```
http://localhost:6080/vnc.html?autoconnect=true&audio=0
```

## Additional Features

### Pointer Lock (Relative Mouse)

Mac OS 9 uses a relative (ADB) mouse with no USB tablet driver. Stock noVNC sends absolute coordinates which causes the cursor to "hit a wall" at the canvas edge. The pointer-lock extension solves this:

- **Click the canvas** to capture the mouse (pointer lock).
- While captured, mouse movement is sent as relative deltas directly over VNC.
- **Press Escape** to release the mouse.

**Disable pointer lock** by appending `?pointer_lock=0` to the URL:
```
http://localhost:6080/vnc.html?autoconnect=true&pointer_lock=0
```

## Networking

The container configures QEMU with user-mode (slirp) NAT networking by default, providing the guest with outbound internet access via the host's network. The guest-side NIC is a Sun GEM (`sungem`) adapter.

## Building Locally

```bash
docker build -t qemu-screamer .
docker run -it -p 6080:6080 -v /path/to/disk.iso:/data/disk.iso qemu-screamer
```

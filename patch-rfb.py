import sys, os

# Patch noVNC's core/rfb.js:
#   (a) encoding -259 in the client's SetEncodings list,
#   (b) case-255 handler in _normalMsg for QEMU server messages,
#   (c) case -259 guard before _handleDataRect for the audio-ack pseudo-rect,
#   (d) gracefully skip SetColorMapEntries (Mac OS 9 sends colour-map updates
#       during 8-bit boot splash even though noVNC negotiates true-colour).

path = '/opt/noVNC/core/rfb.js'
with open(path) as f:
    lines = f.readlines()

out = []
did_enc = did_msg = did_rect = did_cmap = False

for i, line in enumerate(lines):
    # (a) Add QEMU Audio encoding & expose RFB instance right before
    #     the RFB.messages.clientEncodings() call inside _sendEncodings().
    if (not did_enc
            and 'clientEncodings' in line
            and '_sock' in line
            and 'encs' in line):
        indent = line[:len(line) - len(line.lstrip())]
        out.append(indent + 'encs.push(-259); // QEMU Audio encoding\n')
        out.append(indent + 'window.__qemuRFB = this; // expose for audio extension\n')
        did_enc = True

    # (b) Add case 255 (QEMU server msg) before _normalMsg's default case.
    #     Identified by "default:" whose next few lines reference "msgType".
    #     NOTE: _normalMsg already consumed the type byte via rQshift8(),
    #     so the handler receives the buffer AFTER the type byte.
    if (not did_msg and line.strip() == 'default:'):
        ctx = ''.join(lines[i:min(i + 5, len(lines))])
        if 'msgType' in ctx:
            ind = line[:len(line) - len(line.lstrip())]
            out.append(ind + 'case 255: // QEMU (type byte already consumed)\n')
            out.append(ind + '    if (window.__qemuAudioHandler) return window.__qemuAudioHandler(this);\n')
            out.append(ind + '    if (this._sock.rQlen >= 3) { this._sock.rQskipBytes(3); return true; }\n')
            out.append(ind + '    return false;\n')
            out.append('\n')
            did_msg = True

    # (c) Intercept the -259 (audio ack) pseudo-rect BEFORE it reaches
    #     _handleDataRect().  _framebufferUpdate()'s while-loop already
    #     does  rects--  and  encoding = null  after _handleRect() returns,
    #     so we must NOT touch _FBU state — just return true.
    if (not did_rect
            and '_handleDataRect' in line
            and 'this.' in line
            and ('return' in line or '=' in line)):
        ind = line[:len(line) - len(line.lstrip())]
        out.append(ind + '// QEMU Audio ack pseudo-rect (-259) — no payload\n')
        out.append(ind + 'if (this._FBU.encoding === -259) { return true; }\n')
        did_rect = True

    # (d) Replace the call to _handleSetColourMapMsg() in _normalMsg
    #     with an inline handler that silently skips the message.
    #     _normalMsg already consumed the type byte (1) via rQshift8(),
    #     so the buffer now starts at:
    #       pad(1) + firstColour(2) + numColours(2) + colours(N*6)
    #     = 5 + numColours*6 remaining bytes.
    if (not did_cmap
            and '_handleSetColourMapMsg' in line
            and ('return' in line or 'this.' in line)):
        ind = line[:len(line) - len(line.lstrip())]
        out.append(ind + '// [patched] Skip SetColorMapEntries (Mac OS 9 8-bit boot)\n')
        out.append(ind + '{ if (this._sock.rQlen < 5) return false;\n')
        out.append(ind + '  const _rQ = this._sock._rQ, _ri = this._sock._rQi;\n')
        out.append(ind + '  const _nc = (_rQ[_ri + 3] << 8) | _rQ[_ri + 4];\n')
        out.append(ind + '  const _total = 5 + _nc * 6;\n')
        out.append(ind + '  if (this._sock.rQlen < _total) return false;\n')
        out.append(ind + '  this._sock.rQskipBytes(_total); return true; }\n')
        did_cmap = True
        continue   # skip the original line (the call to _handleSetColourMapMsg)

    out.append(line)

with open(path, 'w') as f:
    f.writelines(out)

tags = f'enc={did_enc} msg255={did_msg} rect259={did_rect} cmap={did_cmap}'
print(f'Patched {path}: {tags}')
if not (did_enc and did_msg):
    print('FATAL: Could not apply critical audio patches to rfb.js!',
          file=sys.stderr)
    sys.exit(1)
if not did_rect:
    print('WARNING: rect-encoding patch for -259 not applied.')
    print('  The QEMU audio-ack pseudo-rect may cause a noVNC error.')
if not did_cmap:
    print('WARNING: SetColorMapEntries patch not applied.')
    print('  Mac OS 9 8-bit boot splash may crash the VNC connection.')
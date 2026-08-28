"""
WHIP/WHEP server — zero-transcode, low-latency, perfect quality

Architecture
─────────────
OBS (H264) ──WHIP──► PassthroughH264Decoder ──av.Packet──► MediaRelay
                                                                │
                                      ┌─────────────────────────┘
                                      ▼
                               H264Encoder.pack()  ←── re-packetise only, NO re-encode
                                      │
                                   WHEP ──► Browser

Why this matters
─────────────────
The previous approach (decode → raw YUV frames → libx264 re-encode) caused:
  • Quality drops: every transcode cycle degrades the image
  • "non-existing PPS 0" loop: libx264 context reset loses SPS/PPS
  • Latency >1 s: encode pipeline adds 300-800 ms even on localhost

PassthroughH264Decoder returns av.Packet directly.
RTCRtpSender._run_rtp() detects non-Frame objects and routes them to
H264Encoder.pack() which only re-packetises NAL units into RTP chunks —
no FFmpeg encode, no quality loss, ~150-250 ms total latency on localhost.

SPS/PPS handling
─────────────────
OBS sends SPS+PPS once (in the first keyframe or via sprop-parameter-sets
in the WHIP SDP). The patched get_decoder() extracts them and loads them
into PassthroughH264Decoder. Before each IDR frame that lacks inline SPS/PPS
the decoder prepends them, so the browser can decode from frame 1.
"""

# ── Patch aiortc BEFORE any connection is created ─────────────────────────────
import aiortc.codecs.h264      as _h264_mod
import aiortc.codecs.vpx       as _vpx_mod
import aiortc.codecs           as _ac_mod
import aiortc.rtcrtpreceiver   as _recv_mod

# Lift bitrate caps (updated again in main() with actual user args)
_h264_mod.MIN_BITRATE     = 1_000_000
_h264_mod.MAX_BITRATE     = 20_000_000
_h264_mod.DEFAULT_BITRATE = 8_000_000
_h264_mod.MAX_FRAME_RATE  = 60

_vpx_mod.MIN_BITRATE     = 1_000_000
_vpx_mod.MAX_BITRATE     = 20_000_000
_vpx_mod.DEFAULT_BITRATE = 8_000_000

# Better H264 encoder context — used only for RTMP / file sources that
# can't passthrough (they supply raw YUV frames, not H264 packets).
def _hq_create_encoder_context(codec_name: str, width: int, height: int, bitrate: int):
    import av as _av, fractions as _fr
    try:
        codec = _av.CodecContext.create(codec_name, "w")
    except Exception:
        codec_name = "libx264"
        codec = _av.CodecContext.create("libx264", "w")
    codec.width     = width
    codec.height    = height
    codec.bit_rate  = bitrate
    codec.pix_fmt   = "yuv420p"
    codec.framerate = _fr.Fraction(_h264_mod.MAX_FRAME_RATE, 1)
    codec.time_base = _fr.Fraction(1, _h264_mod.MAX_FRAME_RATE)
    opts = {"tune": "zerolatency"}
    if "libx264" in codec_name:
        opts.update({"profile": "high", "level": "52", "preset": "ultrafast"})
    codec.options = opts
    return codec, False

_h264_mod.create_encoder_context = _hq_create_encoder_context

# ── PassthroughH264Decoder ────────────────────────────────────────────────────
import av as _av_mod

class _PassthroughH264Decoder:
    """
    Return assembled H264 data as av.Packet instead of decoding to raw frames.

    RTCRtpSender._run_rtp() checks isinstance(data, av.frame.Frame):
      - Frame  → encoder.encode()  (re-encode with libx264 — what we AVOID)
      - Packet → encoder.pack()    (re-packetise NAL units for RTP — what we WANT)

    SPS+PPS from sprop-parameter-sets are stored and prepended to IDR frames
    that don't already contain them, preventing "non-existing PPS 0" errors.

    Does NOT inherit H264Decoder to avoid creating an unused FFmpeg decode context.
    Instantiated directly in _get_decoder_with_params() so the passthrough is
    guaranteed regardless of how aiortc's internal get_decoder() resolves H264Decoder.
    """

    def __init__(self):
        self._param_sets = b""  # Annex-B SPS+PPS from OBS SDP

    def _load_param_sets(self, annex_b: bytes) -> None:
        self._param_sets = annex_b

    @staticmethod
    def _has_nal(data: bytes, nal_type: int) -> bool:
        """Check if Annex-B buffer contains a NAL unit of nal_type."""
        i = 0
        while i < len(data) - 3:
            if data[i:i+4] == b'\x00\x00\x00\x01':
                i += 4
            elif data[i:i+3] == b'\x00\x00\x01':
                i += 3
            else:
                i += 1
                continue
            if i < len(data) and (data[i] & 0x1F) == nal_type:
                return True
        return False

    def decode(self, encoded_frame):
        data = encoded_frame.data

        # Prepend SPS+PPS when an IDR frame arrives without them
        if (self._param_sets
                and self._has_nal(data, 5)       # IDR (keyframe)
                and not self._has_nal(data, 7)):  # no SPS present
            data = self._param_sets + data

        pkt           = _av_mod.Packet(data)
        pkt.pts       = encoded_frame.timestamp
        pkt.dts       = encoded_frame.timestamp
        pkt.time_base = _h264_mod.VIDEO_TIME_BASE   # 1/90000
        return [pkt]


# ── PassthroughOpusDecoder ────────────────────────────────────────────────────
import aiortc.codecs.opus as _opus_mod


class _PassthroughOpusDecoder:
    """
    Return Opus payloads as av.Packet instead of decoding them to PCM.

    Without this, audio takes the decode -> re-encode path, and aiortc's
    OpusEncoder is hardcoded to OPUS_APPLICATION_VOIP: a speech-tuned mode that
    band-limits the signal and collapses music to something that sounds like
    low-bitrate mono. It also never sets a target bitrate, so libopus picks its
    conservative VoIP default.

    OBS already sends Opus, so there is nothing to gain from re-encoding it.
    RTCRtpSender routes non-Frame objects to OpusEncoder.pack(), which just
    hands the payload back untouched — bit-exact passthrough of OBS's audio.
    """

    def decode(self, encoded_frame):
        pkt = _av_mod.Packet(encoded_frame.data)
        pkt.pts = encoded_frame.timestamp
        pkt.dts = encoded_frame.timestamp
        pkt.time_base = _opus_mod.TIME_BASE   # 1/48000
        return [pkt]


# Register for get_decoder("video/h264")
_ac_mod.H264Decoder = _PassthroughH264Decoder

# ── Patch get_decoder to inject sprop-parameter-sets into the passthrough ─────
# decoder_worker() in rtcrtpreceiver references get_decoder as a module global,
# so patching _recv_mod.get_decoder affects every decoder thread.
import base64 as _b64

_orig_get_decoder = _recv_mod.get_decoder

def _get_decoder_with_params(codec):
    # For H264 always use our passthrough directly — avoids relying on aiortc's
    # internal name binding (which may have already captured the original H264Decoder
    # class before we patched _ac_mod.H264Decoder).
    if codec.mimeType.lower() == "video/h264":
        decoder = _PassthroughH264Decoder()
        sprop = (codec.parameters or {}).get("sprop-parameter-sets", "")
        if sprop:
            annex_b = b""
            for ps in sprop.split(","):
                ps = ps.strip()
                if ps:
                    try:
                        annex_b += b"\x00\x00\x00\x01" + _b64.b64decode(ps)
                    except Exception:
                        pass
            if annex_b:
                decoder._load_param_sets(annex_b)
        return decoder
    if codec.mimeType.lower() == "audio/opus":
        return _PassthroughOpusDecoder()
    return _orig_get_decoder(codec)

_recv_mod.get_decoder = _get_decoder_with_params

# ── Patch 5: Large JitterBuffer for high-bitrate video ────────────────────────
# aiortc's default video JitterBuffer has capacity=128 RTP packets.
# At ≥20 Mbps a single H264 IDR frame spans 500–2000+ packets, which overflows
# the 128-slot ring buffer.  When that happens aiortc:
#   1. discards the incomplete frame
#   2. sends a PLI (picture-loss) to the ingest (OBS)
#   3. OBS replies with a new IDR… which also overflows → infinite PLI loop
# Result: 1 partial/corrupt frame every ~2 seconds (keyframe interval).
# Fix: expand the video buffer to 4096 slots (handles up to ~4.9 MB per frame).
_OrigJitterBuffer = _recv_mod.JitterBuffer   # already imported in that module

class _LargeVideoJitterBuffer(_OrigJitterBuffer):
    def __init__(self, capacity: int, prefetch: int = 0, is_video: bool = False):
        if is_video:
            capacity = 4096   # power-of-2; handles IDR frames at 50 Mbps / 30 fps
        super().__init__(capacity, prefetch, is_video)

_recv_mod.JitterBuffer = _LargeVideoJitterBuffer

# ── Patch 7: advertise stereo Opus ────────────────────────────────────────────
# aiortc declares audio/opus with no fmtp parameters at all. RFC 7587 defaults
# sprop-stereo to 0, so the answer effectively tells the browser "expect mono"
# even when OBS is sending a stereo stream. Advertise stereo explicitly, plus
# in-band FEC which costs nothing and helps on lossy links.
for _codec in _ac_mod.CODECS.get("audio", []):
    if _codec.mimeType.lower() == "audio/opus":
        _codec.parameters.update({
            "stereo": 1,
            "sprop-stereo": 1,
            "useinbandfec": 1,
        })
# ── End of patches ─────────────────────────────────────────────────────────────

import argparse
import asyncio
import logging
import uuid
from typing import Optional

from aiohttp import web
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCRtpSender,
    RTCConfiguration,
    RTCIceServer,
)
from aiortc.contrib.media import MediaPlayer, MediaRelay

LOG = logging.getLogger("whep")

# Per-session state
PCS:      dict = {}   # session_id → RTCPeerConnection  (WHEP)
PC_TASKS: dict = {}   # session_id → asyncio.Task       (stats loop)
PC_STATS: dict = {}   # session_id → dict               (last stats snapshot)


# ── Suppress harmless "Could not bind to 169.254.x.x" spam ──────────────────
class _SkipApipa(logging.Filter):
    def filter(self, record):
        return "Could not bind to 169.254." not in record.getMessage()

logging.getLogger("aioice.ice").addFilter(_SkipApipa())


# ── Quieten garbage traffic ──────────────────────────────────────────────────
# Anything speaking TLS to this plain-HTTP port (a browser trying https://, a
# port scanner) makes aiohttp log a full traceback for an unparseable request
# line. Exposed on the internet that floods the console and buries the useful
# lines. The 400 access-log entry still records it.
class _SkipMalformedRequests(logging.Filter):
    # The traceback lives in record.exc_info, not in the message — the message
    # is only "Error handling request" — so both have to be inspected.
    NOISE = ("BadStatusLine", "Invalid method encountered",
             "ConnectionResetError", "BadHttpMessage")

    def filter(self, record):
        blob = record.getMessage()
        if record.exc_info and record.exc_info[1] is not None:
            blob += " " + repr(record.exc_info[1])
        return not any(pattern in blob for pattern in self.NOISE)


logging.getLogger("aiohttp.server").addFilter(_SkipMalformedRequests())
logging.getLogger("asyncio").addFilter(_SkipMalformedRequests())


# ── Codec helpers ─────────────────────────────────────────────────────────────
def _best_codecs(kind: str, name: str):
    """Return codec list for setCodecPreferences, sorted by quality."""
    if not name or name == "auto":
        return None
    try:
        caps   = RTCRtpSender.getCapabilities(kind)
        needle = name.lower()
        codecs = [c for c in caps.codecs if needle in c.mimeType.lower()]
        if not codecs:
            return None
        if "h264" in needle and kind == "video":
            def _rank(c):
                fmtp = getattr(c, "sdpFmtpLine", "") or ""
                fmtp = fmtp.lower()
                if "profile-level-id=6400" in fmtp or "profile-level-id=640c" in fmtp:
                    return 0  # High
                if "profile-level-id=4d"   in fmtp:
                    return 1  # Main
                return 2      # Baseline / unknown
            codecs.sort(key=_rank)
        return codecs
    except Exception as e:
        LOG.warning("Could not get codec capabilities for %s: %s", kind, e)
        return None


async def _apply_codec_prefs(pc, sender, kind: str, codec_name: str):
    codecs = _best_codecs(kind, codec_name)
    if not codecs:
        return
    try:
        for t in pc.getTransceivers():
            if t.sender == sender:
                t.setCodecPreferences(codecs)
                LOG.info("Codec pref for %s: %s", kind, codecs[0].mimeType)
                return
    except Exception as e:
        LOG.warning("setCodecPreferences failed for %s: %s", kind, e)


async def _tune_encoder(sender, bitrate_bps: int, timeout: float = 8.0):
    """
    Wait for the lazy encoder to be instantiated, then set target_bitrate.
    The encoder is created on the first frame, so we poll briefly.
    Attribute name-mangled in aiortc: RTCRtpSender.__encoder → _RTCRtpSender__encoder.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.15)
        enc = getattr(sender, "_RTCRtpSender__encoder", None)
        if enc is not None and hasattr(enc, "target_bitrate"):
            try:
                enc.target_bitrate = bitrate_bps
                LOG.debug("Encoder target_bitrate → %d kbps", bitrate_bps // 1000)
            except Exception as e:
                LOG.debug("Could not tune encoder: %s", e)
            return


# ── Stats ─────────────────────────────────────────────────────────────────────
def _si(v, d=0):
    """Safe int conversion."""
    try:
        return int(v) if v is not None else d
    except (TypeError, ValueError):
        return d


def _sf(v, d=0.0):
    """Safe float conversion."""
    try:
        return float(v) if v is not None else d
    except (TypeError, ValueError):
        return d


def _summarize(stats: dict) -> dict:
    s = {}

    # Nominated ICE candidate pair
    pair = next(
        (v for v in stats.values()
         if v.type == "candidate-pair" and getattr(v, "nominated", False)),
        None,
    )
    if pair:
        rtt = getattr(pair, "currentRoundTripTime", None)
        if rtt is not None:
            s["rtt_ms"] = _si(rtt * 1000)
        bw = getattr(pair, "availableOutgoingBitrate", None)
        if bw is not None:
            s["avail_out_bps"] = _si(bw)
        s["bytes_sent"]     = _si(getattr(pair, "bytesSent",     0))
        s["bytes_received"] = _si(getattr(pair, "bytesReceived", 0))

    def _find(kind, direction):
        for v in stats.values():
            if v.type == direction:
                k = getattr(v, "kind", None) or getattr(v, "mediaType", None)
                if k == kind:
                    return v
        return None

    for kind in ("video", "audio"):
        out = _find(kind, "outbound-rtp")
        inp = _find(kind, "inbound-rtp")
        if out:
            s[f"out_{kind}_pkts"]  = _si(getattr(out, "packetsSent",  0))
            s[f"out_{kind}_lost"]  = _si(getattr(out, "packetsLost",  0))
            s[f"out_{kind}_bytes"] = _si(getattr(out, "bytesSent",    0))
            if kind == "video":
                s["out_video_frames"] = _si(getattr(out, "framesEncoded", 0))
                s["out_video_nack"]   = _si(getattr(out, "nackCount",     0))
                s["out_video_pli"]    = _si(getattr(out, "pliCount",      0))
        if inp:
            s[f"in_{kind}_pkts"]   = _si(getattr(inp, "packetsReceived", 0))
            s[f"in_{kind}_lost"]   = _si(getattr(inp, "packetsLost",     0))
            s[f"in_{kind}_bytes"]  = _si(getattr(inp, "bytesReceived",   0))
            s[f"in_{kind}_jitter"] = round(_sf(getattr(inp, "jitter", 0.0)), 4)

    return s


async def _stats_loop(session_id: str, pc, role: str, interval: int):
    last_bytes = 0
    last_ts    = asyncio.get_event_loop().time()
    fails      = 0

    while True:
        await asyncio.sleep(interval)
        try:
            raw     = await asyncio.wait_for(pc.getStats(), timeout=5.0)
            summary = _summarize(raw)
            fails   = 0

            now   = asyncio.get_event_loop().time()
            cur_b = summary.get("out_video_bytes", 0) or summary.get("in_video_bytes", 0)
            if cur_b > last_bytes and now > last_ts:
                summary["eff_kbps"] = int((cur_b - last_bytes) * 8 / (now - last_ts) / 1000)
            last_bytes, last_ts = cur_b, now

            PC_STATS[session_id] = {"role": role, **summary}

            if role == "whep":
                pkts = summary.get("out_video_pkts", 1) or 1
                loss = summary.get("out_video_lost", 0) / pkts * 100
                rtt  = summary.get("rtt_ms", 0)
                kbps = summary.get("eff_kbps", 0)
                if loss > 5:
                    LOG.warning("WHEP %s: %.1f%% packet loss", session_id[:8], loss)
                if rtt > 200:
                    LOG.warning("WHEP %s: RTT %d ms", session_id[:8], rtt)
                if kbps:
                    LOG.debug("WHEP %s: %d kbps", session_id[:8], kbps)

        except asyncio.CancelledError:
            break
        except Exception as e:
            fails += 1
            LOG.debug("Stats error (%s %s): %s", role, session_id[:8], e)
            if fails >= 15:
                LOG.debug("Stats giving up for %s %s", role, session_id[:8])
                break


# ── Patch 6: ICE components pruned to nothing on candidate-less offers ────────
# aiortc prunes its ICE components from the remote candidates found in the offer.
# A WHEP offer from Firefox never carries usable ones: Firefox obfuscates its host
# candidates as <uuid>.local mDNS names, which aiortc has no resolver for. Every
# component is then pruned, aioice's gather_candidates() iterates an empty set and
# collects nothing, and the answer goes out as:
#     m=video 9 ...      c=IN IP4 0.0.0.0      (no a=candidate at all)
# The browser is left with an empty remote candidate list, never sends a single
# connectivity check, and reports "ICE failed" — with no error anywhere else.
# Chromium is unaffected because it sends real IPs for localhost.
# Restoring component 1 before createAnswer() makes the gatherer collect the host
# candidates again.
def restore_ice_components(pc) -> int:
    restored = 0
    for transceiver in pc.getTransceivers():
        try:
            connection = transceiver.sender.transport.transport.iceGatherer._connection
        except AttributeError:
            continue
        if not connection._components:
            connection._components = {1}
            restored += 1
    return restored


# ── Session cleanup ───────────────────────────────────────────────────────────
async def _cleanup_peer(session_id: str):
    pc   = PCS.pop(session_id, None)
    task = PC_TASKS.pop(session_id, None)
    PC_STATS.pop(session_id, None)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    if pc:
        await pc.close()
    LOG.debug("WHEP session %s cleaned up", session_id[:8])


async def _cleanup_ingest(app):
    ingest = app["ingest"]
    pc     = ingest.get("pc")
    sid    = ingest.get("id")
    ingest.update({"pc": None, "video": None, "audio": None, "id": None})
    task = ingest.get("task")
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        ingest["task"] = None
    if pc:
        await pc.close()
    if sid:
        LOG.info("WHIP ingest %s cleaned up", sid[:8])


# ── CORS middleware ───────────────────────────────────────────────────────────
@web.middleware
async def _cors(request, handler):
    try:
        response = await handler(request)
    except web.HTTPMethodNotAllowed:
        if request.method == "OPTIONS":
            response = web.Response(status=204)
        else:
            raise
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "OPTIONS,GET,POST,DELETE,PATCH"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    response.headers["Access-Control-Expose-Headers"] = "Location,Link"
    response.headers["Access-Control-Max-Age"]       = "86400"
    return response


# ── ICE helpers ───────────────────────────────────────────────────────────────
def _ice_servers(urls):
    return [RTCIceServer(urls=u) for u in urls] if urls else []


def _ice_link(urls):
    if not urls:
        return None
    return ", ".join(f'<{u}>; rel="ice-server"' for u in urls)


# ── Active-track selector ─────────────────────────────────────────────────────
def _active_tracks(app):
    ing = app["ingest"]
    if ing["video"] or ing["audio"]:
        return ing["video"], ing["audio"]
    p = app["player"]
    if p and (p.video or p.audio):
        return p.video, p.audio
    return None, None


# ── OPTIONS ──────────────────────────────────────────────────────────────────
async def handle_options(request):
    headers = {}
    if request.app["ice_link"]:
        headers["Link"] = request.app["ice_link"]
    return web.Response(status=204, headers=headers)


# ── WHEP POST ─────────────────────────────────────────────────────────────────
async def handle_whep_post(request):
    if request.content_type != "application/sdp":
        return web.Response(status=415, text="Expected application/sdp")

    video, audio = _active_tracks(request.app)
    if not video and not audio:
        return web.Response(status=503, text="No active stream — start OBS / WHIP first")

    offer_sdp = await request.text()
    app       = request.app
    relay: MediaRelay = app["relay"]
    video_bps = app["video_bitrate"]
    audio_bps = app["audio_bitrate"]
    codec_nm  = app["video_codec"]

    pc  = RTCPeerConnection(configuration=RTCConfiguration(
        iceServers=_ice_servers(app["ice_servers"])
    ))
    sid = str(uuid.uuid4())
    PCS[sid] = pc

    senders = []
    if video:
        # buffered=False → frames forwarded immediately, no extra relay latency
        track  = relay.subscribe(video, buffered=False)
        sender = pc.addTrack(track)
        await _apply_codec_prefs(pc, sender, "video", codec_nm)
        if video_bps:
            senders.append((sender, video_bps))

    if audio:
        track  = relay.subscribe(audio, buffered=False)
        sender = pc.addTrack(track)
        if audio_bps:
            senders.append((sender, audio_bps))

    @pc.on("connectionstatechange")
    async def _on_state():
        state = pc.connectionState
        LOG.info("WHEP %s: %s", sid[:8], state)
        if state == "connected":
            # Tune encoder target_bitrate after the lazy encoder is created
            for sndr, bps in senders:
                asyncio.create_task(_tune_encoder(sndr, bps))
        elif state in ("failed", "closed", "disconnected"):
            await _cleanup_peer(sid)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        restored = restore_ice_components(pc)
        if restored:
            LOG.info("WHEP %s: restored %d pruned ICE component(s)", sid[:8], restored)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception as e:
        LOG.error("WHEP SDP negotiation failed: %s", e)
        await _cleanup_peer(sid)
        return web.Response(status=500, text=str(e))

    PC_TASKS[sid] = asyncio.create_task(
        _stats_loop(sid, pc, "whep", app["stats_interval"])
    )

    loc = request.app.router["whep_resource"].url_for(id=sid)
    LOG.info("WHEP session %s created", sid[:8])
    return web.Response(
        status=201,
        text=pc.localDescription.sdp,
        headers={"Content-Type": "application/sdp", "Location": str(loc)},
    )


async def handle_whep_delete(request):
    await _cleanup_peer(request.match_info["id"])
    return web.Response(status=204)


# ── WHIP POST ─────────────────────────────────────────────────────────────────
async def handle_whip_post(request):
    if request.content_type != "application/sdp":
        return web.Response(status=415, text="Expected application/sdp")

    offer_sdp = await request.text()
    app       = request.app

    if app["ingest"]["pc"]:
        LOG.info("Replacing existing WHIP ingest")
        await _cleanup_ingest(app)

    pc  = RTCPeerConnection(configuration=RTCConfiguration(
        iceServers=_ice_servers(app["ice_servers"])
    ))
    sid = str(uuid.uuid4())
    app["ingest"]["pc"] = pc
    app["ingest"]["id"] = sid

    @pc.on("track")
    def _on_track(track):
        LOG.info("WHIP track received: %s (id=%s)", track.kind, track.id)
        app["ingest"][track.kind] = track

        @track.on("ended")
        def _ended():
            LOG.warning("WHIP track %s ended", track.kind)
            app["ingest"][track.kind] = None

    @pc.on("connectionstatechange")
    async def _on_state():
        state = pc.connectionState
        LOG.info("WHIP ingest %s: %s", sid[:8], state)
        if state == "connected":
            LOG.info("WHIP ingest live ✓")
        elif state in ("failed", "closed", "disconnected"):
            LOG.warning("WHIP ingest %s — cleaning up", state)
            await _cleanup_ingest(app)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        restored = restore_ice_components(pc)
        if restored:
            LOG.info("WHIP %s: restored %d pruned ICE component(s)", sid[:8], restored)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception as e:
        LOG.error("WHIP SDP negotiation failed: %s", e)
        import traceback; traceback.print_exc()
        await _cleanup_ingest(app)
        return web.Response(status=500, text=str(e))

    app["ingest"]["task"] = asyncio.create_task(
        _stats_loop(sid, pc, "whip", app["stats_interval"])
    )

    loc = request.app.router["whip_resource"].url_for(id=sid)
    LOG.info("WHIP ingest session %s created", sid[:8])
    return web.Response(
        status=201,
        text=pc.localDescription.sdp,
        headers={"Content-Type": "application/sdp", "Location": str(loc)},
    )


async def handle_whip_delete(request):
    await _cleanup_ingest(request.app)
    return web.Response(status=204)


# ── Debug / health ────────────────────────────────────────────────────────────
async def handle_debug_stats(request):
    ing = request.app["ingest"]
    return web.json_response({
        "peers":          PC_STATS,
        "ingest_id":      ing.get("id"),
        "active_viewers": len(PCS),
        "ingest_active":  ing.get("pc") is not None,
    })


async def handle_health(request):
    ing = request.app["ingest"]
    pc  = ing.get("pc")
    return web.json_response({
        "status":           "ok",
        "ingest_connected": pc is not None and pc.connectionState == "connected",
        "active_viewers":   len(PCS),
        "has_video":        ing.get("video") is not None,
        "has_audio":        ing.get("audio") is not None,
    })


# ── Shutdown ──────────────────────────────────────────────────────────────────
async def _on_shutdown(app):
    LOG.info("Shutting down…")
    tasks = [_cleanup_peer(sid) for sid in list(PCS)]
    tasks.append(_cleanup_ingest(app))
    await asyncio.gather(*tasks, return_exceptions=True)
    LOG.info("Shutdown complete")


# ── MediaPlayer ───────────────────────────────────────────────────────────────
def _create_player(source: Optional[str]) -> Optional[MediaPlayer]:
    if not source:
        return None
    try:
        if source.startswith("rtmp://"):
            LOG.info("RTMP source: %s", source)
            return MediaPlayer(source, format="flv", options={
                "fflags": "nobuffer",
                "flags":  "low_delay",
                "rtmp_live": "live",
            })
        LOG.info("File source: %s", source)
        return MediaPlayer(source, loop=True)
    except Exception as e:
        LOG.error("Failed to create player: %s", e)
        return None


# ── App factory ───────────────────────────────────────────────────────────────
def create_app(source: Optional[str], ice_servers: list) -> web.Application:
    app = web.Application(middlewares=[_cors])

    app["relay"]    = MediaRelay()
    app["player"]   = _create_player(source)
    app["ice_link"] = _ice_link(ice_servers)
    app["ice_servers"] = ice_servers
    app["ingest"]   = {"pc": None, "video": None, "audio": None, "id": None, "task": None}
    app["stats_interval"] = 5
    app["video_bitrate"]  = None
    app["audio_bitrate"]  = None
    app["video_codec"]    = "h264"

    app.router.add_route("OPTIONS", "/whep",      handle_options)
    app.router.add_route("POST",    "/whep",      handle_whep_post)
    app.router.add_route("DELETE",  "/whep/{id}", handle_whep_delete, name="whep_resource")

    app.router.add_route("OPTIONS", "/whip",      handle_options)
    app.router.add_route("POST",    "/whip",      handle_whip_post)
    app.router.add_route("DELETE",  "/whip/{id}", handle_whip_delete, name="whip_resource")

    app.router.add_route("GET", "/debug/stats", handle_debug_stats)
    app.router.add_route("GET", "/health",      handle_health)

    app.on_shutdown.append(_on_shutdown)
    return app


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="WHIP/WHEP server — stable & high quality")
    p.add_argument("--host",           default="0.0.0.0")
    p.add_argument("--port",           type=int, default=8080)
    p.add_argument("--source",         default="")
    p.add_argument("--ice-server",     action="append", dest="ice_servers", default=[])
    p.add_argument("--stats-interval", type=int, default=5)
    p.add_argument("--video-bitrate",  type=int, default=8000,
                   help="Video target bitrate in kbps (default: 8000 = 8 Mbps)")
    p.add_argument("--audio-bitrate",  type=int, default=192,
                   help="Audio target bitrate in kbps (default: 192)")
    p.add_argument("--video-codec",    default="h264", choices=["auto", "h264", "vp8"])
    p.add_argument("--verbose",        action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    video_bps = max(1_000, args.video_bitrate) * 1_000
    audio_bps = max(64,    args.audio_bitrate) * 1_000

    # Update module constants with user-specified target
    _h264_mod.DEFAULT_BITRATE = video_bps
    _h264_mod.MIN_BITRATE     = max(1_000_000, video_bps // 4)
    _h264_mod.MAX_BITRATE     = video_bps * 2
    _vpx_mod.DEFAULT_BITRATE  = video_bps
    _vpx_mod.MAX_BITRATE      = video_bps * 2

    app = create_app(args.source or None, args.ice_servers)
    app["stats_interval"] = max(1, args.stats_interval)
    app["video_bitrate"]  = video_bps
    app["audio_bitrate"]  = audio_bps
    app["video_codec"]    = args.video_codec

    LOG.info("=" * 60)
    LOG.info("WHIP/WHEP server")
    LOG.info("  WHIP  : http://%s:%d/whip", args.host, args.port)
    LOG.info("  WHEP  : http://%s:%d/whep", args.host, args.port)
    LOG.info("  Stats : http://%s:%d/debug/stats", args.host, args.port)
    LOG.info("  Health: http://%s:%d/health", args.host, args.port)
    LOG.info("  Codec : %s", args.video_codec.upper())
    LOG.info("  Video : %d kbps target / %d kbps max",
             args.video_bitrate, args.video_bitrate * 2)
    LOG.info("  Audio : %d kbps", args.audio_bitrate)
    if args.source:
        LOG.info("  Source: %s", args.source)
    LOG.info("=" * 60)

    web.run_app(app, host=args.host, port=args.port, access_log=LOG)


if __name__ == "__main__":
    main()

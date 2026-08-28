# Python WHIP/WHEP Server

Minimal WHIP ingest + WHEP egress server for SyncVid, plus optional RTMP ingest.

## Install

```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python whep_server.py --port 8080
```

Endpoints:

```
WHIP (OBS ingest): http://127.0.0.1:8080/whip
WHEP (clients):    http://127.0.0.1:8080/whep
```

Debug stats:

```
http://127.0.0.1:8080/debug/stats
```

## RTMP Ingest (OBS -> RTMP -> WHEP)

1. Start the RTMP server:

```bash
npm install
npm run rtmp
```

RTMP endpoint:

```
rtmp://127.0.0.1:1935/live/<streamKey>
```

2. In OBS:

- Service: `Custom`
- Server: `rtmp://127.0.0.1:1935/live`
- Stream Key: `stream`

3. Start WHEP server with RTMP source:

```bash
python whep_server.py --port 8080 --source rtmp://127.0.0.1:1935/live/stream
```

4. In SyncVid:

- Stream type: `WebRTC (WHEP)`
- URL: `http://127.0.0.1:8080/whep`

## Notes

- `--source` can be a fallback media file (mp4/webm) or an RTMP URL.
- You can pass ICE servers:

```bash
python whep_server.py --source sample.mp4 --ice-server stun:stun.l.google.com:19302
```

## Stats / Debug

Run with verbose logs to see per-connection stats:

```bash
python whep_server.py --port 8080 --verbose --stats-interval 5
```

Or fetch JSON stats from:

```
http://127.0.0.1:8080/debug/stats
```

## Stability / Quality Tuning

You can tune the WHEP output bitrate and preferred codec:

```bash
python whep_server.py --port 8080 --video-bitrate 12000 --audio-bitrate 192 --video-codec h264
```

Defaults:

- video bitrate: 8000 kbps
- audio bitrate: 128 kbps
- codec: auto (let the stack decide)

## OBS

Set OBS to stream via WHIP:

- Service: `WHIP`
- Server: `http://127.0.0.1:8080/whip`

Then use the WHEP URL in SyncVid:

```
http://127.0.0.1:8080/whep
```

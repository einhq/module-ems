# EMS, from EiN

How EiN uses EMS, the EiN Media Service, through this module: what lives there, the transcodes and decoding it does for the archive, and how the two share a host.

**Which module owns which external dependency.** The EiN image
(core's `src/Containerfile`) is the `denoland/deno` base and nothing else: no
module spawns a host tool. Core needs the base
image and PostgreSQL over the network. Everything that used to be baked here — exiftool,
ImageMagick, ffmpeg, Python, torch and the CUDA stack, the face models, the text and picture embedders, whisper,
NeMo, LR-ASD, PP-OCRv6, chromaprint, tesseract, PyMuPDF — lives in **EMS**, the media service, which is its
own repository, image and container (see _The ems module_ below).

The shell runs no host binaries: every command is core's or a module's, and every tool behind
them is EMS's.

**No GPU in this container.** The card is EMS's: the models, the CUDA keyframe and poster
extractions and the transcodes' NVDEC/NVENC chain all run there, and EiN's container gets
no device. The media `models` pool worker survives: `CFG_MODEL_SLOTS` is how many model-bound
steps EiN keeps in flight against EMS at once, and its kinds (`faces`, `embed-picture`,
`embed-text`, `transcribe`, `diarize`) are the backlogs it rotates between. EMS chooses only among
what is sent: its admission gives a freed slot to interactive work, then to the caller (a key,
named in EMS's keys file) that has used it the least for its weight, then to a request for a model
family already running, so a system that keeps more in flight than EMS runs lets EMS keep a loaded
family busy, and one that keeps fewer chooses for itself (ein/core#1068). Nothing on this side names a
device or a VRAM figure; whether EMS answers on the card or the CPU is EMS's decision, reported in
its health as `degraded`.

**The transcodes are EMS's (`video.transcode`, `audio.transcode`), with the rules EiN measured
into them.** Video runs a three-stage ladder — everything in VRAM (NVDEC, `yadif_cuda`/`scale_cuda`/
`transpose_cuda`, `av1_nvenc`; `transpose_cuda` is why EMS pins ffmpeg 9), then a CPU decode fed
into NVENC, then `libsvtav1` alone — and each stage gives up strictly less of the GPU than the one
below it. The first stage is skipped outright for a codec NVDEC cannot decode (DV, MJPEG, ProRes,
H.263, MS-MPEG-4 v3 — a quarter of the corpus): `exif-extract` names the picture codec from the
exiftool run it already does (`@archive/media/video-codec` maps the container's fourcc to ffmpeg's name)
and promotes it to the file node's `codec`, and `generate-derivatives` hands it to EMS as a hint
out of attrs it had already read, so the skip costs no probe. The two CPU-decode stages are
metered: ffmpeg's CPU decode grows ~0.17 MB of RSS per frame and never returns it (an 83-minute SD
tape projects to ~21 GB; the accumulator is the decode, so NVENC does not help), so EMS projects
`frames × MB-per-1k-frames` before either and encodes a source over its budget as whole-second
windows, one process each, joined by a stream copy with the audio encoded once over the whole
clip. A source whose windows cannot be placed is **refused** — a permanent answer for that source
at that budget — and `generate-derivatives` records the refusal on the file node together with
EMS's budget signature (`capabilities.encode.cpu_budget`), so `media-scan` stops announcing a gap
nothing will close until the budget on EMS is raised, which makes the signature stale and re-opens
it on its own. The budget lives in EMS's environment (`EMS_CPU_ENCODE_*`). Audio renditions are
AAC in an `M4A`-branded MP4, with the bitrate and sample rate of the rendition table's audio role as ceilings against
the source and a remux when the source is already AAC in an MP4-family container.

**Sharing a host.** EMS runs as a container of its own beside EiN's, on the same machine or another,
and mounts none of EiN's folders: it reaches a request's files only through the `ems-files` service
(_The ems module_ below), so a path in a request is a name `ems-files` gave it, never a path on
EiN's disk. Two connections join them, one each way: EiN sends its requests to EMS over HTTP
(`CFG_EMS_URL`), and EMS connects back to `ems-files` for the files they name
(`CFG_EMS_FILES_ADDRESS`). The deployment gives this module those settings, and `CFG_EMS_KEY`, one
line of EMS's keys file; nothing here knows which hosts there are. EMS's own `gpu-check` runs real
inference per model, the only honest test of a CUDA stack whose every fallback is silent.
Originals are never copied to EMS: it reads them through its mount where they lie.

**The ems module.** Every model and every Python tool lives in EMS, the EiN Media Service (the
`ein/ems` repository), not in this image: a model server's memory then cannot take HTTP, SSH and
the pipeline engine down with it, the image carries no model weights, and one service shares the
GPU between the models and ffmpeg. EMS is a stateless HTTP service — `POST /v0/<namespace>/<op>`, JSON in
and out, `text/event-stream` progress for long operations, a closed connection is a cancel — that
answers questions about a request's files and produces files for it: probing, fingerprints,
faces, speech, embeddings, document text, renditions and transcodes. Its contract is `docs/api.md` in that repository. It knows nothing about the
VFS, holds no state, and never calls EiN; every convention it needs (the display angle, target
sizes, the face boxes, the speakers' turns) arrives as a request parameter.

The `ems` module here is the client side. [@ems/client](../lib/client.ts) is one
function per op — `transcribe`, `embedTexts`, `embedImage`, `embedImageText`, `detectFaces`,
`voiceprint`, `activeSpeakers`, `fingerprint`, `extractText`, `probe`, the renditions and the
transcodes, plus `health` and what `capabilities` says each result is stamped with now (`generations`) — and sends
every file by a name of its own: EMS mounts no file tier, and reaches a request's files through the
`ems-files` service, an SFTP endpoint that lists nothing and serves each request a directory of
its own, `/<grant>/<n>-<VFS name>`, for as long as it runs ([files.ts](../lib/files.ts)). It speaks
SFTP straight on the connection, with no SSH. By default a connection is plain: the endpoint sends
a challenge and the client answers it with an HMAC on the secret made when the service started,
which suits EMS on the same machine or network. With `CFG_EMS_FILES_TLS` it is TLS, the endpoint
and EMS each pinning the other's certificate, both made at start
([files-cert.ts](../lib/files-cert.ts)). The request's `EMS-Files` header names the endpoint and
the secret, or the certificates; EMS mounts it with sshfs, reads the inputs there, and copies what
it wrote back before it answers. The header travels in the request, so its credentials are only as
private as the request is: plain HTTP to an EMS on the compose network, HTTPS when `CFG_EMS_URL`
is an `https://` address. EMS makes one mount per endpoint, on the first request that names a
file, and every request after uses it; between requests it serves nothing, as no name is granted.
EMS mounts again when sshfs exits, or when the header names other credentials, which a restart of
`ems-files` makes, letting go of the old mount at that address. A name stands for the node's file on disk, or for the node itself
when it has none (the db tier), read and written through the VFS. A thread of its own listens,
authenticates each connection and carries its bytes ([files-listen.ts](../lib/files-listen.ts)) to
up to four session threads ([files-thread.ts](../lib/files-thread.ts)), each serving SFTP sessions
with a copy of the names and reading and writing the files on disk itself, so EMS's reads do not
wait behind the pipelines on EiN's event loop; only a db-tier node's calls go back to EiN's thread,
one message each ([files-server.ts](../lib/files-server.ts)). A grant returns once every session
thread has its names. `CFG_EMS_FILES_ADDRESS` is the endpoint as EMS reaches it; while it is empty or the service is
not serving, a request that names a file is `EmsUnavailableError` and waits. Three outcomes stay distinct for everything downstream:
`EmsUnavailableError` (unreachable, timed out, interrupted, `busy`, or a model worker still loading —
the step exits `STEP_EXIT_TEMPORARY` through `stepExitCode` and waits without spending an attempt),
`EmsError` carrying the API's `code` and `permanent`
(`index-document` marks a file with a permanent failure as not extractable rather than retrying),
and a `null` result meaning "nothing found" — no face inside the box, too little to judge an
active speaker on. There is no in-process fallback any more; the models are not in this image.
Face boxes and landmarks arrive as fractions of the display frame, which is what the face nodes store,
so `detect-faces` no longer normalizes pixels; the head pose arrives in degrees and is stored as is. A request is dropped when its command is
interrupted (the client polls `cmd.interrupted` and aborts the fetch), which on the EMS side kills
the tool or discards the queued model request. Callers that provide a progress callback use EMS's
SSE response form and still receive the same terminal envelope. EMS generates no text:
conversation belongs to the assistant's own model service (`modules/assistant/lib/llm.ts`,
`CFG_LLM_URL`), which may be a provider elsewhere, so no processing step depends on it.

Configuration is `CFG_EMS_URL`, `CFG_EMS_KEY`, a secret the client sends only to the system's
own `CFG_EMS_URL` (`serviceKey`), and `CFG_EMS_FILES_ADDRESS`, `CFG_EMS_FILES_PORT` and
`CFG_EMS_FILES_TLS`, where `ems-files` is reached, where it listens, and whether over TLS. A batch request has no ceiling: it
waits for EMS's answer however long a cold model load and the work queued ahead of it take, and
only a caller a person is waiting on names a timeout of its own. The thirteen model settings the `inference` module used to declare — which model, quantization,
pinning, idle eviction, the RSS ceiling, the whisper decode options — are EMS's environment now and
no longer appear on the settings page. Three whisper settings an operator may still carry
(`CFG_WHISPER_LANGUAGE`, `CFG_WHISPER_VAD_MIN_SILENCE_MS`, `CFG_WHISPER_WORD_TIMESTAMPS`) are
forwarded per request when set, so they keep their effect — `CFG_WHISPER_LANGUAGE` is a pin, and
the archive's languages are better told to EMS as `EMS_WHISPER_LANGUAGES` (its host profile), which
biases its multi-window detection rather than replacing it, so a holiday clip in English is still
decoded as English; the transcript signature EMS reports
(`GET /v0/capabilities`, `signatures.transcribe`) is what `media-scan` compares stamps against —
derived on the side that decodes, so the two cannot disagree.

EMS is not an EiN service, but the dashboard reads service rows, so the module carries one:
`ems-link` ([modules/ems/services/ems-link](../services/ems-link)) polls `ems-status
--brief` every minute and logs each change of reachability, runs failed work again when EMS's build
changes (`pipeline heal --now`), and its `statusCommand` puts EMS's
one-line health — degradations first, then who has the card, loaded models, VRAM, the worker's RSS
against its ceiling and its recycle count — beside the row in `service-list --detail`. `ems-status`
without `--brief` prints the whole health answer, typed as `EmsStatus` in `@ems/api`: version and
build, every model family EMS can load with each copy's state (loading, loaded, unloading) and
device, the requests it is running or queueing per op (EMS API 3.2), and the card mode (3.4):
`busy` while indexing work arrives, `quiet` once it has stopped and the search models are on the
card, with each family's placement in either mode. The system dashboard's media service tab polls
it while open and shows the mode and, per model, where it runs when busy and when quiet.

**The decoding is EMS's too.** `transcribe-file` and `voiceprint-file` hand EMS the media file itself — it extracts the sound once and keeps it for
the diarization and voiceprints (one request per recording, the windowing and stitching EMS's
own) and for `speech.active_speakers`, which decodes a video once to find the faces seen
speaking with each voice.
`detect-faces` and `compute-fingerprint` no longer decode a RAW or a HEIC out of process either.

The still-image renditions are EMS's too (phase 3b): `@archive/media/image-ladder` sends a photo's whole
size ladder as one `image.renditions` call, a video's poster frames as one `video.poster` and a
recording's waveform pictures as one `audio.waveform`, and a face crop is an `image.renditions`
target with `crop` (`@archive/media/face-crop`, `writeFaceCrop`). The box travels as a fraction of the
display frame and nothing else — EMS resolves it against the raster it decodes, which is what
retired `sourceFrame` and the `normalizeSource` workaround: a RAW's embedded preview against its
sensor image, and a HEIC libheif has already turned, are reconciled where the decoding happens.
EiN keeps every node: the hidden temp sibling each output is written into, the size check,
the swap.

What stays here, deliberately: node creation and attrs, `file-sync`, the temp-sibling swap of
renditions, face assignment and person minting, voice assignment, transcript chunking and VTT,
pipelines, pools and retries. `exif-extract`
reads its metadata from `media.probe` (phase 3a), and the transcodes are `video.transcode` and
`audio.transcode` (phase 3c, `@archive/media/transcode`), and a video's storyboard sheet is
`video.storyboard` over its rendition (`@archive/media/storyboard`), and its cuts `video.shots`
(`detect-chapters`): nothing in this image spawns a tool any more.

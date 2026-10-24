# module-ems

Client for EMS (API v0), the media service that holds every model and media tool: transcription, embeddings, faces, voices, fingerprints, document text.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/ems`, and a deployment chooses whether to run it. `mod.json` is its manifest: the core it
needs (`coreApi`), the modules it depends on, and what it exports.

## What it holds

Client for EMS, the media service holding every model and Python tool; `ems-status` (`--card`: the card's mode alone) and the `ems-link` dashboard row; `ems-text-embed`, the text embedder `CFG_TEXT_EMBEDDER` names

## Architecture

- [ems.md](architecture/ems.md) — what lives in EMS, the transcodes and decoding it does for the archive, and how EiN and EMS share a host

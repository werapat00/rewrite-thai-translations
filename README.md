# Rewrite Thai

Unofficial Thai translation patch for *Rewrite* (Siglus engine). Extracts the
English scene archive, applies Thai translation patches, and repackages it
along with a launcher/hook to load the patched files at runtime.

## Prerequisites

- Docker
- Original `SceneEN.pck` and `GameexeEN.dat` files placed in `input/`

## Build

```
docker build -t rewrite-thai-builder .
docker run --rm -v "$PWD:/work" rewrite-thai-builder
```

Output is written to `output/`.

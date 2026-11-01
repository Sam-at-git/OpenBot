# The Bot's computer installs only the Playwright browser it launches, and carries the built OpenBot
# Recorder for the person's browser it opens (the OpenBot Browser).
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

# The Recorder, built here from the repository root as the root Dockerfile builds the app: the
# workspace manifests and lockfile first, so a source edit does not reinstall the world, then the
# sources the build reads. It needs the root install because the extension is a workspace and its
# pages are drawn with the app's own components (`app/src`). Only `extension/dist` leaves this stage.
FROM bun-toolchain AS recorder-build
WORKDIR /src
COPY package.json bun.lock ./
# The dependency patches package.json names in patchedDependencies: the install stops without them.
COPY patches patches
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json
COPY toolkit/package.json toolkit/package.json
COPY extension/package.json extension/package.json
RUN bun install --frozen-lockfile
COPY app/src app/src
COPY shared shared
COPY extension extension
RUN bun run --cwd extension build

FROM ubuntu:24.04

# The Bun image digest pins the amd64/arm64 release bytes, including if its tag changes.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
# `--no-shell`: every launch names a Chromium channel (`browser-runtime.ts`), and Playwright runs
# the full build for a named channel even when headless, so the headless shell is never started. It
# was 340 MB unpacked and about 106 MB of every download. The bunx package cache goes too: Bun
# writes it under both BUN_INSTALL and the home directory, 35 MB the image never reads.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/* /var/lib/apt/lists/*

# Python for the scripts a skill runs on the computer (`python`, `pip`). Ubuntu's own Python refuses
# `pip install` into the system (PEP 668), so a virtual environment at /opt/python comes first on
# PATH: `python` and `pip` are its, and a package a Bot installs lands there. It lasts until the
# computer is replaced; anything that must survive that belongs in /workspace.
#
# Both mirrors are optional build arguments for networks where the defaults are slow or blocked:
# APT_MIRROR replaces the Ubuntu archive host for this install (e.g. mirrors.tuna.tsinghua.edu.cn),
# and PIP_INDEX_URL becomes the computer's pip index (/etc/pip.conf). Unset changes nothing.
ARG APT_MIRROR=
ARG PIP_INDEX_URL=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#https?://(archive|security|ports)\.ubuntu\.com#http://${APT_MIRROR}#g" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
  && apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
  && python3 -m venv /opt/python \
  && if [ -n "$PIP_INDEX_URL" ]; then \
      printf "[global]\nindex-url = %s\n" "$PIP_INDEX_URL" > /etc/pip.conf; \
    fi \
  && /opt/python/bin/pip install --no-cache-dir --upgrade pip \
  && rm -rf /root/.cache /var/lib/apt/lists/*
ENV PATH="/opt/python/bin:${PATH}"

# Local OCR for scanned PDFs (`pdf-ocr`), so a document is read on this computer and not sent to a
# cloud service. RapidOCR carries its Chinese and English models inside the wheel, so nothing is
# downloaded at run time; the computer's egress policy would block that anyway.
RUN /opt/python/bin/pip install --no-cache-dir \
      rapidocr-onnxruntime==1.4.4 pymupdf==2.0 \
  && /opt/python/bin/python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR(); import pymupdf" \
  && rm -rf /root/.cache
COPY --chmod=755 agent-computer/bin/pdf-ocr /usr/local/bin/pdf-ocr

# PaddleOCR (PP-OCRv5) and PP-StructureV3 (layout, tables, formulas, seals into Markdown), CPU only.
# Their models are fetched here, at build time, into /opt/paddlex: a Bot's HOME is its own folder,
# so the default ~/.paddlex would be empty for every Bot, and the computer can't download them at run
# time. PADDLE_MODEL_SOURCE picks where the build fetches from (bos, huggingface, modelscope).
ARG PADDLE_MODEL_SOURCE=bos
ENV PADDLE_PDX_CACHE_HOME=/opt/paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
RUN /opt/python/bin/pip install --no-cache-dir \
      paddlepaddle==3.2.2 "paddleocr[doc-parser]==3.7.0" \
  && PADDLE_PDX_MODEL_SOURCE="$PADDLE_MODEL_SOURCE" /opt/python/bin/python -c "\
from paddleocr import PaddleOCR, PPStructureV3; \
PaddleOCR(lang='ch'); \
PPStructureV3()" \
  && rm -rf /root/.cache
# The fonts PaddleX draws its saved results with, which it otherwise downloads on first save.
RUN /opt/python/bin/python -c "\
from paddlex.utils import fonts; \
[getattr(fonts, name).path for name in dir(fonts) if name.endswith('_FONT')]" \
  && ls /opt/paddlex/fonts
# The paddleocr CLI also writes a Word copy of a PP-StructureV3 result and stops without this.
RUN /opt/python/bin/pip install --no-cache-dir python-docx==1.2.0 && rm -rf /root/.cache

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src
# index.ts imports ../../shared/file-download at runtime (shared/computer-control is type-only and
# erased), and the browser routes import ../../shared/openbot-browser and ../../shared/bot-browser,
# so the files they need go where those paths resolve from /app/src.
COPY shared/file-download.ts /shared/file-download.ts
# The OpenBot Browser's contract and a Bot's browser's, which the browser routes check requests
# against. They import zod, and a module resolves its imports from its own directory upward, which
# from /shared never reaches /app/node_modules: so /shared is given that tree to resolve from, rather
# than a second install.
COPY shared/openbot-browser.ts shared/bot-browser.ts /shared/
COPY shared/recorder-extension.ts shared/recorder-extension.json /shared/
RUN ln -s /app/node_modules /shared/node_modules

# The built Recorder, put into every person's browser this computer opens. Without it the computer
# still serves Bots and refuses to open a person's browser, saying why.
COPY --from=recorder-build /src/extension/dist /recorder
ENV OPENBOT_RECORDER_DIR=/recorder

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]

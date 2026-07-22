FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nodejs \
      gcc-mingw-w64-i686 \
      git \
      make \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/TsudaKageyu/minhook.git /opt/minhook

RUN pip install --no-cache-dir siglus-ssu \
 && useradd --create-home --shell /usr/sbin/nologin ssu

USER ssu
RUN siglus-ssu init

WORKDIR /work
ENTRYPOINT ["make"]
CMD ["all"]

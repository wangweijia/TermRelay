FROM debian:trixie-slim

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends \
        binutils ca-certificates cmake file g++ git ninja-build pkg-config \
        libcurl4-openssl-dev libfmt-dev libfreetype-dev libjpeg62-turbo-dev \
        libpng-dev nlohmann-json3-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch v9.5.0 https://github.com/lvgl/lvgl.git /opt/lvgl

WORKDIR /workspace

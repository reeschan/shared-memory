FROM opensearchproject/opensearch:3.5.0

ARG SUDACHI_PLUGIN_URL=https://github.com/WorksApplications/elasticsearch-sudachi/releases/download/v3.6.0/opensearch-3.5.0-analysis-sudachi-3.6.0.zip
# SudachiDict の GitHub Releases には zip が置かれないため、README の Download 先 (公式配布) を日付固定で使う
ARG SUDACHI_DICT_VERSION=20260723
ARG SUDACHI_DICT_URL=https://d2ej7fkh96fzlu.cloudfront.net/sudachidict/sudachi-dictionary-${SUDACHI_DICT_VERSION}-core.zip

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch "${SUDACHI_PLUGIN_URL}"

# イメージに unzip が無いので同梱 JDK の jar で展開する
RUN mkdir -p /usr/share/opensearch/config/sudachi /tmp/sudachi-dict \
 && cd /tmp/sudachi-dict \
 && curl -fsSL -o dict.zip "${SUDACHI_DICT_URL}" \
 && jar xf dict.zip \
 && mv "sudachi-dictionary-${SUDACHI_DICT_VERSION}/system_core.dic" /usr/share/opensearch/config/sudachi/system_core.dic \
 && cd / && rm -rf /tmp/sudachi-dict

COPY --chown=opensearch:opensearch sudachi/sudachi.json /usr/share/opensearch/config/sudachi/sudachi.json

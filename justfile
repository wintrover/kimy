set shell := ["bash", "-euc"]

target_platform := "linux-x64"
kimy_bin := home_directory() / ".kimy/bin"
kimy_actual := kimy_bin / "kimy.actual"
kimy_web_hash := kimy_bin / ".kimy-web-hash"
kimy_vis_hash := kimy_bin / ".kimy-vis-hash"
kimy_native_hash := kimy_bin / ".kimy-native-hash"

[default]
help:
    just --list

# 전체 배포: 빌드 → 설치 → 스모크 테스트 (증분, 무조건 실행)
deploy:
    #!/usr/bin/env bash
    set -euxo pipefail
    echo "📦 웹 에셋 빌드..."
    pnpm --filter @moonshot-ai/kimi-web run build
    node apps/kimi-code/scripts/copy-web-assets.mjs
    echo "🔨 native SEA 빌드..."
    pnpm --filter @moonshot-ai/kimi-code run build:native:sea
    echo "📥 kimy 바이너리 설치..."
    mkdir -p "{{ kimy_bin }}"
    cp "apps/kimi-code/dist-native/bin/{{ target_platform }}/kimi" "{{ kimy_actual }}.tmp"
    chmod +x "{{ kimy_actual }}.tmp"
    mv "{{ kimy_actual }}.tmp" "{{ kimy_actual }}"
    echo "🔑 빌드 해시 기록..."
    find apps/kimi-web/src apps/kimi-web/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_web_hash }}"
    find apps/vis/web/src apps/vis/web/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_vis_hash }}"
    find apps/kimi-code/src apps/kimi-code/tsdown.native.config.ts apps/kimi-code/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_native_hash }}"
    echo "✅ 스모크 테스트..."
    "{{ kimy_actual }}" --version
    echo "🎉 배포 완료!"

# 전체 클린 배포 (기존 빌드 정리 후 — 의존성 변경 시 사용)
deploy-full:
    #!/usr/bin/env bash
    set -euxo pipefail
    echo "🧹 기존 빌드 정리..."
    rm -rf apps/kimi-code/dist-native
    echo "📦 의존성 설치..."
    pnpm install --frozen-lockfile
    echo "📦 웹 에셋 빌드..."
    pnpm --filter @moonshot-ai/kimi-web run build
    node apps/kimi-code/scripts/copy-web-assets.mjs
    echo "🔨 native SEA 빌드..."
    pnpm --filter @moonshot-ai/kimi-code run build:native:sea
    echo "📥 kimy 바이너리 설치..."
    mkdir -p "{{ kimy_bin }}"
    cp "apps/kimi-code/dist-native/bin/{{ target_platform }}/kimi" "{{ kimy_actual }}.tmp"
    chmod +x "{{ kimy_actual }}.tmp"
    mv "{{ kimy_actual }}.tmp" "{{ kimy_actual }}"
    echo "🔑 빌드 해시 기록..."
    find apps/kimi-web/src apps/kimi-web/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_web_hash }}"
    find apps/vis/web/src apps/vis/web/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_vis_hash }}"
    find apps/kimi-code/src apps/kimi-code/tsdown.native.config.ts apps/kimi-code/package.json -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 > "{{ kimy_native_hash }}"
    echo "✅ 스모크 테스트..."
    "{{ kimy_actual }}" --version
    echo "🎉 배포 완료!"

# 빌드만 (설치 안 함)
build:
    pnpm --filter @moonshot-ai/kimi-web run build
    node apps/kimi-code/scripts/copy-web-assets.mjs
    pnpm --filter @moonshot-ai/kimi-code run build:native:sea

# 설치만 (빌드 후)
install:
    #!/usr/bin/env bash
    set -euxo pipefail
    mkdir -p "{{ kimy_bin }}"
    cp "apps/kimi-code/dist-native/bin/{{ target_platform }}/kimi" "{{ kimy_actual }}.tmp"
    chmod +x "{{ kimy_actual }}.tmp"
    mv "{{ kimy_actual }}.tmp" "{{ kimy_actual }}"
    echo "✅ kimy 설치 완료"

# 스모크 테스트
smoke:
    "{{ kimy_actual }}" --version

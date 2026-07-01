# Kimi Code local dev recipes

alias d := deploy

deploy:
    @echo 'Building kimi-code...'
    pnpm -C apps/kimi-code run build
    @echo 'Verifying...'
    node apps/kimi-code/dist/main.mjs --version
    @echo 'Done. Run with: ~/.kimy/bin/kimy'

deploy-full:
    @echo 'Building all packages...'
    pnpm -C packages/kosong run build
    pnpm -C packages/agent-core run build
    pnpm -C packages/node-sdk run build
    pnpm -C apps/kimi-code run build
    @echo 'Verifying...'
    node apps/kimi-code/dist/main.mjs --version
    @echo 'Done. Run with: ~/.kimy/bin/kimy'

smoke:
    node apps/kimi-code/dist/main.mjs --version

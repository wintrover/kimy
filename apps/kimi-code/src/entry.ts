export {};

// libuv 스레드 풀 확장: 모든 import보다 먼저 실행되어야 함
// ESM import hoisting 때문에 main.ts 내부에서는 보장 불가
if (!process.env['UV_THREADPOOL_SIZE']) {
  process.env['UV_THREADPOOL_SIZE'] = '64';
}
await import('./main');

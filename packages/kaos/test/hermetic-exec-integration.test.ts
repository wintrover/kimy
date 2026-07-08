import { describe, it, expect } from 'vitest';
import { HermeticKaos } from '../src/hermetic-kaos';
import { MerkleFileIndex } from '../src/merkle-file-index';
import { ContentAddressedPool } from '../src/object-pool';
import { LocalKaos } from '../src/local';
import { KaosSandboxError } from '../src/errors';

describe('HermeticKaos exec with allowProjection', () => {
  it('should throw KaosSandboxError when allowProjection is false (default)', async () => {
    const local = await LocalKaos.create();
    const index = MerkleFileIndex.empty(new ContentAddressedPool());
    const hermetic = new HermeticKaos(local, index);

    await expect(hermetic.exec('echo', 'hello')).rejects.toThrow(KaosSandboxError);
    await expect(hermetic.exec('echo', 'hello')).rejects.toThrow(
      'execWithEnv() blocked in HermeticKaos',
    );
  });

  it('should throw KaosSandboxError when allowProjection is explicitly false', async () => {
    const local = await LocalKaos.create();
    const index = MerkleFileIndex.empty(new ContentAddressedPool());
    const hermetic = new HermeticKaos(local, index, { allowProjection: false });

    await expect(hermetic.exec('echo', 'hello')).rejects.toThrow(KaosSandboxError);
  });
});

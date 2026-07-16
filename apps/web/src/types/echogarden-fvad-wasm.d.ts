declare module "@echogarden/fvad-wasm" {
  export interface FvadWasmModule {
    HEAPU8: Uint8Array;
    _fvad_new(): number;
    _fvad_reset(handle: number): void;
    _fvad_free(handle: number): void;
    _fvad_set_mode(handle: number, mode: number): number;
    _fvad_set_sample_rate(handle: number, sampleRate: number): number;
    _fvad_process(handle: number, samples: number, sampleCount: number): number;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
  }

  export interface FvadWasmOptions {
    locateFile?: (path: string) => string;
  }

  export default function createFvadWasm(options?: FvadWasmOptions): Promise<FvadWasmModule>;
}

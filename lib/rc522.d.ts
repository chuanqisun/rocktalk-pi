export interface Rc522Options {
  bus?: number;
  device?: number;
  speedHz?: number;
  mode?: number;
  block?: number;
  blocks?: number[];
  key?: number[] | Buffer;
  pollIntervalMs?: number;
}

export interface Rc522OperationOptions {
  block?: number;
  key?: number[] | Buffer;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface Rc522TextOperationOptions {
  blocks?: number[];
  key?: number[] | Buffer;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface Rc522BlockResult {
  uid: string;
  block: number;
  size: number;
  data: Buffer;
  text: string;
}

export interface Rc522TextResult {
  uid: string;
  blocks: number[];
  size: number;
  data: Buffer;
  text: string;
}

export default class Rc522 {
  constructor(options?: Rc522Options);

  readAsync(options?: Rc522OperationOptions): Promise<Rc522BlockResult>;

  writeAsync(data: string | Buffer | number[] | ArrayBufferView, options?: Rc522OperationOptions): Promise<Rc522BlockResult>;

  readTextAsync(options?: Rc522TextOperationOptions): Promise<Rc522TextResult>;

  writeTextAsync(text: string, options?: Rc522TextOperationOptions): Promise<Rc522TextResult>;

  close(): void;
}

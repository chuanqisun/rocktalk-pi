export interface Rc522Options {
  bus?: number;
  device?: number;
  speedHz?: number;
  blocks?: number[];
  pollIntervalMs?: number;
}

export interface Rc522TextOperationOptions {
  blocks?: number[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  writeAttempts?: number;
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
  readTextAsync(options?: Rc522TextOperationOptions): Promise<Rc522TextResult>;
  writeTextAsync(text: string, options?: Rc522TextOperationOptions): Promise<Rc522TextResult>;
  close(): void;
}

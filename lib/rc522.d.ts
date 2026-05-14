export interface Rc522Result {
  uid: string;
  blocks: number[];
  size: number;
  data: Buffer;
  text: string;
}

export interface Rc522Options {
  bus?: number;
  device?: number;
  speedHz?: number;
  mode?: number;
  block?: number;
  blocks?: number[];
  pollIntervalMs?: number;
}

export interface Rc522WriteAttemptEvent {
  status: "retry" | "success";
  page: number;
  attempt: number;
  bytes: number[];
  error: string | null;
}

export interface Rc522OperationOptions {
  blocks?: number[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onWriteAttempt?: (event: Rc522WriteAttemptEvent) => void;
}

export default class Rc522 {
  constructor(options?: Rc522Options);
  readTextAsync(options?: Rc522OperationOptions): Promise<Rc522Result>;
  writeTextAsync(text: string, options?: Rc522OperationOptions): Promise<Rc522Result>;
  close(): void;
}

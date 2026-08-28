import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_VERSION = '0.2.0';
export const TELEMETRY_CHRRXS_VERSION = '3.0.3';

export interface ModelCallTelemetry {
  timestamp: string;
  task_id: string | null;
  public_tool: string;
  public_operation: string;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  success: boolean;
}

export interface InternalCallTelemetry {
  timestamp: string;
  task_id: string | null;
  chrrxs_tool: string;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  success: boolean;
  capture_target?: string;
  cursor_reused?: boolean;
  cursor_before?: number;
  cursor_after?: number;
  partial_failure_reason?: string;
}

export function approximateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value), 'utf8');
  }
}

export class Telemetry {
  readonly logsDir: string;

  constructor(runtimeDir: string) {
    this.logsDir = path.join(runtimeDir, 'logs');
  }

  async model(entry: ModelCallTelemetry): Promise<void> {
    await this.append('model-visible.jsonl', { runtime_version: RUNTIME_VERSION, chrrxs_version: TELEMETRY_CHRRXS_VERSION, ...entry });
  }

  async internal(entry: InternalCallTelemetry): Promise<void> {
    await this.append('chrrxs-internal.jsonl', { runtime_version: RUNTIME_VERSION, chrrxs_version: TELEMETRY_CHRRXS_VERSION, ...entry });
  }

  async childStderr(text: string): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    await appendFile(path.join(this.logsDir, 'chrrxs-stderr.log'), text, 'utf8');
  }

  private async append(filename: string, entry: object): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    await appendFile(path.join(this.logsDir, filename), `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

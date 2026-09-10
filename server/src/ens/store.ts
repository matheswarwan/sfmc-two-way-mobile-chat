import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Persisted ENS registration.
 *
 * The signature key is returned exactly once, at callback creation, and there
 * is no way to read it back - only to regenerate, which invalidates the old
 * one. So it has to be stored the moment it is issued.
 */
export interface EnsRegistration {
  callbackId: string;
  callbackName: string;
  url: string;
  signatureKey: string;
  verified: boolean;
  subscriptionId?: string;
  subscriptionName?: string;
}

const FILE = resolve(process.cwd(), 'data/ens.json');

export function readRegistration(): EnsRegistration | undefined {
  if (!existsSync(FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as EnsRegistration;
  } catch {
    return undefined;
  }
}

export function writeRegistration(registration: EnsRegistration): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(registration, null, 2));
}

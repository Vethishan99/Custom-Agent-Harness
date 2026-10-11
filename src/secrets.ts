// Keeps API keys in the operating system's credential store (macOS
// Keychain, Windows Credential Manager, or the Linux Secret Service) rather
// than in the config file.

export interface SecretStore {
  // Both throw when the store can't be used (locked, missing, no D-Bus).
  get(account: string): string | undefined;
  set(account: string, secret: string): void;
}

const SERVICE = 'agent-harness';

// Returns null when this platform has no usable store binding.
export async function systemSecretStore(): Promise<SecretStore | null> {
  try {
    const {Entry} = await import('@napi-rs/keyring');
    // On Linux, insist on the Secret Service: the library would otherwise
    // fall back to the kernel keyring, which forgets keys on restart.
    const entry = (account: string) =>
      new Entry(SERVICE, account, {linux: {store: 'secret-service'}});
    return {
      get: account => entry(account).getPassword() ?? undefined,
      set: (account, secret) => entry(account).setPassword(secret),
    };
  } catch {
    // No prebuilt binary for this platform; keys stay in the config file.
    return null;
  }
}

// What the store is called, for messages to the user.
export function storeName(): string {
  if (process.platform === 'darwin') return 'macOS Keychain';
  if (process.platform === 'win32') return 'Windows Credential Manager';
  return 'system keyring';
}

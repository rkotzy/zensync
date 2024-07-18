interface Env {
  ENCRYPTION_KEY: string;
}

// Function to encrypt data and return Base64 string with IV prepended
export async function encryptData(
  data: string,
  key: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // Generate a new IV for each encryption
  const encodedData = new TextEncoder().encode(data);

  const encryptedData = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    encodedData
  );

  // Combine IV and encrypted data, then encode as base64 for storage
  const combinedIvAndData = new Uint8Array(
    iv.length + encryptedData.byteLength
  );
  combinedIvAndData.set(iv, 0);
  combinedIvAndData.set(new Uint8Array(encryptedData), iv.length);

  return btoa(String.fromCharCode(...combinedIvAndData));
}

// Function to decrypt data from Base64 string with IV prepended
export async function decryptData(
  base64DataWithIv: string,
  key: CryptoKey
): Promise<string> {
  // Convert from Base64 to binary
  const binaryStr = atob(base64DataWithIv);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Extract IV and encrypted data
  const iv = bytes.slice(0, 12);
  const encryptedData = bytes.slice(12);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    encryptedData
  );

  return new TextDecoder().decode(decryptedBuffer);
}

let encryptionKey: CryptoKey;
export async function importEncryptionKeyFromEnvironment(
  env: Env
): Promise<CryptoKey> {
  if (encryptionKey) {
    return encryptionKey;
  }

  const rawKey = atob(env.ENCRYPTION_KEY); // Decode base64 encoded key
  const keyBuffer = new Uint8Array(new ArrayBuffer(rawKey.length));

  for (let i = 0; i < rawKey.length; i++) {
    keyBuffer[i] = rawKey.charCodeAt(i);
  }

  encryptionKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    false, // Whether the key is extractable
    ['encrypt', 'decrypt']
  );
  return encryptionKey;
}

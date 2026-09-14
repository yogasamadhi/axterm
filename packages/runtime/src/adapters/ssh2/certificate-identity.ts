import ssh2, { type ParsedKey } from 'ssh2';

const { utils } = ssh2;

const CERTIFICATE_SUFFIX = '-cert-v01@openssh.com';

export function createCertificateIdentity(
  privateKey: string,
  certificate: string,
  passphrase?: string,
): ParsedKey {
  const signingKey = utils.parseKey(privateKey, passphrase);
  if (signingKey instanceof Error || !signingKey.isPrivateKey())
    throw new Error('SSH certificate requires a valid private key and passphrase');
  const parsedCertificate = parseCertificate(certificate);
  if (!parsedCertificate)
    throw new Error('SSH certificate must use the OpenSSH v01 certificate format');
  const baseType = parsedCertificate.type.slice(0, -CERTIFICATE_SUFFIX.length);
  if (baseType !== signingKey.type || !certificateMatchesKey(parsedCertificate.blob, signingKey))
    throw new Error('SSH certificate does not match the selected private key');

  // ssh2 recognizes ParsedKey values through an internal symbol. Reusing the
  // parsed private key preserves that marker while these two public properties
  // make the authentication request carry the complete OpenSSH certificate.
  Object.defineProperties(signingKey, {
    type: { configurable: true, enumerable: true, value: parsedCertificate.type },
    getPublicSSH: { configurable: true, value: () => parsedCertificate.blob },
  });
  return signingKey;
}

function parseCertificate(certificate: string): { type: string; blob: Buffer } | undefined {
  const match = /^([^\s]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+.*)?$/u.exec(certificate.trim());
  if (!match?.[1]?.endsWith(CERTIFICATE_SUFFIX) || !match[2]) return undefined;
  const blob = Buffer.from(match[2], 'base64');
  try {
    const type = readField(blob, 0);
    if (type.value.toString('utf8') !== match[1]) return undefined;
    let offset = readField(blob, type.next).next; // nonce
    const fieldCount = match[1].startsWith('ssh-rsa-') ? 2 : match[1].startsWith('ecdsa-') ? 2 : 1;
    for (let index = 0; index < fieldCount; index += 1) offset = readField(blob, offset).next;
    if (offset + 12 > blob.length) return undefined;
    offset += 8; // serial
    const certificateKind = blob.readUInt32BE(offset);
    if (certificateKind !== 1 && certificateKind !== 2) return undefined;
    offset += 4;
    offset = readField(blob, offset).next; // key id
    offset = readField(blob, offset).next; // principals
    if (offset + 16 > blob.length) return undefined;
    offset += 16; // validity interval
    for (let index = 0; index < 5; index += 1) offset = readField(blob, offset).next;
    return offset === blob.length ? { type: match[1], blob } : undefined;
  } catch {
    return undefined;
  }
}

function certificateMatchesKey(certificate: Buffer, signingKey: ParsedKey): boolean {
  try {
    const publicBlob = signingKey.getPublicSSH();
    let certificateOffset = readField(certificate, 0).next;
    certificateOffset = readField(certificate, certificateOffset).next;
    let publicOffset = readField(publicBlob, 0).next;
    const fieldCount =
      signingKey.type === 'ssh-rsa' ? 2 : signingKey.type.startsWith('ecdsa-') ? 2 : 1;
    for (let index = 0; index < fieldCount; index += 1) {
      const certificateField = readField(certificate, certificateOffset);
      const publicField = readField(publicBlob, publicOffset);
      if (!certificateField.value.equals(publicField.value)) return false;
      certificateOffset = certificateField.next;
      publicOffset = publicField.next;
    }
    return true;
  } catch {
    return false;
  }
}

function readField(buffer: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > buffer.length) throw new Error('Invalid SSH key field');
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) throw new Error('Invalid SSH key field');
  return { value: buffer.subarray(start, end), next: end };
}
